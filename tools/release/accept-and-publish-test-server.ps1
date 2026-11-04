[CmdletBinding()]
param(
    [Parameter(Position = 0, Mandatory = $true)]
    [ValidateSet('Deploy', 'Integrate', 'IntegrateBatchAdmission', 'Publish', 'IntegrateAndPublish', 'CoordinatedRelease', 'Coordinated', 'Inspect', 'Resume', 'RecoverIntegrationWorktree', 'ReconcileBatchCandidateIdentity', 'SupersedePublishedRelease')]
    [string]$Mode,
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$')][string]$OperationId,
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$')][string]$RelatedBlockedOperationId,
    [string]$FeatureWorktree,
    [string[]]$FeatureWorktrees,
    [string[]]$FeatureBranches,
    [string[]]$FeatureTipShas,
    [string]$PlayerPatchNote,
    [string[]]$PlayerPatchNotes,
    [switch]$PublishPatchNotes,
    [string[]]$ReleasePatchNotes,
    [string]$DisplayName,
    [ValidatePattern('^t\d{3,4}$')][string]$EffectiveBaseTestGeneration,
    [ValidatePattern('^[0-9a-fA-F]{40}$')][string]$EffectiveBaseTestSha,
    [ValidateSet('PreservedExactFeatureVerification', 'Command')]
    [string]$AdmissionMode = 'PreservedExactFeatureVerification',
    [string]$AdmissionCommand,
    [switch]$ConfirmIntegration,
    [switch]$ConfirmGenerationCheckpoint,
    [switch]$AtomicMasterPublication,
    [switch]$ApprovedIntegrationTest,
    [switch]$ConfirmPublish,
    [switch]$ConfirmDeploy,
    [ValidatePattern('^t\d{3,4}$')][string]$ExpectedGeneration,
    [ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedCandidateSha,
    [switch]$ConfirmWorldHandoffRecovery,
    [switch]$ConfirmCombinedRelease,
    [switch]$ConfirmBatchAdmission,
    [switch]$ConfirmConflictResolution,
    [switch]$CarefulLane,
    [switch]$ConfirmIntegrationWorktreeRecovery,
    [switch]$ConfirmPlayerPatchNoteEncodingRecovery,
    [switch]$ConfirmBatchCandidateIdentityReconciliation,
    [ValidateSet('Auto', 'Reintegrate', 'Superseded', 'Abandoned')]
    [string]$CandidateDisposition = 'Auto',
    [string]$CandidateDispositionReason,
    [switch]$ConfirmCandidateRetirement,
    [string]$StateRoot,
    [string]$SshHost,
    [string]$SshKey,
    [string]$KnownHostsFile,
    [ValidateRange(1, 300)][int]$SshConnectTimeoutSeconds = 30,
    [ValidateRange(2, 300)][int]$SshHardDeadlineSeconds = 45,
    [ValidateRange(60, 90)][int]$AmbiguousSubmissionGraceSeconds = 75,
    [ValidateRange(1, 8)][int]$DeploymentSubmissionRetryLimit = 5,
    [ValidateRange(1, 60)][int]$DeploymentPollIntervalSeconds = 2,
    [ValidateRange(60, 3600)][int]$DeploymentTimeoutSeconds = 1800,
    [ValidateRange(1, 900)][int]$HttpsStatusFallbackSeconds = 5,
    [ValidateRange(1, 900)][int]$ReceiptUnreachableGraceSeconds = 120,
    [string]$ReleaseCoordinationRoot,
    [string]$BatchValidatorAdapterPath,
    [string]$BatchValidatorReceiptPath,
    [string]$BatchAdmissionManifestPath,
    [ValidateRange(1, 86400)][int]$ReleaseLeaseTimeoutSeconds = 7200,
    [ValidateRange(1, 60)][int]$ReleaseLeasePollSeconds = 2,
    [ValidatePattern('^https://')][string]$MobileCompatibilityServerUrl = 'https://playashatlas.com',
    [string]$MobileRegistryRemote,
    [string]$SourceRepositoryRoot,
    [string]$IntegrationWorktreePath,
    [ValidatePattern('^t\d{3,4}$')][string]$CoordinatedGeneration,
    [ValidatePattern('^[0-9a-fA-F]{40}$')][string]$CoordinatedServerSha,
    [ValidatePattern('^[0-9a-fA-F]{40}$')][string]$CoordinatedAcceptedMasterSha,
    [string]$CoordinatedManifestPath,
    [string]$CoordinatedSeedPath,
    [string]$CoordinatedMobileReceiptPath,
    [string]$CoordinatedServerEvidencePath,
    [switch]$ConfirmCoordinatedRelease,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:ReleaseControllerPath = $PSCommandPath
function Stop-Workflow([string]$Message) { throw "STOP: $Message" }
if ($null -eq (Get-Variable MobileRegistryRemote -ErrorAction SilentlyContinue)) {
    $MobileRegistryRemote = ''
}
. (Join-Path $PSScriptRoot 'release-path-lib.ps1')
. (Join-Path $PSScriptRoot 'deployment-transport.ps1')
if (-not $SshHost) { $SshHost = $script:AshAtlasProductionSshHost }
. (Join-Path $PSScriptRoot 'coordinated-release.ps1')
$RepositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')).TrimEnd('\')
$ReleaseModePath = Join-Path $RepositoryRoot 'config\release-mode.json'
function Get-ConfiguredReleaseMode {
    if (-not (Test-Path -LiteralPath $ReleaseModePath -PathType Leaf)) { return 'active' }
    try {
        $config = Get-Content -Raw -LiteralPath $ReleaseModePath -Encoding utf8 | ConvertFrom-Json -ErrorAction Stop
    } catch {
        Stop-Workflow "release mode configuration is invalid: $($_.Exception.Message)"
    }
    $mobile = if ($null -ne $config.PSObject.Properties['mobile']) {
        [string]$config.mobile
    } else { '' }
    if ($mobile -notin @('active', 'paused')) {
        Stop-Workflow 'release mode configuration must set mobile to active or paused'
    }
    return $mobile
}
$script:ConfiguredReleaseMode = Get-ConfiguredReleaseMode
if ($script:ConfiguredReleaseMode -eq 'paused') {
    if (-not $Json) { Write-Host 'Store-build gates are paused (mobile registry and activation intent skipped); web, server, and signed iOS/Android OTA bundles still publish.' }
}
$SourceRepositoryRootWasSpecified = $PSBoundParameters.ContainsKey('SourceRepositoryRoot')
$DefaultPermanentCheckout = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE 'Documents\game')).TrimEnd('\')
if (-not $SourceRepositoryRoot) {
    if ($SourceRepositoryRootWasSpecified) {
        Stop-Workflow 'SourceRepositoryRoot cannot be empty when explicitly supplied'
    }
    $SourceRepositoryRoot = $DefaultPermanentCheckout
}
$SourceRepositoryRoot = [IO.Path]::GetFullPath($SourceRepositoryRoot).TrimEnd('\')
$PermanentCheckout = $SourceRepositoryRoot
if (-not $IntegrationWorktreePath) {
    $IntegrationWorktreePath = if ($SourceRepositoryRootWasSpecified) {
        Join-Path (Join-Path (Split-Path -Parent $SourceRepositoryRoot) 'worktrees') 'integration-test'
    } else {
        Join-Path $env:USERPROFILE 'Documents\worktrees\integration-test'
    }
}
$IntegrationWorktree = [IO.Path]::GetFullPath($IntegrationWorktreePath).TrimEnd('\')
if (-not (Test-Path -LiteralPath $SourceRepositoryRoot -PathType Container)) {
    Stop-Workflow "source repository checkout was not found: $SourceRepositoryRoot"
}
if (-not (Test-Path -LiteralPath $IntegrationWorktree -PathType Container)) {
    Stop-Workflow "integration worktree was not found: $IntegrationWorktree"
}
$StateRootWasSpecified = $PSBoundParameters.ContainsKey('StateRoot')
if (-not $SshKey) { $SshKey = $script:AshAtlasProductionSshKeyPath }
if (-not $KnownHostsFile) { $KnownHostsFile = Join-Path $env:USERPROFILE '.ssh\known_hosts' }
if (-not $StateRoot) {
    $StateRoot = Join-Path $env:LOCALAPPDATA ("AshAtlas\{0}\Ash Atlas Release Operations" -f (Get-Date -Format 'yyyy-MM-dd'))
}
$StateRoot = [IO.Path]::GetFullPath($StateRoot).TrimEnd('\')
if (-not $ReleaseCoordinationRoot) {
    $ReleaseCoordinationRoot = Join-Path $env:LOCALAPPDATA 'AshAtlas\Ash Atlas Release Coordination'
}
$ReleaseCoordinationRoot = [IO.Path]::GetFullPath($ReleaseCoordinationRoot).TrimEnd('\')
if ($PSBoundParameters.ContainsKey('ExpectedGeneration') -ne
    $PSBoundParameters.ContainsKey('ExpectedCandidateSha')) {
    Stop-Workflow '-ExpectedGeneration and -ExpectedCandidateSha must be supplied together'
}
if (($PSBoundParameters.ContainsKey('ExpectedGeneration') -or
        $PSBoundParameters.ContainsKey('ExpectedCandidateSha')) -and $Mode -ne 'Publish') {
    Stop-Workflow 'expected candidate binding is valid only with Publish'
}
$script:ReleaseLeaseStream = $null
$script:ReleaseLeaseTicket = ''
$script:ReleaseLeaseOwner = ''
$script:ReleaseQueueRequestedAtUtc = ''
$script:ReleaseLeaseAcquiredAtUtc = ''
$script:ReleaseQueueWaitDurationMilliseconds = 0L
$script:PublishedGenerationProof = $null

function Get-GameRepositoryRoot {
    $source = Get-Variable -Name SourceRepositoryRoot -Scope Script -ErrorAction SilentlyContinue
    if ($null -ne $source -and [string]$source.Value) { return [string]$source.Value }
    $repository = Get-Variable -Name RepositoryRoot -Scope Script -ErrorAction SilentlyContinue
    if ($null -eq $repository -or -not [string]$repository.Value) {
        Stop-Workflow 'game source repository root is not configured'
    }
    return [string]$repository.Value
}

function Get-GameIntegrationWorktree {
    $integration = Get-Variable -Name IntegrationWorktree -Scope Script -ErrorAction SilentlyContinue
    if ($null -ne $integration -and [string]$integration.Value) { return [string]$integration.Value }
    $defaultPath = Join-Path $env:USERPROFILE 'Documents\worktrees\integration-test'
    return [IO.Path]::GetFullPath($defaultPath).TrimEnd('\')
}

function Get-GitText {
    param([Parameter(Mandatory = $true)][string]$Repository, [Parameter(Mandatory = $true)][string[]]$Arguments)
    $output = @(& git -C $Repository @Arguments 2>&1)
    if ($LASTEXITCODE -ne 0) { Stop-Workflow "git $($Arguments -join ' ') failed: $($output -join [Environment]::NewLine)" }
    return ($output -join "`n").Trim()
}

function Get-GitCommitId {
    param(
        [Parameter(Mandatory = $true)][string]$Repository,
        [Parameter(Mandatory = $true)][string]$Revision
    )
    $git = Get-Command git -ErrorAction Stop
    $result = Invoke-BoundedNativeProcess -FilePath $git.Source -Arguments @(
        '-C', $Repository, 'rev-parse', '--verify', "$Revision`^{commit}"
    ) -TimeoutMilliseconds 30000
    $stderr = ([string]$result.stderr).Trim()
    if (-not [bool]$result.start_succeeded -or [bool]$result.timed_out -or
        [int]$result.exit_code -ne 0) {
        $detail = if ($stderr) { ": $stderr" } else { '' }
        Stop-Workflow "git could not resolve commit $Revision$detail"
    }
    $stdout = ([string]$result.stdout).Trim()
    if ($stdout -cnotmatch '^[0-9a-f]{40}$') {
        Stop-Workflow "git returned a non-canonical commit id for $Revision"
    }
    return $stdout
}

function Get-GitFields {
    param([Parameter(Mandatory = $true)][string]$Repository, [Parameter(Mandatory = $true)][string[]]$Arguments)
    $text = Get-GitText $Repository $Arguments
    return @($text -split '\s+' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
}

function Get-BatchChangedPathEntries {
    param(
        [Parameter(Mandatory = $true)][string]$Repository,
        [Parameter(Mandatory = $true)][string]$BaseRevision,
        [Parameter(Mandatory = $true)][string]$CandidateRevision
    )
    $raw = Get-GitText $Repository @(
        'diff', '--name-status', '--find-renames', '--find-copies', '--no-ext-diff', '-z',
        "$BaseRevision..$CandidateRevision"
    )
    if ([string]::IsNullOrEmpty($raw)) { return @() }

    # -z emits one NUL-delimited status/path field. Rename and copy records have
    # status, old path, and new path; every other record has status and one path.
    $fields = @($raw -split [char]0)
    if ($fields.Count -gt 0 -and $fields[-1] -eq '') {
        $fields = @($fields[0..($fields.Count - 2)])
    }
    $entries = @()
    for ($index = 0; $index -lt $fields.Count;) {
        $status = [string]$fields[$index]
        $index++
        if ([string]::IsNullOrWhiteSpace($status)) {
            Stop-Workflow 'git diff returned an empty changed-path status'
        }
        if ($status -match '^[RC](?:[0-9]{1,3})?$') {
            if ($index + 1 -ge $fields.Count) {
                Stop-Workflow "git diff returned malformed $status rename/copy status"
            }
            $oldPath = [string]$fields[$index]
            $newPath = [string]$fields[$index + 1]
            $index += 2
            if ([string]::IsNullOrEmpty($oldPath) -or [string]::IsNullOrEmpty($newPath)) {
                Stop-Workflow "git diff returned an empty path for $status rename/copy status"
            }
            $entries += [pscustomobject][ordered]@{
                status = $status
                status_code = $status.Substring(0, 1)
                old_path = $oldPath
                path = $newPath
                deleted = $false
            }
            continue
        }
        if ($status -notmatch '^[ACDMRTUXB]$') {
            Stop-Workflow "git diff returned malformed changed-path status '$status'"
        }
        if ($index -ge $fields.Count) {
            Stop-Workflow "git diff returned no path for changed-path status $status"
        }
        $path = [string]$fields[$index]
        $index++
        if ([string]::IsNullOrEmpty($path)) {
            Stop-Workflow "git diff returned an empty path for changed-path status $status"
        }
        $entries += [pscustomobject][ordered]@{
            status = $status
            status_code = $status
            old_path = ''
            path = $path
            deleted = $status -eq 'D'
        }
    }
    return @($entries)
}

function Get-TextSha256 {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString(
            $algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)))).Replace('-', '').ToLowerInvariant()
    } finally {
        $algorithm.Dispose()
    }
}

function Get-FileSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    $stream = $null
    try {
        $stream = [IO.File]::OpenRead($Path)
        return ([BitConverter]::ToString(
            $algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
        $algorithm.Dispose()
    }
}

function Test-ExactMergeParents {
    param(
        [Parameter(Mandatory = $true)][string[]]$Parents,
        [Parameter(Mandatory = $true)][string]$ExpectedFirstParent,
        [Parameter(Mandatory = $true)][string]$ExpectedSecondParent
    )
    return $Parents.Count -eq 2 -and
        $Parents[0] -eq $ExpectedFirstParent -and
        $Parents[1] -eq $ExpectedSecondParent
}

function ConvertTo-PlayerPatchNote {
    param([Parameter(Mandatory = $true)][string]$Note)
    if ($Note -match '[\r\n]') {
        Stop-Workflow 'player patch notes must be one line'
    }
    if ($Note -match '[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]') {
        Stop-Workflow 'player patch notes must not contain control characters'
    }
    if ($Note -match '(?i)@(?:everyone|here)\b|<@(?:!|&)?\d+>') {
        Stop-Workflow 'player patch notes must not contain Discord mention syntax'
    }
    $normalized = ($Note -replace '\s+', ' ').Trim()
    if ($normalized -notmatch '[.!?…]$') { $normalized += '.' }
    if ($normalized.Length -lt 10 -or $normalized.Length -gt 160) {
        Stop-Workflow 'player patch notes must be 10 to 160 characters after normalization'
    }
    return $normalized
}

function Assert-CommitPlayerPatchNote {
    param(
        [Parameter(Mandatory = $true)][string]$Repository,
        [Parameter(Mandatory = $true)][string]$Commit,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$ExpectedNote
    )
    $trailerText = Get-GitText $Repository @(
        'show', '-s', '--format=%(trailers:key=Ash-Atlas-Player-Note,valueonly,separator=%x00)', $Commit
    )
    $trailers = @($trailerText -split "`0" | Where-Object { $_ })
    if (-not $ExpectedNote -and $trailers.Count -eq 0) { return }
    if ($trailers.Count -ne 1 -or $trailers[0] -cne $ExpectedNote) {
        Stop-Workflow "integration commit $Commit does not contain the exact player patch-note trailer"
    }
}

function Get-CommitPlayerPatchNoteTrailer {
    param(
        [Parameter(Mandatory = $true)][string]$Repository,
        [Parameter(Mandatory = $true)][string]$Commit
    )
    $trailerText = Get-GitText $Repository @(
        'show', '-s', '--format=%(trailers:key=Ash-Atlas-Player-Note,valueonly,separator=%x00)', $Commit
    )
    $trailers = @($trailerText -split "`0" | Where-Object { $_ })
    if ($trailers.Count -ne 1) {
        Stop-Workflow "integration commit $Commit does not contain exactly one player patch-note trailer"
    }
    return [string]$trailers[0]
}

function ConvertFrom-Windows1252Utf8Mojibake {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text)
    $windows1252 = [Text.Encoding]::GetEncoding(
        1252,
        [Text.EncoderExceptionFallback]::new(),
        [Text.DecoderExceptionFallback]::new())
    $utf8 = [Text.UTF8Encoding]::new($false, $true)
    return $utf8.GetString($windows1252.GetBytes($Text))
}

function Get-PlayerPatchNoteRecoveryMatch {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$StateNote,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$ImmutableCandidateTrailer
    )
    if ([string]::Equals($StateNote, $ImmutableCandidateTrailer, [StringComparison]::Ordinal)) {
        return [pscustomobject][ordered]@{
            match_type = 'exact_ordinal'
            repair_pass_count = 0
            immutable_candidate_trailer = $ImmutableCandidateTrailer
        }
    }
    if (-not $ConfirmPlayerPatchNoteEncodingRecovery) {
        Stop-Workflow 'candidate player patch note does not contain the exact frozen operation-state note'
    }

    $repaired = $StateNote
    for ($pass = 1; $pass -le 2; $pass++) {
        try {
            $repaired = ConvertFrom-Windows1252Utf8Mojibake $repaired
        } catch {
            break
        }
        if ([string]::Equals($repaired, $ImmutableCandidateTrailer, [StringComparison]::Ordinal)) {
            return [pscustomobject][ordered]@{
                match_type = 'windows_1252_utf8_repair'
                repair_pass_count = $pass
                immutable_candidate_trailer = $ImmutableCandidateTrailer
            }
        }
    }
    Stop-Workflow 'player patch-note encoding recovery did not produce the exact immutable candidate trailer'
}

function Get-IntegrationMergeMessage {
    param(
        [Parameter(Mandatory = $true)][string]$Subject,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Note
    )
    if (-not $Note) { return $Subject }
    return "$Subject`n`nAsh-Atlas-Player-Note: $Note"
}

function Test-FeatureAdmissionStatus([AllowEmptyString()][string]$Status) {
    return [string]::IsNullOrWhiteSpace($Status) -or
        $Status.Trim() -ceq '?? __MERGED_TO_TEST__.md'
}

function Invoke-Git {
    param([Parameter(Mandatory = $true)][string]$Repository, [Parameter(Mandatory = $true)][string[]]$Arguments)
    & git -C $Repository @Arguments
    if ($LASTEXITCODE -ne 0) { Stop-Workflow "git $($Arguments -join ' ') failed with exit code $LASTEXITCODE" }
}

function Set-StateValue {
    param([Parameter(Mandatory = $true)]$Object, [Parameter(Mandatory = $true)][string]$Name, $Value)
    Add-Member -InputObject $Object -NotePropertyName $Name -NotePropertyValue $Value -Force
}

function Get-StateValue($Object, [string]$Name, $Default = '') {
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value) { return $Default }
    return $property.Value
}

function Test-MobileReleasePaused {
    param([object]$State = $null)
    $mode = if ($null -ne $State -and $null -ne $State.PSObject.Properties['release_mode']) {
        [string]$State.release_mode
    } else { [string]$script:ConfiguredReleaseMode }
    if ($mode -notin @('active', 'paused')) {
        Stop-Workflow 'release mode state is invalid'
    }
    return $mode -ceq 'paused'
}

function Invoke-MobileBackwardCompatibilityGate {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][string]$CandidateWorktree,
        [Parameter(Mandatory = $true)][string]$CandidateSha
    )
    if (Test-MobileReleasePaused $State) {
        Write-Warning 'Web-only release mode is paused: mobile_backward_compatibility_gate skipped.'
        $State.mobile_compatibility_gate_result = 'skipped_web_only_release'
        Write-State $State
        return 'mobile compatibility gate skipped for web-only release'
    }
    Invoke-Phase $State 'mobile_backward_compatibility_gate' {
        Assert-MobileBackwardCompatibility $CandidateWorktree $CandidateSha -State $State
    }
}

function Resolve-EffectiveBaseIdentity($State, [switch]$ExistingState) {
    if ([bool]$EffectiveBaseTestGeneration -ne [bool]$EffectiveBaseTestSha) {
        Stop-Workflow '-EffectiveBaseTestGeneration and -EffectiveBaseTestSha must be supplied together'
    }
    $storedGeneration = [string](Get-StateValue $State 'effective_base_test_generation' '')
    $storedSha = [string](Get-StateValue $State 'effective_base_test_sha' '')
    if ([bool]$storedGeneration -ne [bool]$storedSha) {
        Stop-Workflow 'operation state contains an incomplete effective-base identity'
    }
    foreach ($property in @('historical_name_base_generation', 'effective_base_test_generation',
            'effective_base_test_sha', 'display_name')) {
        if ($null -eq $State.PSObject.Properties[$property]) { Set-StateValue $State $property '' }
    }
    if ($ExistingState) {
        if ($EffectiveBaseTestGeneration -and
            ($EffectiveBaseTestGeneration -ne $storedGeneration -or
             $EffectiveBaseTestSha.ToLowerInvariant() -ne $storedSha)) {
            Stop-Workflow 'supplied effective-base identity differs from recorded operation state'
        }
        if ($storedGeneration) {
            $script:EffectiveBaseTestGeneration = $storedGeneration
            $script:EffectiveBaseTestSha = $storedSha
        }
    } elseif ($EffectiveBaseTestGeneration) {
        $State.effective_base_test_generation = $EffectiveBaseTestGeneration
        $State.effective_base_test_sha = $EffectiveBaseTestSha.ToLowerInvariant()
        $script:EffectiveBaseTestSha = $State.effective_base_test_sha
    }
}

function Assert-RecordedEffectiveBase($State) {
    if (-not $State.effective_base_test_generation) { return }
    $snapshot = Get-GenerationStatus
    $baseTag = @($snapshot.generation_refs | Where-Object name -eq "test/$($State.effective_base_test_generation)")
    if ($baseTag.Count -ne 1 -or [string]$baseTag[0].commit_sha -ne [string]$State.effective_base_test_sha) {
        Stop-Workflow "recorded effective-base tag no longer resolves to its exact SHA"
    }
    if ($State.feature_worktree -and $State.feature_tip) {
        Invoke-Git ([string]$State.feature_worktree) @(
            'merge-base', '--is-ancestor', [string]$State.effective_base_test_sha, [string]$State.feature_tip)
        if ($State.original_integration_sha) {
            $mergeBase = Get-GitText ([string]$State.feature_worktree) @(
                'merge-base', [string]$State.feature_tip, [string]$State.original_integration_sha)
            if ($mergeBase -ne [string]$State.effective_base_test_sha) {
                Stop-Workflow 'recorded feature merge base no longer equals recorded effective-base SHA'
            }
        }
    }
}

function Get-StatePath([string]$Id) { return Join-Path $StateRoot "$Id.json" }

function Get-ProcessStartUtc([int]$ProcessId) {
    try { return (Get-Process -Id $ProcessId -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o') }
    catch { return '' }
}

function ConvertTo-CanonicalProcessStartUtc($Value) {
    if ($null -eq $Value) { return '' }
    try {
        if ($Value -is [DateTimeOffset]) {
            return $Value.UtcDateTime.ToString('o')
        }
        if ($Value -is [DateTime]) {
            return $Value.ToUniversalTime().ToString('o')
        }
        return [DateTimeOffset]::Parse(
            [string]$Value,
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind
        ).UtcDateTime.ToString('o')
    } catch { return '' }
}

function Test-ReleaseQueueOwnerAlive($Ticket) {
    $processId = [int](Get-StateValue $Ticket 'process_id' 0)
    $expectedStart = ConvertTo-CanonicalProcessStartUtc (
        Get-StateValue $Ticket 'process_started_at_utc' $null)
    if ($processId -le 0 -or -not $expectedStart) { return $false }
    $actualStart = ConvertTo-CanonicalProcessStartUtc (Get-ProcessStartUtc $processId)
    return $actualStart -and $actualStart -eq $expectedStart
}

function Read-ReleaseCoordinationJson([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try { return Get-Content -Raw -LiteralPath $Path -Encoding utf8 | ConvertFrom-Json }
    catch { return $null }
}

function Write-ReleaseCoordinationJson([string]$Path, $Value) {
    New-Item -ItemType Directory -Path $ReleaseCoordinationRoot -Force | Out-Null
    $temporary = "$Path.$PID.tmp"
    try {
        $Value | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $temporary -Encoding utf8
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Remove-StaleReleaseQueueTickets {
    Get-ChildItem -LiteralPath $ReleaseCoordinationRoot -Filter '*.queue.json' -File -ErrorAction SilentlyContinue |
        ForEach-Object {
            $ticket = Read-ReleaseCoordinationJson $_.FullName
            if ($null -eq $ticket -or -not (Test-ReleaseQueueOwnerAlive $ticket)) {
                Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
            }
        }
}

function Get-ReleaseQueueTickets {
    return @(Get-ChildItem -LiteralPath $ReleaseCoordinationRoot -Filter '*.queue.json' -File -ErrorAction SilentlyContinue |
        ForEach-Object { Read-ReleaseCoordinationJson $_.FullName } |
        Where-Object { $null -ne $_ } |
        Sort-Object requested_at_utc, operation_id)
}

function Test-ReleaseOperationActivelyCoordinated([string]$Id) {
    if ($Id -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$') { return $false }
    $ticket = Read-ReleaseCoordinationJson (Join-Path $ReleaseCoordinationRoot "$Id.queue.json")
    return $null -ne $ticket -and (Test-ReleaseQueueOwnerAlive $ticket)
}

function Acquire-ReleaseLease([string]$Id, [string]$RequestedMode) {
    if ($RequestedMode -eq 'Inspect') { return }
    $leaseStopwatch = [Diagnostics.Stopwatch]::StartNew()
    $script:ReleaseQueueRequestedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
    New-Item -ItemType Directory -Path $ReleaseCoordinationRoot -Force | Out-Null
    $processStart = Get-ProcessStartUtc $PID
    if (-not $processStart) { Stop-Workflow 'release lease could not prove the current process identity' }
    $ticketPath = Join-Path $ReleaseCoordinationRoot "$Id.queue.json"
    $existing = Read-ReleaseCoordinationJson $ticketPath
    if ($null -ne $existing -and (Test-ReleaseQueueOwnerAlive $existing) -and
        [int]$existing.process_id -ne $PID) {
        Stop-Workflow "operation $Id already has an active release-queue owner"
    }
    $requestedAt = if ($null -ne $existing) {
        [string](Get-StateValue $existing 'requested_at_utc' '')
    } else { '' }
    if (-not $requestedAt) { $requestedAt = (Get-Date).ToUniversalTime().ToString('o') }
    $ticket = [pscustomobject][ordered]@{
        schema_version = 1
        operation_id = $Id
        requested_mode = $RequestedMode
        process_id = $PID
        process_started_at_utc = $processStart
        requested_at_utc = $requestedAt
    }
    Write-ReleaseCoordinationJson $ticketPath $ticket
    $script:ReleaseLeaseTicket = $ticketPath
    $lockPath = Join-Path $ReleaseCoordinationRoot 'release.lock'
    $ownerPath = Join-Path $ReleaseCoordinationRoot 'owner.json'
    $deadline = (Get-Date).AddSeconds($ReleaseLeaseTimeoutSeconds)
    $lastNotice = [DateTime]::MinValue
    while ((Get-Date) -lt $deadline) {
        $stream = $null
        try {
            $stream = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate,
                [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
            Remove-StaleReleaseQueueTickets
            $tickets = @(Get-ReleaseQueueTickets)
            if ($tickets.Count -eq 0 -or [string]$tickets[0].operation_id -ne $Id) {
                $stream.Dispose()
                $stream = $null
            } else {
                $owner = [pscustomobject][ordered]@{
                    schema_version = 1
                    operation_id = $Id
                    requested_mode = $RequestedMode
                    process_id = $PID
                    process_started_at_utc = $processStart
                    acquired_at_utc = (Get-Date).ToUniversalTime().ToString('o')
                }
                Write-ReleaseCoordinationJson $ownerPath $owner
                $script:ReleaseLeaseStream = $stream
                $script:ReleaseLeaseOwner = $ownerPath
                $script:ReleaseLeaseAcquiredAtUtc = [string]$owner.acquired_at_utc
                $script:ReleaseQueueWaitDurationMilliseconds = [long]$leaseStopwatch.ElapsedMilliseconds
                if (-not $Json) { Write-Host "RELEASE LEASE ACQUIRED: $Id" }
                return
            }
        } catch [IO.IOException] {
            if ($null -ne $stream) { $stream.Dispose() }
        }
        if (((Get-Date) - $lastNotice).TotalSeconds -ge 30 -or $lastNotice -eq [DateTime]::MinValue) {
            $owner = Read-ReleaseCoordinationJson $ownerPath
            $ownerId = if ($null -ne $owner) {
                [string]$owner.operation_id
            } else {
                $queued = @(Get-ReleaseQueueTickets)
                if ($queued.Count -gt 0) { [string]$queued[0].operation_id } else { 'unknown' }
            }
            if (-not $Json) { Write-Host "RELEASE QUEUED: $Id waiting behind operation $ownerId" }
            $lastNotice = Get-Date
        }
        Start-Sleep -Seconds $ReleaseLeasePollSeconds
    }
    Remove-Item -LiteralPath $ticketPath -Force -ErrorAction SilentlyContinue
    $script:ReleaseLeaseTicket = ''
    Stop-Workflow "release lease wait exceeded $ReleaseLeaseTimeoutSeconds seconds"
}

function Release-ReleaseLease([string]$Id) {
    if ($script:ReleaseLeaseOwner) {
        $owner = Read-ReleaseCoordinationJson $script:ReleaseLeaseOwner
        if ($null -ne $owner -and [string]$owner.operation_id -eq $Id -and
            [int]$owner.process_id -eq $PID) {
            Remove-Item -LiteralPath $script:ReleaseLeaseOwner -Force -ErrorAction SilentlyContinue
        }
    }
    if ($null -ne $script:ReleaseLeaseStream) {
        $script:ReleaseLeaseStream.Dispose()
        $script:ReleaseLeaseStream = $null
    }
    if ($script:ReleaseLeaseTicket) {
        $ticket = Read-ReleaseCoordinationJson $script:ReleaseLeaseTicket
        if ($null -eq $ticket -or ([string]$ticket.operation_id -eq $Id -and
            [int]$ticket.process_id -eq $PID)) {
            Remove-Item -LiteralPath $script:ReleaseLeaseTicket -Force -ErrorAction SilentlyContinue
        }
        $script:ReleaseLeaseTicket = ''
    }
}

function Set-ReleaseLeaseTiming($State) {
    if (-not $script:ReleaseLeaseAcquiredAtUtc) { return }
    $State.release_queue_requested_at_utc = $script:ReleaseQueueRequestedAtUtc
    $State.release_lease_acquired_at_utc = $script:ReleaseLeaseAcquiredAtUtc
    $State.release_queue_wait_duration_ms =
        [long]$script:ReleaseQueueWaitDurationMilliseconds
}

function Get-ReleaseOperationFiles {
    return @(if ($StateRootWasSpecified) {
        @(Get-ChildItem -LiteralPath $StateRoot -Filter '*.json' -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -notmatch '\.timings\.json$' })
    } else {
        $reportRoot = Join-Path $env:LOCALAPPDATA 'AshAtlas'
        @(Get-ChildItem -LiteralPath $reportRoot -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}$' } |
            ForEach-Object {
                Get-ChildItem -LiteralPath (Join-Path $_.FullName 'Ash Atlas Release Operations') `
                    -Filter '*.json' -File -ErrorAction SilentlyContinue |
                    Where-Object { $_.Name -notmatch '\.timings\.json$' }
            })
    })
}

function Test-ReleaseOperationPending($Record) {
    $status = [string](Get-StateValue $Record 'status' '')
    $remoteIntent = Get-StateValue $Record 'remote_side_effect_intent' $null
    $activationIntentPending = ($null -ne (Get-StateValue $Record 'activation_intent' $null) -or
        [string](Get-StateValue $Record 'activation_intent_id' '')) -and
        -not [bool](Get-StateValue $Record 'activation_intent_resolved' $false)
    return [bool](Get-StateValue $Record 'side_effect_reconciliation_required' $false) -or
        [bool](Get-StateValue $Record 'deployment_automatic_reconciliation_required' $false) -or
        ($null -ne $remoteIntent -and [string](Get-StateValue $remoteIntent 'status' '') -eq 'pending') -or
        $activationIntentPending -or
        ($status -and $status -notin @('completed', 'failed', 'abandoned'))
}

# A published release whose ACTIVATE never ran can become impossible to activate once
# master moves past it (the server activates only when master equals the target).
# Retire it as superseded only on server proof that it is still PREPARED and inactive,
# and only when current master already contains it; history is kept and audited.
function Invoke-PublishedReleaseSupersession {
    param([Parameter(Mandatory = $true)]$State)
    $target = [string](Get-StateValue $State 'deployment_target_sha' '')
    $generation = [string](Get-StateValue $State 'new_generation' '')
    if ([string]$State.status -ne 'failed') { Stop-Workflow 'only a failed release operation can be superseded' }
    if ($target -notmatch '^[0-9a-f]{40}$' -or $generation -notmatch '^t[0-9]{3,}$') {
        Stop-Workflow 'operation does not record a published generation and deployment target'
    }
    Invoke-Git (Get-GameRepositoryRoot) @('fetch', '--prune', '--tags', 'origin')
    $master = (Get-GitText (Get-GameRepositoryRoot) @('rev-parse', 'origin/master')).Trim()
    $tagged = (Get-GitText (Get-GameRepositoryRoot) @('rev-parse', "refs/tags/test/$generation^{commit}")).Trim()
    if ($tagged -ne $target) { Stop-Workflow "test/$generation does not point to the operation target" }
    if ($master -eq $target) { Stop-Workflow 'master still equals the target; resume the release instead' }
    & git -C (Get-GameRepositoryRoot) merge-base --is-ancestor $target $master
    if ($LASTEXITCODE -ne 0) { Stop-Workflow 'current master does not contain the release target' }
    $exact = Invoke-DeploymentController $State status @()
    Assert-ConsistentControllerPayload $exact
    if ([string](Get-StateValue $exact.payload 'result' '') -ne 'prepared' -or
        [string](Get-StateValue $exact.payload 'requested_target_sha' '') -ne $target -or
        [string](Get-StateValue $exact.payload 'activation_result' '') -ne 'pending' -or
        [bool](Get-StateValue $exact.payload 'activation_started' $true) -or
        [string](Get-StateValue $exact.payload 'active_game_sha' '') -eq $target -or
        [string](Get-StateValue $exact.payload 'active_public_sha' '') -eq $target) {
        Stop-Workflow 'server status does not prove the release remained prepared and inactive'
    }
    Set-RemoteReceipt $State $exact.payload
    Complete-RemoteSideEffectIntent $State 'vps_activation' $target 'failed'
    $path = Get-StatePath ([string]$State.operation_id)
    $beforeHash = Get-FileSha256 $path
    $now = (Get-Date).ToUniversalTime().ToString('o')
    $reason = ([string]$CandidateDispositionReason).Trim()
    Set-StateValue $State 'deployment_automatic_reconciliation_required' $false
    Set-StateValue $State 'abandoned_at_utc' $now
    Set-StateValue $State 'abandoned_previous_status' ([string]$State.status)
    Set-StateValue $State 'abandoned_reason' "superseded by master $master before activation: $reason"
    Set-StateValue $State 'superseded_by_sha' $master
    Set-StateValue $State 'status' 'abandoned'
    Write-State $State
    New-Item -ItemType Directory -Path $ReleaseCoordinationRoot -Force | Out-Null
    $audit = [pscustomobject][ordered]@{
        event = 'release_operation_superseded'
        operation_id = [string]$State.operation_id
        generation = $generation
        target_sha = $target
        superseded_by_sha = $master
        active_game_sha = [string](Get-StateValue $exact.payload 'active_game_sha' '')
        reason = $reason
        record_sha256_before = $beforeHash
        superseded_at_utc = $now
        actor = "$env:USERDOMAIN\$env:USERNAME"
    } | ConvertTo-Json -Compress
    Add-Content -LiteralPath (Join-Path $ReleaseCoordinationRoot 'release-audit.jsonl') -Value $audit -Encoding utf8
    return [pscustomobject]@{ generation = $generation; target_sha = $target; superseded_by_sha = $master }
}

function Close-AbandonedReleaseOperation($Record, [string]$Path) {
    # Never delete history: mark the record closed and append an audit entry.
    $now = (Get-Date).ToUniversalTime().ToString('o')
    $previousStatus = [string](Get-StateValue $Record 'status' '')
    $beforeHash = Get-FileSha256 $Path
    Set-StateValue $Record 'abandoned_at_utc' $now
    Set-StateValue $Record 'abandoned_previous_status' $previousStatus
    Set-StateValue $Record 'abandoned_reason' 'unfinished for more than 24 hours; auto-abandoned so it cannot block new releases'
    if ($previousStatus -notin @('completed', 'failed')) { Set-StateValue $Record 'status' 'abandoned' }
    $temporary = "$Path.$PID.abandon.tmp"
    try {
        $Record | ConvertTo-Json -Depth 14 | Set-Content -LiteralPath $temporary -Encoding utf8
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
    New-Item -ItemType Directory -Path $ReleaseCoordinationRoot -Force | Out-Null
    $audit = [pscustomobject][ordered]@{
        event = 'release_operation_auto_abandoned'
        operation_id = [string](Get-StateValue $Record 'operation_id' '')
        path = $Path
        previous_status = $previousStatus
        last_updated_at_utc = [string](Get-StateValue $Record 'updated_at_utc' '')
        record_sha256_before = $beforeHash
        abandoned_at_utc = $now
        actor = "$env:USERDOMAIN\$env:USERNAME"
    } | ConvertTo-Json -Compress
    Add-Content -LiteralPath (Join-Path $ReleaseCoordinationRoot 'release-audit.jsonl') -Value $audit -Encoding utf8
}

function Get-UnfinishedReleaseOperations {
    # Unfinished work blocks only for 24 hours; older records are auto-abandoned with an audit entry.
    $cutoff = (Get-Date).ToUniversalTime().AddHours(-24)
    $operations = @(Get-ReleaseOperationFiles | ForEach-Object {
        $file = $_
        try { $record = Get-Content -Raw -LiteralPath $file.FullName -Encoding utf8 | ConvertFrom-Json } catch { return }
        if ($null -eq $record -or -not [string](Get-StateValue $record 'operation_id' '') -or
            -not [string](Get-StateValue $record 'status' '') -or
            [string](Get-StateValue $record 'abandoned_at_utc' '') -or
            -not (Test-ReleaseOperationPending $record)) { return }
        # Age counts from creation: later touches (inspection, cleanup) must not keep old work blocking.
        $started = $null
        $startedText = [string](Get-StateValue $record 'created_at_utc' (Get-StateValue $record 'updated_at_utc' ''))
        try { $started = [DateTimeOffset]::Parse($startedText).UtcDateTime } catch { }
        $resuming = [string](Get-Variable OperationId -ValueOnly -ErrorAction SilentlyContinue) -ceq
            [string]$record.operation_id
        if (-not $resuming -and ($null -eq $started -or $started -lt $cutoff)) {
            Close-AbandonedReleaseOperation $record $file.FullName
            return
        }
        $record
    })
    return @($operations | Sort-Object updated_at_utc)
}

function Read-BatchAdmissionManifest {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ExpectedOperationId,
        [switch]$RequireProtectedTuple
    )
    $resolved = [IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
        Stop-Workflow "batch admission manifest was not found: $resolved"
    }
    $raw = [IO.File]::ReadAllText($resolved, [Text.UTF8Encoding]::new($false))
    if ($raw.Length -gt 0 -and [int]$raw[0] -eq 0xfeff) {
        Stop-Workflow 'batch admission manifest contains a UTF-8 BOM'
    }
    try { $manifest = $raw | ConvertFrom-Json -ErrorAction Stop }
    catch { Stop-Workflow 'batch admission manifest is not valid UTF-8 JSON' }
    if ([int](Get-StateValue $manifest 'schema_version' 0) -ne 1 -or
        [string](Get-StateValue $manifest 'kind' '') -cne 'ash-atlas-batch-admission-manifest' -or
        [string](Get-StateValue $manifest 'operation_id' '') -cne $ExpectedOperationId -or
        [string](Get-StateValue $manifest 'source_repository_root' '') -cne (Get-GameRepositoryRoot) -or
        [string](Get-StateValue $manifest 'integration_worktree_path' '') -cne (Get-GameIntegrationWorktree)) {
        Stop-Workflow 'batch admission manifest is not bound to this operation and source checkout'
    }
    $originalSourceSha = [string](Get-StateValue $manifest 'original_source_sha' '')
    $originalMasterSha = [string](Get-StateValue $manifest 'original_master_sha' '')
    $reservedGeneration = [string](Get-StateValue $manifest 'reserved_generation' '')
    $protectedTupleValid = $originalSourceSha -cmatch '^[0-9a-f]{40}$' -and
        $originalMasterSha -cmatch '^[0-9a-f]{40}$' -and
        $reservedGeneration -match '^t\d{3,4}$'
    if ($RequireProtectedTuple -and -not $protectedTupleValid) {
        Stop-Workflow 'batch admission manifest is missing its immutable protected source/master/generation tuple'
    }
    if (($originalSourceSha -or $originalMasterSha -or $reservedGeneration) -and
        -not $protectedTupleValid) {
        Stop-Workflow 'batch admission manifest contains a malformed protected source/master/generation tuple'
    }
    $features = @($manifest.features)
    if ($features.Count -lt 2) {
        Stop-Workflow 'batch admission manifest requires at least two ordered features'
    }
    foreach ($feature in $features) {
        $branch = [string](Get-StateValue $feature 'branch' '')
        $sha = [string](Get-StateValue $feature 'sha' '')
        $worktree = [string](Get-StateValue $feature 'worktree' '')
        $note = [string](Get-StateValue $feature 'player_patch_note' '')
        if ($branch -notmatch '^(?:feature|fix|chore|audit)/[A-Za-z0-9][A-Za-z0-9._/-]{1,127}$' -or
            $branch.Contains('..') -or $branch.Contains('//') -or
            $sha -notmatch '^[0-9a-f]{40}$' -or -not $worktree -or
            ($note -and $note.Length -lt 10) -or $note.Length -gt 160 -or
            $note -match '[\r\n\p{Cc}\p{Cf}\p{Zl}\p{Zp}]') {
            Stop-Workflow 'batch admission manifest contains an unsafe feature identity'
        }
    }
    $expectedRequestSha = Get-TextSha256 (ConvertTo-CoordinatedCanonicalJson @($features | ForEach-Object {
                [pscustomobject][ordered]@{
                    branch = [string]$_.branch
                    sha = [string]$_.sha
                    player_patch_note = [string]$_.player_patch_note
                }
            }))
    if ([string](Get-StateValue $manifest 'request_sha256' '') -cne $expectedRequestSha) {
        Stop-Workflow 'batch admission manifest request hash does not match its ordered features'
    }
    return $manifest
}

function Assert-BatchAdmissionProtectedSnapshot {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)]$Snapshot,
        [Parameter(Mandatory = $true)]$State,
        [switch]$AdmissionOnly
    )
    $manifestSourceSha = [string](Get-StateValue $Manifest 'original_source_sha' '')
    $manifestMasterSha = [string](Get-StateValue $Manifest 'original_master_sha' '')
    $reservedGeneration = [string](Get-StateValue $Manifest 'reserved_generation' '')
    if ($manifestSourceSha -cnotmatch '^[0-9a-f]{40}$' -or
        $manifestMasterSha -cnotmatch '^[0-9a-f]{40}$' -or
        $reservedGeneration -notmatch '^t\d{3,4}$') {
        Stop-Workflow 'batch admission manifest protected tuple is not canonical'
    }

    $stateOriginalSourceSha = [string](Get-StateValue $State 'original_integration_sha' '')
    $stateOriginalMasterSha = [string](Get-StateValue $State 'original_master_sha' '')
    if ($stateOriginalSourceSha -and
        ($stateOriginalSourceSha -cnotmatch '^[0-9a-f]{40}$' -or
         $stateOriginalSourceSha -cne $manifestSourceSha)) {
        Stop-Workflow 'batch admission state original integration SHA differs from its reserved manifest tuple'
    }
    if ($stateOriginalMasterSha -and
        ($stateOriginalMasterSha -cnotmatch '^[0-9a-f]{40}$' -or
         $stateOriginalMasterSha -cne $manifestMasterSha)) {
        Stop-Workflow 'batch admission state original master SHA differs from its reserved manifest tuple'
    }
    foreach ($property in @(
            'batch_admission_original_source_sha',
            'batch_admission_original_master_sha')) {
        $stateTupleSha = [string](Get-StateValue $State $property '')
        $manifestTupleSha = if ($property -like '*source*') {
            $manifestSourceSha
        } else { $manifestMasterSha }
        if ($stateTupleSha -and
            ($stateTupleSha -cnotmatch '^[0-9a-f]{40}$' -or
             $stateTupleSha -cne $manifestTupleSha)) {
            Stop-Workflow "batch admission state $property differs from its reserved manifest tuple"
        }
    }
    $stateReservedGeneration = [string](Get-StateValue $State 'batch_admission_reserved_generation' '')
    if ($stateReservedGeneration -and $stateReservedGeneration -cne $reservedGeneration) {
        Stop-Workflow 'batch admission state reserved generation differs from its manifest tuple'
    }
    $stateOriginalGeneration = [string](Get-StateValue $State 'original_integration_generation' '')
    $statePreviousGeneration = [string](Get-StateValue $State 'previous_generation' '')
    if ($stateOriginalGeneration -and $statePreviousGeneration -and
        $stateOriginalGeneration -cne $statePreviousGeneration) {
        Stop-Workflow 'batch admission state has conflicting original generation identities'
    }
    $stateBaselineGeneration = if ($stateOriginalGeneration) {
        $stateOriginalGeneration
    } else { $statePreviousGeneration }
    if ($stateBaselineGeneration) {
        if ($stateBaselineGeneration -notmatch '^t\d{3,4}$' -or
            [int]$reservedGeneration.Substring(1) -ne ([int]$stateBaselineGeneration.Substring(1) + 1)) {
            Stop-Workflow 'batch admission state original generation differs from its reserved manifest tuple'
        }
    }
    $snapshotSourceSha = [string](Get-StateValue $Snapshot 'integration_test_sha' '')
    $snapshotMasterSha = [string](Get-StateValue $Snapshot 'master_sha' '')
    $snapshotGeneration = [string](Get-StateValue $Snapshot 'latest_generation' '')
    if ($snapshotSourceSha -cnotmatch '^[0-9a-f]{40}$' -or
        $snapshotMasterSha -cnotmatch '^[0-9a-f]{40}$' -or
        $snapshotGeneration -notmatch '^t\d{3,4}$') {
        Stop-Workflow 'batch admission protected snapshot is not canonical'
    }

    $snapshotGenerationNumber = [int]$snapshotGeneration.Substring(1)
    $reservedGenerationNumber = [int]$reservedGeneration.Substring(1)
    $generationRefs = @((Get-StateValue $Snapshot 'generation_refs' @()))
    if ($generationRefs.Count -eq 0) {
        $generationRefs = @((Get-StateValue $Snapshot 'generations' @()))
    }
    $stateAccepted = $AdmissionOnly -and
        [bool](Get-StateValue $State 'batch_admission_accepted' $false)
    $accepted = $stateAccepted -and
        [string](Get-StateValue $State 'accepted_generation' '') -ceq $reservedGeneration
    if ($stateAccepted -and -not $accepted) {
        Stop-Workflow 'batch admission accepted state does not match its immutable reserved generation'
    }
    $acceptedGenerationReference = @($generationRefs | Where-Object {
        [string]$_.name -ceq "test/$reservedGeneration" -and
        [string]$_.commit_sha -ceq [string](Get-StateValue $State 'accepted_integration_sha' '')
    }).Count -eq 1
    if ($accepted -and -not $acceptedGenerationReference) {
        Stop-Workflow 'batch admission accepted generation no longer has its immutable tag reference'
    }
    $reconcilingPublishedCandidate = $false
    if ($AdmissionOnly -and -not $stateAccepted) {
        $phases = Get-StateValue $State 'phases' $null
        $mergePhase = if ($null -ne $phases) {
            $phases.PSObject.Properties['batch_local_merge_chain']
        } else { $null }
        $candidateSha = [string](Get-StateValue $State 'final_candidate_sha' '')
        $previousGeneration = [string](Get-StateValue $State 'previous_generation' '')
        $previousGenerationNumber = if ($previousGeneration -match '^t\d{3,4}$') {
            [int]$previousGeneration.Substring(1)
        } else { -1 }
        $reconcilingPublishedCandidate =
            $candidateSha -cmatch '^[0-9a-f]{40}$' -and
            $null -ne $mergePhase -and
            [string]$mergePhase.Value.status -ceq 'completed' -and
            $previousGenerationNumber -ge 0 -and
            $reservedGenerationNumber -eq $previousGenerationNumber + 1 -and
            $snapshotSourceSha -ceq $candidateSha -and
            $snapshotMasterSha -ceq $manifestMasterSha -and
            $snapshotGeneration -ceq $reservedGeneration -and
            @($generationRefs | Where-Object {
                [string]$_.name -ceq "test/$reservedGeneration" -and
                [string]$_.commit_sha -ceq $candidateSha
            }).Count -eq 1
    }
    if ($accepted -or $reconcilingPublishedCandidate) {
        $acceptedSha = if ($accepted) {
            [string](Get-StateValue $State 'accepted_integration_sha' '')
        } else {
            [string](Get-StateValue $State 'final_candidate_sha' '')
        }
        if ($acceptedSha -cnotmatch '^[0-9a-f]{40}$' -or
            $snapshotSourceSha -cne $acceptedSha -or
            $snapshotMasterSha -cne $manifestMasterSha -or
            $snapshotGeneration -cne $reservedGeneration) {
            Stop-Workflow 'batch admission accepted generation no longer matches its immutable protected tuple'
        }
        return
    }
    if ($reservedGenerationNumber -ne $snapshotGenerationNumber + 1 -or
        $snapshotSourceSha -cne $manifestSourceSha -or
        $snapshotMasterSha -cne $manifestMasterSha) {
        Stop-Workflow 'batch admission reservation no longer matches the protected snapshot before candidate work'
    }
}

function Assert-ExpectedPublishResumeCandidate {
    param(
        [Parameter(Mandatory = $true)]$Existing,
        [Parameter(Mandatory = $true)][string]$ExpectedGeneration,
        [Parameter(Mandatory = $true)][string]$ExpectedCandidateSha
    )
    $operationId = [string](Get-StateValue $Existing 'operation_id' '')
    $existingGeneration = [string](Get-StateValue $Existing 'new_generation' '')
    $existingCandidateSha = [string](Get-StateValue $Existing 'candidate_integration_sha' '')
    if ($existingGeneration -cne $ExpectedGeneration -or
        $existingCandidateSha -cne $ExpectedCandidateSha) {
        $frozenCandidate = if ($existingGeneration -and $existingCandidateSha) {
            "test/$existingGeneration@$existingCandidateSha"
        } else { 'an unset or incomplete candidate' }
        $message = "unfinished Publish operation {0} is frozen to {1}, not test/{2}@{3}; " +
            'inspect it and explicitly resume or complete it before starting another candidate'
        Stop-Workflow ($message -f $operationId, $frozenCandidate, $ExpectedGeneration, $ExpectedCandidateSha)
    }
}

function Resolve-AutomaticReleaseResume {
    if ($Mode -in @('Inspect', 'Resume') -or $OperationId) { return }
    $unfinished = @(Get-UnfinishedReleaseOperations)
    if ($unfinished.Count -eq 0) { return }
    if ($unfinished.Count -gt 1) {
        Stop-Workflow "multiple unfinished release operations require inspection: $(@($unfinished.operation_id) -join ', ')"
    }
    $existing = $unfinished[0]
    $requestedMode = [string]$Mode
    $existingMode = [string](Get-StateValue $existing 'requested_mode' '')
    $sameRequestedMode = $existingMode -ceq $requestedMode
    $sameSingleFeature = $FeatureWorktree -and [string]$existing.feature_worktree -and
        (Test-AshAtlasSamePath ([string]$FeatureWorktree) ([string]$existing.feature_worktree))
    $requestedBatch = @($FeatureWorktrees | Where-Object { $_ })
    $existingBatch = @($existing.feature_worktrees | Where-Object { $_ })
    $sameBatch = $requestedBatch.Count -gt 0 -and $requestedBatch.Count -eq $existingBatch.Count
    if ($sameBatch) {
        for ($index = 0; $index -lt $requestedBatch.Count; $index++) {
            if (-not (Test-AshAtlasSamePath ([string]$requestedBatch[$index]) ([string]$existingBatch[$index]))) {
                $sameBatch = $false
                break
            }
        }
    }
    $sameBatchPacket = $true
    if ($requestedMode -eq 'IntegrateBatchAdmission') {
        $requestedBranches = @($FeatureBranches | Where-Object { $_ } | ForEach-Object { [string]$_ })
        $requestedTips = @($FeatureTipShas | Where-Object { $_ } | ForEach-Object {
                ([string]$_).ToLowerInvariant()
            })
        $existingBranches = @((Get-StateValue $existing 'feature_branches' @()) |
            ForEach-Object { [string]$_ })
        $existingTips = @((Get-StateValue $existing 'feature_tip_shas' @()) |
            ForEach-Object { ([string]$_).ToLowerInvariant() })
        $sameBatchPacket = $requestedBranches.Count -eq $existingBranches.Count -and
            $requestedTips.Count -eq $existingTips.Count
        if ($sameBatchPacket) {
            for ($index = 0; $index -lt $requestedBranches.Count; $index++) {
                if ($requestedBranches[$index] -cne $existingBranches[$index] -or
                    $requestedTips[$index] -cne $existingTips[$index]) {
                    $sameBatchPacket = $false
                    break
                }
            }
        }
    }
    if (-not $sameRequestedMode) {
        $sameSingleFeature = $false
        $sameBatch = $false
        $samePublish = $false
    }
    if (-not $sameBatchPacket) { $sameBatch = $false }
    $samePublish = $Mode -eq 'Publish' -and [string]$existing.requested_mode -eq 'Publish'
    if ($samePublish -and $ExpectedGeneration) {
        Assert-ExpectedPublishResumeCandidate $existing $ExpectedGeneration $ExpectedCandidateSha
    }
    if (-not $sameSingleFeature -and -not $sameBatch -and -not $samePublish) {
        if (Test-ReleaseOperationActivelyCoordinated ([string]$existing.operation_id)) { return }
        Stop-Workflow "existing unfinished release operation detected: $($existing.operation_id). Inspect or resume it before starting another release"
    }
    if ([string](Get-StateValue $existing 'release_patch_notes_hex' 'none') -cne
        $(if ($PublishPatchNotes) {
            [BitConverter]::ToString([Text.Encoding]::UTF8.GetBytes(
                (ConvertTo-Json -InputObject @($ReleasePatchNotes) -Compress))).Replace('-', '').ToLowerInvariant()
        } else { 'none' })) {
        Stop-Workflow 'supplied release patch-note consent or wording differs from the unfinished operation state'
    }
    if ($sameSingleFeature -and [string](Get-StateValue $existing 'player_patch_note' '') -ne
        [string]$PlayerPatchNote) {
        Stop-Workflow 'supplied player patch note differs from the unfinished operation state'
    }
    if ($sameBatch) {
        $existingNotes = @((Get-StateValue $existing 'player_patch_notes' @()))
        if ($existingNotes.Count -ne $PlayerPatchNotes.Count) {
            Stop-Workflow 'supplied player patch notes differ from the unfinished operation state'
        }
        for ($index = 0; $index -lt $existingNotes.Count; $index++) {
            if ([string]$existingNotes[$index] -cne [string]$PlayerPatchNotes[$index]) {
                Stop-Workflow 'supplied player patch notes differ from the unfinished operation state'
            }
        }
    }
    $script:OperationId = [string]$existing.operation_id
    $script:Mode = 'Resume'
    if (-not $Json) {
        Write-Host "Existing unfinished release operation detected. Resuming $OperationId from its first incomplete phase."
    }
}

function Assert-NoUnfinishedReleaseConflict([string]$Id) {
    $other = @(Get-UnfinishedReleaseOperations | Where-Object {
            [string]$_.operation_id -ne $Id
        })
    if ($other.Count -ne 0) {
        Stop-Workflow ("unfinished release operation must be reconciled before this queued release: {0}" -f
            (@($other.operation_id) -join ', '))
    }
}

function New-DeploymentStatusToken {
    $bytes = New-Object byte[] 32
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($bytes) }
    finally { $generator.Dispose() }
    return ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
}

function Get-RedactedWorkflowState {
    param([Parameter(Mandatory = $true)]$State)
    $copy = $State | ConvertTo-Json -Depth 14 | ConvertFrom-Json
    if ($null -ne $copy.PSObject.Properties['deployment_status_token']) {
        $copy.deployment_status_token = '[redacted]'
    }
    return $copy
}

function Get-WorkflowInspection {
    param([Parameter(Mandatory = $true)]$State)
    # Read the recorded evidence without upgrading or reconciling the operation.
    $timingPath = Join-Path $StateRoot "$($State.operation_id).timings.json"
    $inspectionErrors = @()
    $timing = $null
    if (Test-Path -LiteralPath $timingPath -PathType Leaf) {
        try { $timing = Get-Content -Raw -LiteralPath $timingPath -Encoding utf8 | ConvertFrom-Json }
        catch { $inspectionErrors += "recorded timing unavailable: $($_.Exception.Message)" }
    }
    $manifest = Get-StateValue $State 'coordinated_manifest' $null
    $manifestPath = [string](Get-StateValue $State 'coordinated_manifest_path' '')
    if ($null -eq $manifest -and $manifestPath -and
        (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        try { $manifest = Read-CoordinatedReleaseManifest $manifestPath }
        catch { $inspectionErrors += "coordinated manifest unavailable: $($_.Exception.Message)" }
    }
    $gate = $null
    if ($null -ne $manifest) {
        try { $gate = Get-CoordinatedReleaseGate $manifest }
        catch { $inspectionErrors += "coordinated gate unavailable: $($_.Exception.Message)" }
    }
    return [pscustomobject][ordered]@{
        state = (Get-RedactedWorkflowState $State)
        inspection_source = 'recorded evidence; remote truth and timings are historical; current_git is read-only fresh evidence'
        current_git = (Get-GenerationStatus)
        timing = $timing
        remote_truth = (Get-StateValue $State 'reconciled_remote_truth' $null)
        coordinated_manifest = $manifest
        coordinated_gate = $gate
        inspection_errors = @($inspectionErrors)
        journal = @(Get-StateValue $State 'coordinated_journal' @())
    }
}

function Write-State {
    param([Parameter(Mandatory = $true)]$State)
    New-Item -ItemType Directory -Path $StateRoot -Force | Out-Null
    $path = Get-StatePath ([string]$State.operation_id)
    $temporary = "$path.$PID.tmp"
    try {
        $State.updated_at_utc = (Get-Date).ToUniversalTime().ToString('o')
        $State | ConvertTo-Json -Depth 14 | Set-Content -LiteralPath $temporary -Encoding utf8
        Move-Item -LiteralPath $temporary -Destination $path -Force
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Read-State([string]$Id) {
    if (-not $Id) { Stop-Workflow '-OperationId is required for Inspect, Resume, and RecoverIntegrationWorktree.' }
    $path = Get-StatePath $Id
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        $reportRoot = Join-Path $env:LOCALAPPDATA 'AshAtlas'
        $matches = @(Get-ChildItem -LiteralPath $reportRoot -Directory -ErrorAction SilentlyContinue |
            ForEach-Object { Join-Path $_.FullName "Ash Atlas Release Operations\$Id.json" } |
            Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
        if ($matches.Count -ne 1) { Stop-Workflow "operation state was not found uniquely for $Id" }
        $path = $matches[0]
        $script:StateRoot = Split-Path -Parent $path
    }
    try { return Get-Content -Raw -LiteralPath $path -Encoding utf8 | ConvertFrom-Json }
    catch { Stop-Workflow "operation state is unreadable: $($_.Exception.Message)" }
}

function New-WorkflowState {
    if (-not $OperationId) {
        $script:OperationId = "{0}-{1}" -f (Get-Date -Format 'yyyyMMddTHHmmss'), ([guid]::NewGuid().ToString('n').Substring(0, 8))
    }
    $coordinatedManifestInput = if ($null -ne (Get-Variable CoordinatedManifestPath -ErrorAction SilentlyContinue)) {
        [string]$CoordinatedManifestPath
    } else { '' }
    $coordinatedSeedInput = if ($null -ne (Get-Variable CoordinatedSeedPath -ErrorAction SilentlyContinue)) {
        [string]$CoordinatedSeedPath
    } else { '' }
    $coordinatedReceiptInput = if ($null -ne (Get-Variable CoordinatedMobileReceiptPath -ErrorAction SilentlyContinue)) {
        [string]$CoordinatedMobileReceiptPath
    } else { '' }
    $coordinatedEvidenceInput = if ($null -ne (Get-Variable CoordinatedServerEvidencePath -ErrorAction SilentlyContinue)) {
        [string]$CoordinatedServerEvidencePath
    } else { '' }
    $coordinatedGenerationInput = if ($null -ne (Get-Variable CoordinatedGeneration -ErrorAction SilentlyContinue)) {
        [string]$CoordinatedGeneration
    } else { '' }
    $coordinatedServerInput = if ($null -ne (Get-Variable CoordinatedServerSha -ErrorAction SilentlyContinue)) {
        [string]$CoordinatedServerSha
    } else { '' }
    $coordinatedMasterInput = if ($null -ne (Get-Variable CoordinatedAcceptedMasterSha -ErrorAction SilentlyContinue)) {
        [string]$CoordinatedAcceptedMasterSha
    } else { '' }
    $featureBranchesInput = if ($null -ne (Get-Variable FeatureBranches -ErrorAction SilentlyContinue)) {
        @($FeatureBranches | Where-Object { $_ })
    } else { @() }
    $featureTipsInput = if ($null -ne (Get-Variable FeatureTipShas -ErrorAction SilentlyContinue)) {
        @($FeatureTipShas | Where-Object { $_ })
    } else { @() }
    $batchAdmissionConfirmationInput = if ($null -ne (Get-Variable ConfirmBatchAdmission -ErrorAction SilentlyContinue)) {
        [bool]$ConfirmBatchAdmission
    } else { $false }
    return [pscustomobject][ordered]@{
        schema_version = 9
        operation_id = $OperationId
        requested_mode = $Mode
        release_mode = $script:ConfiguredReleaseMode
        tooling_repository_root = $RepositoryRoot
        source_repository_root = Get-GameRepositoryRoot
        integration_worktree_path = Get-GameIntegrationWorktree
        status = 'created'
        created_at_utc = (Get-Date).ToUniversalTime().ToString('o')
        updated_at_utc = (Get-Date).ToUniversalTime().ToString('o')
        feature_worktree = $FeatureWorktree
        feature_worktrees = @($FeatureWorktrees | Where-Object { $_ })
        feature_branches = $featureBranchesInput
        feature_tip_shas = $featureTipsInput
        player_patch_note = $PlayerPatchNote
        player_patch_notes = @($PlayerPatchNotes)
        release_patch_notes_hex = if ($PublishPatchNotes) {
            [BitConverter]::ToString([Text.Encoding]::UTF8.GetBytes(
                (ConvertTo-Json -InputObject @($ReleasePatchNotes) -Compress))).Replace('-', '').ToLowerInvariant()
        } else { 'none' }
        is_batch = [bool]($null -ne $FeatureWorktrees -and $FeatureWorktrees.Count -gt 0)
        batch_release_authorized = [bool](
            $ConfirmIntegration -and $ConfirmGenerationCheckpoint -and $AtomicMasterPublication -and
            $ApprovedIntegrationTest -and $ConfirmPublish -and $ConfirmDeploy
        )
        batch_admission_authorized = [bool](
            $batchAdmissionConfirmationInput -and $ConfirmIntegration -and
            $ConfirmGenerationCheckpoint -and $ApprovedIntegrationTest
        )
        batch_admission_accepted = $false
        batch_admission_isolation_status = 'ACTION_REQUIRED_PROVISION_ISOLATED_VALIDATOR'
        accepted_integration_sha = ''
        accepted_generation = ''
        accepted_original_integration_sha = ''
        accepted_original_integration_generation = ''
        accepted_at_utc = ''
        batch_manifest = @()
        original_master_sha = ''
        latest_gameplay_generation = ''
        latest_gameplay_generation_sha = ''
        initial_remote_fetch_count = 0
        initial_remote_snapshot_count = 0
        staging_worktree = ''
        staging_branch = ''
        merge_chain = @()
        merge_conflict = $null
        final_candidate_sha = ''
        final_validation_plan = $null
        validation_plan_fingerprint = ''
        validation_toolchain_fingerprint = ''
        validation_receipts = @()
        batch_validator_adapter_path = if ($null -ne (Get-Variable BatchValidatorAdapterPath -ErrorAction SilentlyContinue)) {
            [string](Get-Variable BatchValidatorAdapterPath -ValueOnly)
        } else { '' }
        batch_admission_manifest_path = if ($null -ne (Get-Variable BatchAdmissionManifestPath -ErrorAction SilentlyContinue)) {
            [string](Get-Variable BatchAdmissionManifestPath -ValueOnly)
        } else { '' }
        batch_validator_receipt_path = if ($null -ne (Get-Variable BatchValidatorReceiptPath -ErrorAction SilentlyContinue)) {
            [string](Get-Variable BatchValidatorReceiptPath -ValueOnly)
        } else { '' }
        batch_validator_receipt_sha256 = ''
        batch_validator_validator_id = ''
        batch_validator_validator_image_digest = ''
        batch_validator_gate_hashes = @()
        baseline_validation_receipts = @()
        baseline_workspace_install_receipt = $null
        validations_reused = 0
        validations_executed = 0
        active_validation_gate = ''
        atomic_publication_duration_ms = 0
        deployment_submission_duration_ms = 0
        deployment_operation_id = $OperationId
        deployment_target_sha = ''
        remaining_known_issues = @(
            'Automated production verification has no safe non-retained authenticated test identity; authenticated gameplay is covered in the combined disposable browser gate, while production browser verification remains anonymous and read-only.'
        )
        display_name = $DisplayName
        feature_branch = ''
        feature_tip = ''
        historical_name_base_generation = ''
        effective_base_test_generation = ''
        effective_base_test_sha = ''
        original_integration_sha = ''
        original_integration_generation = ''
        candidate_integration_sha = ''
        previous_generation = ''
        new_generation = ''
        expected_remote_tag_namespace_snapshot = ''
        atomic_master_publication = [bool]$AtomicMasterPublication
        admission_mode = $AdmissionMode
        admission_command = [string]$AdmissionCommand
        admission_result = ''
        admission_candidate_sha = ''
        admission_before_sha = ''
        admission_after_sha = ''
        admission_working_directory = ''
        admission_receipt = $null
        candidate_admission_required = $false
        candidate_admission_reason = ''
        mobile_compatibility_server_url = $MobileCompatibilityServerUrl
        mobile_compatibility_registry_remote = if ($null -ne
            (Get-Variable MobileRegistryRemote -ErrorAction SilentlyContinue)) {
            [string](Get-Variable MobileRegistryRemote -ValueOnly)
        } else { '' }
        mobile_compatibility_registry_source = ''
        mobile_compatibility_registry_sha256 = ''
        mobile_compatibility_server_sha256 = ''
        mobile_compatibility_registry_commit_sha = ''
        mobile_compatibility_protocol_min = 0
        mobile_compatibility_protocol_max = 0
        mobile_compatibility_fingerprint = ''
        mobile_compatibility_settings = @()
        mobile_compatibility_checked_at_utc = ''
        mobile_compatibility_gate_result = ''
        coordinated_manifest_path = $coordinatedManifestInput
        coordinated_seed_path = $coordinatedSeedInput
        coordinated_journal_path = ''
        coordinated_mobile_receipt_path = $coordinatedReceiptInput
        coordinated_server_evidence_path = $coordinatedEvidenceInput
        coordinated_server_evidence = $null
        coordinated_server_evidence_sha256 = ''
        coordinated_server_evidence_nonce = ''
        coordinated_phase = ''
        coordinated_status = ''
        coordinated_wait_reason = ''
        coordinated_manifest = $null
        coordinated_journal = @()
        coordinated_pinned_generation = $coordinatedGenerationInput
        coordinated_pinned_server_sha = $coordinatedServerInput
        coordinated_accepted_master_sha = $coordinatedMasterInput
        coordinated_pinned_worktree_sha = ''
        side_effect_reconciliation_required = $false
        side_effect_reconciliation_reason = ''
        side_effect_reconciliation_started_at_utc = ''
        side_effect_reconciliation_completed_at_utc = ''
        remote_side_effect_intent = $null
        remote_side_effect_intent_reconciled_at_utc = ''
        remote_side_effect_intent_terminal_result = ''
        remote_publication_succeeded = $false
        local_checkout_reconciliation_result = ''
        local_checkout_reconciliation_target_sha = ''
        atomic_push_result = ''
        merged_receipt_result = ''
        master_publication_result = ''
        exact_deployed_sha = ''
        exact_public_release_sha = ''
        deployment_verification_result = ''
        deployment_phase_timings = $null
        remote_deployment_receipt = $null
        deployment_lane = ''
        deployment_ssh_connection_count = 0
        deployment_start_connection_count = 0
        deployment_prepare_connection_count = 0
        deployment_activate_connection_count = 0
        deployment_status_connection_count = 0
        deployment_result_connection_count = 0
        deployment_identity_connection_count = 0
        deployment_integrity_connection_count = 0
        deployment_integrity_handoff_connection_count = 0
        world_handoff_recovery_authorized = [bool]$ConfirmWorldHandoffRecovery
        world_handoff_recovery_evidence = $null
        deployment_status_token = ''
        release_protocol = ''
        release_candidate_ref = ''
        prepared_receipt_sha256 = ''
        prepared_remote_receipt_sha256 = ''
        prepared_env_sha256 = ''
        prepared_native_compatibility_json = ''
        prepared_native_compatibility_sha256 = ''
        activation_intent_id = ''
        activation_registry_commit_sha = ''
        activation_intent_resolved = $false
        activation_registry_resolved_at_utc = ''
        activation_intent_terminal_result = ''
        activation_intent = $null
        prepared_descriptor_version = 0
        prepared_descriptor_sha256 = ''
        release_classification_version = 0
        release_class = ''
        release_classification_evidence_sha256 = ''
        release_changed_paths_sha256 = ''
        prepared_server_component_sha = ''
        prepared_server_artifact_sha256 = ''
        prepared_client_component_sha = ''
        prepared_client_artifact_sha256 = ''
        prepared_static_artifact_fence_sha256 = ''
        prepared_release_metadata_fence_sha256 = ''
        prepared_game_main_pid = 0
        prepared_game_start_timestamp_monotonic = 0
        prepared_live_game_link_sha = ''
        prepared_live_public_link_sha = ''
        prepared_live_public_release_sha = ''
        deployment_start_attempted = $false
        deployment_submission_state = 'pending_submission'
        deployment_request_ref = 'refs/heads/integration/deployment-requests'
        deployment_request_parent = ''
        deployment_request_commit = ''
        deployment_request_manifest_sha256 = ''
        deployment_transport = ''
        deployment_transport_events = @()
        deployment_submission_attempt_count = 0
        deployment_submission_retry_count = 0
        deployment_submission_target_sha = ''
        deployment_submission_updater_hash = ''
        deployment_submission_first_attempt_at_utc = ''
        deployment_admission_discovered_at_utc = ''
        deployment_admission_source = ''
        deployment_completion_discovered_at_utc = ''
        deployment_admission_duration_ms = 0
        deployment_https_admission_duration_ms = 0
        deployment_operation_completion_duration_ms = 0
        release_queue_requested_at_utc = ''
        release_lease_acquired_at_utc = ''
        release_queue_wait_duration_ms = 0
        deployment_last_outcome = ''
        deployment_https_status_read_count = 0
        deployment_https_status_last_read_ms = 0
        deployment_https_status_longest_read_ms = 0
        deployment_ssh_fallback_count = 0
        deployment_ssh_fallback_attempted_at_utc = ''
        deployment_status_read_failures = 0
        deployment_receipt_outage_started_at_utc = ''
        deployment_receipt_outage_next_delay_seconds = [math]::Min(10, $DeploymentPollIntervalSeconds)
        deployment_longest_receipt_outage_ms = 0
        deployment_total_receipt_outage_ms = 0
        deployment_poll_wait_duration_ms = 0
        deployment_transition_events = @()
        deployment_completion_observation_lag_ms = 0
        deployment_automatic_reconciliation_required = $false
        remote_acceptance_duration_ms = 0
        failure_phase = ''
        completed_at_utc = ''
        reconciled_remote_truth = $null
        phases = [pscustomobject]@{}
    }
}

function Initialize-DeploymentState {
    param([Parameter(Mandatory = $true)]$State)
    Set-StateValue $State 'schema_version' 9
    if ($null -eq $State.PSObject.Properties['release_mode'] -or
        [string]::IsNullOrWhiteSpace([string]$State.release_mode)) {
        Set-StateValue $State 'release_mode' $script:ConfiguredReleaseMode
    }
    foreach ($identity in @(
            @('source_repository_root', (Get-GameRepositoryRoot)),
            @('integration_worktree_path', (Get-GameIntegrationWorktree)),
            @('tooling_repository_root', $RepositoryRoot))) {
        $stored = [string](Get-StateValue $State $identity[0] '')
        if ($stored -and -not (Test-AshAtlasSamePath $stored ([string]$identity[1]))) {
            Stop-Workflow "durable operation $($identity[0]) differs from the configured release checkout"
        }
    }
    $hadStartAttempted = $null -ne $State.PSObject.Properties['deployment_start_attempted']
    $defaults = [ordered]@{
        tooling_repository_root = $RepositoryRoot
        source_repository_root = Get-GameRepositoryRoot
        integration_worktree_path = Get-GameIntegrationWorktree
        remote_deployment_receipt = $null
        deployment_lane = ''
        deployment_ssh_connection_count = 0
        deployment_start_connection_count = 0
        deployment_prepare_connection_count = 0
        deployment_activate_connection_count = 0
        deployment_status_connection_count = 0
        deployment_result_connection_count = 0
        deployment_identity_connection_count = 0
        deployment_integrity_connection_count = 0
        deployment_integrity_handoff_connection_count = 0
        world_handoff_recovery_authorized = $false
        world_handoff_recovery_evidence = $null
        deployment_status_token = ''
        release_protocol = ''
        release_candidate_ref = ''
        prepared_receipt_sha256 = ''
        prepared_remote_receipt_sha256 = ''
        prepared_env_sha256 = ''
        prepared_native_compatibility_json = ''
        prepared_native_compatibility_sha256 = ''
        activation_intent_id = ''
        activation_registry_commit_sha = ''
        activation_intent_resolved = $false
        activation_registry_resolved_at_utc = ''
        activation_intent_terminal_result = ''
        activation_intent = $null
        prepared_descriptor_version = 0
        prepared_descriptor_sha256 = ''
        release_classification_version = 0
        release_class = ''
        release_classification_evidence_sha256 = ''
        release_changed_paths_sha256 = ''
        prepared_server_component_sha = ''
        prepared_server_artifact_sha256 = ''
        prepared_client_component_sha = ''
        prepared_client_artifact_sha256 = ''
        prepared_static_artifact_fence_sha256 = ''
        prepared_release_metadata_fence_sha256 = ''
        prepared_game_main_pid = 0
        prepared_game_start_timestamp_monotonic = 0
        prepared_live_game_link_sha = ''
        prepared_live_public_link_sha = ''
        prepared_live_public_release_sha = ''
        deployment_start_attempted = $false
        deployment_submission_state = 'pending_submission'
        deployment_request_ref = 'refs/heads/integration/deployment-requests'
        deployment_request_parent = ''
        deployment_request_commit = ''
        deployment_request_manifest_sha256 = ''
        deployment_transport = ''
        deployment_transport_events = @()
        deployment_submission_attempt_count = 0
        deployment_submission_retry_count = 0
        deployment_submission_target_sha = ''
        deployment_submission_updater_hash = ''
        deployment_submission_first_attempt_at_utc = ''
        deployment_admission_discovered_at_utc = ''
        deployment_admission_source = ''
        deployment_completion_discovered_at_utc = ''
        deployment_admission_duration_ms = 0
        deployment_https_admission_duration_ms = 0
        deployment_operation_completion_duration_ms = 0
        release_queue_requested_at_utc = ''
        release_lease_acquired_at_utc = ''
        release_queue_wait_duration_ms = 0
        deployment_last_outcome = ''
        deployment_https_status_read_count = 0
        deployment_https_status_last_read_ms = 0
        deployment_https_status_longest_read_ms = 0
        deployment_ssh_fallback_count = 0
        deployment_ssh_fallback_attempted_at_utc = ''
        deployment_status_read_failures = 0
        deployment_receipt_outage_started_at_utc = ''
        deployment_receipt_outage_next_delay_seconds = [math]::Min(10, $DeploymentPollIntervalSeconds)
        deployment_longest_receipt_outage_ms = 0
        deployment_total_receipt_outage_ms = 0
        deployment_poll_wait_duration_ms = 0
        deployment_transition_events = @()
        deployment_completion_observation_lag_ms = 0
        deployment_automatic_reconciliation_required = $false
        remote_acceptance_duration_ms = 0
        completed_at_utc = ''
        atomic_master_publication = $false
        feature_worktrees = @()
        player_patch_note = ''
        player_patch_notes = @()
        is_batch = $false
        batch_release_authorized = $false
        batch_manifest = @()
        original_master_sha = ''
        latest_gameplay_generation = ''
        latest_gameplay_generation_sha = ''
        initial_remote_fetch_count = 0
        initial_remote_snapshot_count = 0
        baseline_validation_receipts = @()
        baseline_workspace_install_receipt = $null
        staging_worktree = ''
        staging_branch = ''
        merge_chain = @()
        merge_conflict = $null
        final_candidate_sha = ''
        final_validation_plan = $null
        validation_plan_fingerprint = ''
        validation_toolchain_fingerprint = ''
        validation_receipts = @()
        batch_validator_adapter_path = ''
        batch_admission_manifest_path = ''
        batch_validator_receipt_path = ''
        batch_validator_receipt_sha256 = ''
        batch_validator_validator_id = ''
        batch_validator_validator_image_digest = ''
        batch_validator_gate_hashes = @()
        validations_reused = 0
        validations_executed = 0
        active_validation_gate = ''
        atomic_publication_duration_ms = 0
        deployment_submission_duration_ms = 0
        deployment_operation_id = [string]$State.operation_id
        deployment_target_sha = ''
        admission_mode = 'PreservedExactFeatureVerification'
        admission_command = ''
        admission_result = ''
        admission_candidate_sha = ''
        admission_before_sha = ''
        admission_after_sha = ''
        admission_working_directory = ''
        admission_receipt = $null
        candidate_admission_required = $false
        candidate_admission_reason = ''
        mobile_compatibility_server_url = 'https://playashatlas.com'
        mobile_compatibility_registry_remote = ''
        mobile_compatibility_registry_source = ''
        mobile_compatibility_registry_sha256 = ''
        mobile_compatibility_server_sha256 = ''
        mobile_compatibility_registry_commit_sha = ''
        mobile_compatibility_protocol_min = 0
        mobile_compatibility_protocol_max = 0
        mobile_compatibility_fingerprint = ''
        mobile_compatibility_settings = @()
        mobile_compatibility_checked_at_utc = ''
        mobile_compatibility_gate_result = ''
        coordinated_manifest_path = ''
        coordinated_seed_path = ''
        coordinated_journal_path = ''
        coordinated_mobile_receipt_path = ''
        coordinated_server_evidence_path = ''
        coordinated_server_evidence = $null
        coordinated_server_evidence_sha256 = ''
        coordinated_server_evidence_nonce = ''
        coordinated_phase = ''
        coordinated_status = ''
        coordinated_wait_reason = ''
        coordinated_manifest = $null
        coordinated_journal = @()
        coordinated_pinned_generation = ''
        coordinated_pinned_server_sha = ''
        coordinated_accepted_master_sha = ''
        coordinated_pinned_worktree_sha = ''
        side_effect_reconciliation_required = $false
        side_effect_reconciliation_reason = ''
        side_effect_reconciliation_started_at_utc = ''
        side_effect_reconciliation_completed_at_utc = ''
        remote_side_effect_intent = $null
        remote_side_effect_intent_reconciled_at_utc = ''
        remote_side_effect_intent_terminal_result = ''
        remote_publication_succeeded = $false
        local_checkout_reconciliation_result = ''
        local_checkout_reconciliation_target_sha = ''
        exact_public_release_sha = ''
        remaining_known_issues = @(
            'Automated production verification has no safe non-retained authenticated test identity; authenticated gameplay is covered in the combined disposable browser gate, while production browser verification remains anonymous and read-only.'
        )
    }
    foreach ($entry in $defaults.GetEnumerator()) {
        if ($null -eq $State.PSObject.Properties[$entry.Key]) {
            Set-StateValue $State $entry.Key $entry.Value
        }
    }
    if (-not $hadStartAttempted -and
        ([int]$State.deployment_start_connection_count -gt 0 -or
         $null -ne $State.remote_deployment_receipt)) {
        $State.deployment_start_attempted = $true
    }
}

function Add-DeploymentTransportEvent {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][string]$Action,
        [Parameter(Mandatory = $true)][string]$Outcome,
        [long]$StartupDurationMilliseconds = 0,
        [long]$DurationMilliseconds = 0,
        [bool]$WatchdogTerminated = $false
    )
    $event = [pscustomobject][ordered]@{
        recorded_at_utc = (Get-Date).ToUniversalTime().ToString('o')
        action = $Action
        outcome = $Outcome
        startup_duration_ms = $StartupDurationMilliseconds
        duration_ms = $DurationMilliseconds
        watchdog_terminated = $WatchdogTerminated
    }
    $State.deployment_transport_events = @($State.deployment_transport_events) + $event
    $State.deployment_last_outcome = $Outcome
    Write-State $State
}

function Get-DeploymentTransport {
    if ($null -eq (Get-Variable DeploymentTransport -Scope Script -ErrorAction SilentlyContinue) -or
        $null -eq $script:DeploymentTransport) {
        $script:DeploymentTransport = Resolve-WslOpenSshTransport `
            -SshHost $SshHost -SshKey $SshKey -KnownHostsFile $KnownHostsFile
    }
    return $script:DeploymentTransport
}

function Invoke-DeploymentController {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][ValidateSet('start', 'prepare', 'activate', 'status', 'result', 'identity', 'integrity', 'integrity-handoff')][string]$Action,
        [AllowEmptyCollection()][string[]]$Arguments = @(),
        [AllowNull()][string]$StandardInput = $null
    )
    if ([string]$State.operation_id -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$') {
        Stop-Workflow 'operation ID is unsafe for the remote deployment controller'
    }
    foreach ($argument in $Arguments) {
        if ($argument -notmatch '^[A-Za-z0-9][A-Za-z0-9._/-]*$' -or $argument.Contains('..')) {
            Stop-Workflow 'remote controller argument is unsafe'
        }
    }
    $State.deployment_ssh_connection_count = [int]$State.deployment_ssh_connection_count + 1
    $counter = "deployment_{0}_connection_count" -f $Action.Replace('-', '_')
    $State.$counter = [int]$State.$counter + 1
    Write-State $State
    $remoteArguments = @($Action, [string]$State.operation_id) + $Arguments
    $remoteCommand = "sudo /home/debian/ops/ash-atlas-server/deploy-control.sh {0}" -f ($remoteArguments -join ' ')
    try {
        $transport = Get-DeploymentTransport
    } catch {
        Add-DeploymentTransportEvent $State $Action 'local-preflight-failure'
        Stop-Workflow "WSL deployment transport preflight failed: $($_.Exception.Message)"
    }
    $State.deployment_transport = [string]$transport.name
    Write-State $State
    $native = Invoke-WslOpenSshCommand -Transport $transport -Program ssh -Arguments @(
        [string]$transport.endpoint, $remoteCommand
    ) -ConnectTimeoutSeconds $SshConnectTimeoutSeconds `
        -HardDeadlineSeconds $SshHardDeadlineSeconds -StandardInput $StandardInput
    $text = [string]$native.output
    if ($native.watchdog_terminated) {
        $text = (@($text, "SSH $Action exceeded its $SshHardDeadlineSeconds second wall-clock bound") |
            Where-Object { $_ }) -join "`n"
    }
    $payload = $null
    $invalidJson = $false
    if ($text) {
        $jsonLine = @($text -split "`r?`n" | Where-Object { $_.TrimStart().StartsWith('{') } | Select-Object -Last 1)
        if ($jsonLine.Count -eq 1) {
            try { $payload = $jsonLine[0] | ConvertFrom-Json }
            catch { $invalidJson = $true }
        }
    }
    $outcome = [string]$native.failure_class
    if ($null -ne $payload) {
        $outcome = if ($Action -eq 'status' -and
            [string](Get-StateValue $payload 'result' '') -eq 'absent' -and
            [string](Get-StateValue $payload 'operation_state' '') -eq 'genuinely_unknown') {
            'reconciliation-found-not-accepted'
        } elseif ([int]$native.exit_code -eq 0) {
            'controller-accepted'
        } else {
            'controller-rejected'
        }
    } elseif ($outcome -eq 'transport-succeeded' -or $invalidJson) {
        $outcome = 'transport-unavailable'
    }
    Add-DeploymentTransportEvent $State $Action $outcome `
        $native.startup_duration_ms $native.duration_ms $native.watchdog_terminated
    return [pscustomobject]@{
        action = $Action
        exit_code = [int]$native.exit_code
        timed_out = [bool]$native.watchdog_terminated
        watchdog_terminated = [bool]$native.watchdog_terminated
        process_tree_terminated = [bool]$native.process_tree_terminated
        failure_class = $outcome
        acceptance_ambiguous = [bool]$native.acceptance_ambiguous -or
            ($null -eq $payload -and $outcome -eq 'transport-unavailable')
        startup_duration_ms = [long]$native.startup_duration_ms
        duration_ms = [long]$native.duration_ms
        payload = $payload
        output = $text
    }
}

function Set-RemoteReceipt {
    param([Parameter(Mandatory = $true)]$State, [Parameter(Mandatory = $true)]$Receipt)
    $previousReceipt = Get-StateValue $State 'remote_deployment_receipt' $null
    $previousPhase = if ($null -ne $previousReceipt) {
        [string](Get-StateValue $previousReceipt 'current_phase' '')
    } else { '' }
    $nextPhase = [string](Get-StateValue $Receipt 'current_phase' '')
    if ($nextPhase -and $nextPhase -ne $previousPhase) {
        $observedAt = [DateTimeOffset](Get-Date)
        $events = @(Get-StateValue $State 'deployment_transition_events' @())
        $elapsedPreviousStateMs = 0L
        if ($events.Count -gt 0) {
            try {
                $priorObservedAt = [DateTimeOffset]::Parse([string]$events[-1].timestamp_utc)
                $elapsedPreviousStateMs = [Math]::Max(
                    0L, [long]($observedAt - $priorObservedAt).TotalMilliseconds)
            } catch { $elapsedPreviousStateMs = 0L }
        }
        $remoteTransitionAt = ''
        $remoteTransitions = @(Get-StateValue $Receipt 'state_transitions' @())
        if ($remoteTransitions.Count -gt 0) {
            $matchingTransition = @($remoteTransitions | Where-Object {
                    [string]$_.next_state -eq $nextPhase
                } | Select-Object -Last 1)
            if ($matchingTransition.Count -gt 0) {
                $remoteTransitionAt = [string]$matchingTransition[0].timestamp_utc
            }
        }
        if (-not $remoteTransitionAt) {
            $remoteTransitionAt = [string](Get-StateValue $Receipt 'updated_at_utc' '')
        }
        $observationLagMs = 0L
        if ($remoteTransitionAt) {
            try {
                $producerAt = [DateTimeOffset]::Parse($remoteTransitionAt)
                $observationLagMs = [Math]::Max(0L, [long]($observedAt - $producerAt).TotalMilliseconds)
            } catch { $observationLagMs = 0L }
        }
        $events += [pscustomobject][ordered]@{
            timestamp_utc = $observedAt.ToUniversalTime().ToString('o')
            operation_id = [string]$State.operation_id
            previous_state = if ($previousPhase) { $previousPhase } else { 'unobserved' }
            next_state = $nextPhase
            elapsed_previous_state_ms = $elapsedPreviousStateMs
            reason = 'authoritative_receipt_observed'
            process_pid = $PID
            scope = 'local_observer'
            remote_transition_timestamp_utc = $remoteTransitionAt
            observation_lag_ms = $observationLagMs
        }
        Set-StateValue $State 'deployment_transition_events' @($events | Select-Object -Last 256)
        if ([string](Get-StateValue $Receipt 'result' '') -eq 'completed') {
            Set-StateValue $State 'deployment_completion_observation_lag_ms' $observationLagMs
        }
    }
    $State.remote_deployment_receipt = $Receipt
    $lane = [string](Get-StateValue $Receipt 'deployment_lane' '')
    if ($lane) { $State.deployment_lane = $lane }
    foreach ($field in @('prepared_descriptor_version', 'prepared_descriptor_sha256',
            'prepared_remote_receipt_sha256', 'prepared_env_sha256',
            'prepared_native_compatibility_json', 'prepared_native_compatibility_sha256',
            'activation_intent_id', 'activation_registry_commit_sha',
            'release_classification_version', 'release_class',
            'release_classification_evidence_sha256', 'release_changed_paths_sha256',
            'prepared_server_component_sha', 'prepared_server_artifact_sha256',
            'prepared_client_component_sha', 'prepared_client_artifact_sha256',
            'prepared_static_artifact_fence_sha256', 'prepared_release_metadata_fence_sha256',
            'prepared_game_main_pid', 'prepared_game_start_timestamp_monotonic',
            'prepared_live_game_link_sha', 'prepared_live_public_link_sha',
            'prepared_live_public_release_sha')) {
        $value = Get-StateValue $Receipt $field $null
        if ($null -ne $value -and [string]$value) { Set-StateValue $State $field $value }
    }
    $timings = Get-StateValue $Receipt 'deployment_timings' $null
    if ($null -ne $timings) { $State.deployment_phase_timings = $timings }
    $intent = Get-StateValue $State 'remote_side_effect_intent' $null
    if ($null -ne $intent -and
        [string](Get-StateValue $intent 'kind' '') -eq 'vps_activation' -and
        [string](Get-StateValue $intent 'status' '') -eq 'pending') {
        $intentTarget = [string](Get-StateValue $intent 'target_sha' '')
        $receiptTarget = [string](Get-StateValue $Receipt 'requested_target_sha' '')
        if (-not $receiptTarget) {
            $receiptTarget = [string](Get-StateValue $Receipt 'target_sha' '')
        }
        $receiptResult = [string](Get-StateValue $Receipt 'result' '')
        $rollbackResult = [string](Get-StateValue $Receipt 'rollback_result' 'not_required')
        $terminal = $receiptResult -eq 'completed' -or
            ($receiptResult -eq 'failed' -and $rollbackResult -in @('completed', 'not_required'))
        $failedActivationCanRetry = $receiptResult -eq 'failed' -and
            [string](Get-StateValue $State 'release_protocol' '') -eq 'prepare_activate_v1' -and
            (Test-ReceiptNoMutation $Receipt) -and
            -not [bool](Get-StateValue $State 'activation_intent_resolved' $false)
        $activationLedgerRequired = -not (Test-MobileReleasePaused $State) -and (
            [string](Get-StateValue $State 'release_protocol' '') -eq 'prepare_activate_v1' -or
            [string](Get-StateValue $State 'activation_intent_id' '') -or
            $null -ne (Get-StateValue $State 'activation_intent' $null))
        if ($terminal -and $intentTarget -and $receiptTarget -eq $intentTarget -and
            (-not $activationLedgerRequired -or
                [bool](Get-StateValue $State 'activation_intent_resolved' $false) -or
                $failedActivationCanRetry)) {
            Set-StateValue $State 'remote_side_effect_intent' $null
            Set-StateValue $State 'remote_side_effect_intent_reconciled_at_utc' `
                ((Get-Date).ToUniversalTime().ToString('o'))
            Set-StateValue $State 'remote_side_effect_intent_terminal_result' $receiptResult
            Set-StateValue $State 'deployment_automatic_reconciliation_required' $false
        }
    }
    Write-State $State
}

function Assert-ConsistentControllerPayload {
    param([Parameter(Mandatory = $true)]$Response)
    if ($null -eq $Response.payload) {
        if ([int]$Response.exit_code -eq 255) {
            Stop-Workflow "deployment controller SSH failed; only status may be retried: $($Response.output)"
        }
        Stop-Workflow "deployment controller returned no receipt: $($Response.output)"
    }
    if ([string](Get-StateValue $Response.payload 'controller_state' '') -ne 'consistent') {
        Stop-Workflow 'remote deployment receipt, active marker, and systemd unit disagree'
    }
}

function Invoke-HttpsDeploymentStatus {
    param([Parameter(Mandatory = $true)]$State)
    $token = [string](Get-StateValue $State 'deployment_status_token' '')
    if ($token -notmatch '^[0-9a-f]{64}$') {
        Stop-Workflow 'operation state has no valid HTTPS deployment-status token'
    }
    $State.deployment_https_status_read_count = [int]$State.deployment_https_status_read_count + 1
    Write-State $State

    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    Add-Type -AssemblyName System.Net.Http
    $handler = [Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $false
    $client = [Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromMilliseconds(1800)
    $response = $null
    try {
        $nonce = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $uri = [Uri]("https://playashatlas.com/deployment-status/$token.json?poll=$nonce")
        $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get, $uri)
        $request.Headers.TryAddWithoutValidation('Cache-Control', 'no-cache') | Out-Null
        try { $response = $client.SendAsync($request).GetAwaiter().GetResult() }
        finally { $request.Dispose() }
        $statusCode = [int]$response.StatusCode
        if ($statusCode -ne 200) {
            return [pscustomobject]@{
                available = $false
                conflict = $false
                code = "http_$statusCode"
                payload = $null
            }
        }
        $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        try { $payload = $body | ConvertFrom-Json }
        catch {
            return [pscustomobject]@{
                available = $true
                conflict = $true
                code = 'invalid_json'
                payload = $null
            }
        }
        return [pscustomobject]@{
            available = $true
            conflict = $false
            code = 'ok'
            payload = $payload
        }
    } catch {
        $code = if ($_.Exception -is [Threading.Tasks.TaskCanceledException]) {
            'timeout'
        } else {
            'transport'
        }
        return [pscustomobject]@{
            available = $false
            conflict = $false
            code = $code
            payload = $null
        }
    } finally {
        if ($null -ne $response) { $response.Dispose() }
        $client.Dispose()
        $handler.Dispose()
        $stopwatch.Stop()
        $durationMilliseconds = [long]$stopwatch.ElapsedMilliseconds
        $State.deployment_https_status_last_read_ms = $durationMilliseconds
        $State.deployment_https_status_longest_read_ms = [long][math]::Max(
            [long]$State.deployment_https_status_longest_read_ms, $durationMilliseconds)
        Write-State $State
    }
}

function Assert-DeploymentStatusPayload {
    param(
        [Parameter(Mandatory = $true)]$Payload,
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][string]$Target
    )
    $fields = @(
        'schema_version', 'operation_id', 'target_sha', 'result', 'current_phase',
        'active_game_sha', 'active_public_sha', 'migration_result', 'activation_result',
        'readiness_result', 'failure_phase', 'failure_code', 'updated_at_utc'
    )
    $optionalFields = @(
        'deployment_timings', 'state_transitions', 'mutation_evidence_complete',
        'migration_started', 'migration_completed', 'migration_outcome_uncertain',
        'activation_started', 'activation_completed', 'rollback_result'
    )
    $actual = @($Payload.PSObject.Properties.Name)
    if (@($fields | Where-Object { $_ -notin $actual }).Count -ne 0 -or
        @($actual | Where-Object { $_ -notin @($fields + $optionalFields) }).Count -ne 0) {
        Stop-Workflow 'HTTPS deployment status has an unsafe field set'
    }
    if ([int]$Payload.schema_version -ne 1 -or
        [string]$Payload.operation_id -ne [string]$State.operation_id -or
        [string]$Payload.target_sha -ne $Target) {
        Stop-Workflow 'HTTPS deployment status identity conflicts with the submitted operation'
    }
    if ([string]$Payload.result -notin @('accepted', 'running', 'prepared', 'completed', 'failed') -or
        [string]$Payload.current_phase -notmatch '^[a-z0-9][a-z0-9._-]{0,63}$') {
        Stop-Workflow 'HTTPS deployment status has an unsafe result or phase'
    }
    foreach ($field in @('active_game_sha', 'active_public_sha')) {
        $value = [string](Get-StateValue $Payload $field '')
        if ($value -and $value -notmatch '^[0-9a-f]{40}$') {
            Stop-Workflow "HTTPS deployment status has an unsafe $field"
        }
    }
    if ([string]$Payload.migration_result -notin @('pending', 'running', 'not_required', 'completed', 'failed') -or
        [string]$Payload.activation_result -notin @('pending', 'running', 'completed', 'failed') -or
        [string]$Payload.readiness_result -notin @('pending', 'running', 'completed', 'failed')) {
        Stop-Workflow 'HTTPS deployment status has an unsafe phase result'
    }
    $failurePhase = [string](Get-StateValue $Payload 'failure_phase' '')
    $failureCode = [string](Get-StateValue $Payload 'failure_code' '')
    if (($failurePhase -and $failurePhase -notmatch '^[a-z0-9][a-z0-9._-]{0,63}$') -or
        ($failureCode -and $failureCode -notmatch '^[a-z0-9][a-z0-9._-]{0,95}$')) {
        Stop-Workflow 'HTTPS deployment status has unsafe failure evidence'
    }
    try {
        [DateTimeOffset]::Parse(
            [string]$Payload.updated_at_utc,
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind) | Out-Null
    } catch {
        Stop-Workflow 'HTTPS deployment status has an invalid update timestamp'
    }
    $remoteTransitions = @(Get-StateValue $Payload 'state_transitions' @())
    if ($remoteTransitions.Count -gt 256) {
        Stop-Workflow 'HTTPS deployment status has too many transition records'
    }
    foreach ($transition in $remoteTransitions) {
        if ([string]$transition.operation_id -ne [string]$State.operation_id -or
            [string]$transition.previous_state -notmatch '^[a-z0-9][a-z0-9._-]{0,63}$' -or
            [string]$transition.next_state -notmatch '^[a-z0-9][a-z0-9._-]{0,63}$' -or
            [string]$transition.reason -notin @('controller_receipt_update', 'updater_phase_started') -or
            [string]$transition.scope -notin @('remote_controller', 'remote_updater') -or
            [long]$transition.elapsed_previous_state_ms -lt 0 -or
            [long]$transition.process_pid -lt 1) {
            Stop-Workflow 'HTTPS deployment status has an unsafe transition record'
        }
        try {
            [DateTimeOffset]::Parse(
                [string]$transition.timestamp_utc,
                [Globalization.CultureInfo]::InvariantCulture,
                [Globalization.DateTimeStyles]::RoundtripKind) | Out-Null
        } catch {
            Stop-Workflow 'HTTPS deployment status has an invalid transition timestamp'
        }
    }
    $timings = Get-StateValue $Payload 'deployment_timings' $null
    if ($null -ne $timings) {
        $timingFields = @($timings.PSObject.Properties.Name)
        $allowedTimingFields = @('schema_version', 'operation_id', 'game_sha', 'status',
            'deployment_lane', 'migration_required', 'phases', 'runs', 'started_at_utc',
            'active_duration_ms', 'total_duration_ms', 'finished_at_utc')
        if (@($timingFields | Where-Object { $_ -notin $allowedTimingFields }).Count -ne 0 -or
            [int]$timings.schema_version -notin @(1, 2) -or
            [string]$timings.game_sha -ne $Target -or
            ([int]$timings.schema_version -eq 2 -and
             [string](Get-StateValue $timings 'operation_id' '') -ne [string]$State.operation_id) -or
            [long]$timings.total_duration_ms -lt 0 -or
            @($timings.phases).Count -gt 128) {
            Stop-Workflow 'HTTPS deployment timings have unsafe identity or bounds'
        }
        foreach ($timing in @($timings.phases)) {
            if ([string]$timing.phase -notmatch '^[a-z][a-z0-9_]{0,63}$' -or
                ([string](Get-StateValue $timing 'action' '') -and
                 [string]$timing.action -notin @('deploy', 'prepare', 'activate')) -or
                [long]$timing.duration_ms -lt 0 -or [long]$timing.duration_ms -gt 3600000) {
                Stop-Workflow 'HTTPS deployment timing phase is unsafe'
            }
        }
    }
    if ([string]$Payload.result -eq 'completed') {
        $expectedGameSha = if ([string](Get-StateValue $State 'release_class' '') -eq 'client_only') {
            [string](Get-StateValue $State 'prepared_server_component_sha' '')
        } else { $Target }
        if ($expectedGameSha -notmatch '^[0-9a-f]{40}$' -or
            [string]$Payload.active_game_sha -ne $expectedGameSha -or
            [string]$Payload.active_public_sha -ne $Target -or
            [string]$Payload.migration_result -notin @('not_required', 'completed') -or
            [string]$Payload.activation_result -ne 'completed' -or
            [string]$Payload.readiness_result -ne 'completed' -or
            $failurePhase -or $failureCode) {
            Stop-Workflow 'completed HTTPS deployment status conflicts with exact active identity or readiness'
        }
    } elseif ([string]$Payload.result -eq 'prepared') {
        if ([string]$Payload.activation_result -ne 'pending' -or
            [string]$Payload.readiness_result -ne 'pending' -or
            $failurePhase -or $failureCode) {
            Stop-Workflow 'PREPARED HTTPS deployment status contains activation or failure evidence'
        }
    } elseif ([string]$Payload.result -eq 'failed') {
        if (-not $failurePhase -or -not $failureCode) {
            Stop-Workflow 'failed HTTPS deployment status lacks sanitized failure evidence'
        }
    } elseif ($failurePhase -or $failureCode) {
        Stop-Workflow 'nonterminal HTTPS deployment status contains terminal failure evidence'
    }
    $mutationFields = @(
        'mutation_evidence_complete', 'migration_started', 'migration_completed',
        'migration_outcome_uncertain', 'activation_started', 'activation_completed',
        'rollback_result'
    )
    $presentMutationFields = @($mutationFields | Where-Object {
            $null -ne $Payload.PSObject.Properties[$_]
        })
    if ($presentMutationFields.Count -gt 0) {
        if ($presentMutationFields.Count -ne $mutationFields.Count) {
            Stop-Workflow 'deployment status has incomplete mutation evidence'
        }
        foreach ($field in @('migration_started', 'migration_completed',
                'migration_outcome_uncertain', 'activation_started', 'activation_completed')) {
            $value = $Payload.PSObject.Properties[$field].Value
            if ($value -isnot [bool]) {
                Stop-Workflow "deployment status has an unknown $field mutation flag"
            }
        }
        if ($Payload.PSObject.Properties['mutation_evidence_complete'].Value -isnot [bool] -or
            -not [bool]$Payload.PSObject.Properties['mutation_evidence_complete'].Value -or
            [string]$Payload.PSObject.Properties['rollback_result'].Value -notin @(
                'not_required', 'prepared', 'running', 'completed', 'failed',
                'blocked_migration_compatibility_uncertain')) {
            Stop-Workflow 'deployment status has unsafe mutation or rollback evidence'
        }
    }
}

function ConvertTo-SanitizedFailureCode([string]$Phase) {
    $safe = $Phase.ToLowerInvariant() -replace '[^a-z0-9._-]', '_'
    $safe = $safe.Trim('._-')
    if (-not $safe) { $safe = 'deployment' }
    return "$safe`_failed"
}

function ConvertFrom-ControllerReceipt {
    param(
        [Parameter(Mandatory = $true)]$Receipt,
        [Parameter(Mandatory = $true)]$State
    )
    $result = [string](Get-StateValue $Receipt 'result' '')
    $failurePhase = [string](Get-StateValue $Receipt 'failure_phase' '')
    $target = [string](Get-StateValue $Receipt 'requested_target_sha' '')
    if (-not $target) { $target = [string](Get-StateValue $Receipt 'target_sha' '') }
    $gameSha = [string](Get-StateValue $Receipt 'observed_game_sha' (
        Get-StateValue $Receipt 'active_game_sha' ''))
    $publicSha = [string](Get-StateValue $Receipt 'observed_public_sha' (
        Get-StateValue $Receipt 'active_public_sha' ''))
    $migrationRequired = Get-StateValue $Receipt 'migration_required' $null
    $migrationResult = if ($result -eq 'failed' -and $failurePhase -eq 'migration') {
        'failed'
    } elseif ((Get-StateValue $Receipt 'migration_completed' $false) -eq $true) {
        'completed'
    } elseif ($migrationRequired -eq $false) {
        'not_required'
    } elseif ((Get-StateValue $Receipt 'migration_started' $false) -eq $true) {
        'running'
    } else {
        'pending'
    }
    $activationResult = if ($result -eq 'failed' -and
        (Get-StateValue $Receipt 'activation_started' $false) -eq $true) {
        'failed'
    } elseif ((Get-StateValue $Receipt 'activation_completed' $false) -eq $true) {
        'completed'
    } elseif ((Get-StateValue $Receipt 'activation_started' $false) -eq $true) {
        'running'
    } else {
        'pending'
    }
    $readinessResult = if ($result -eq 'completed') {
        'completed'
    } elseif ($result -eq 'failed' -and $failurePhase -in @('host_readiness', 'service_restart')) {
        'failed'
    } elseif ([string](Get-StateValue $Receipt 'current_phase' '') -eq 'host_readiness') {
        'running'
    } else {
        'pending'
    }
    $updatedAt = [string](Get-StateValue $Receipt 'finished_at_utc' '')
    if (-not $updatedAt) { $updatedAt = [string](Get-StateValue $Receipt 'started_at_utc' '') }
    if (-not $updatedAt) { $updatedAt = [string](Get-StateValue $Receipt 'accepted_at_utc' '') }
    if (-not $updatedAt) { $updatedAt = (Get-Date).ToUniversalTime().ToString('o') }
    $mutationEvidenceProperty = $Receipt.PSObject.Properties['mutation_evidence_complete']
    $mutationEvidenceComplete = if ($null -ne $mutationEvidenceProperty) {
        if ($mutationEvidenceProperty.Value -is [bool]) {
            [bool]$mutationEvidenceProperty.Value
        } else { $false }
    } else {
        $requiredMutationFields = @(
            'migration_started', 'migration_completed', 'migration_outcome_uncertain',
            'activation_started', 'activation_completed', 'rollback_result'
        )
        $fieldsComplete = @($requiredMutationFields | Where-Object {
                $null -eq $Receipt.PSObject.Properties[$_]
            }).Count -eq 0
        $invalidBooleanFields = if ($fieldsComplete) { @(
            'migration_started', 'migration_completed', 'migration_outcome_uncertain',
            'activation_started', 'activation_completed'
        ) | ForEach-Object {
            if ($Receipt.PSObject.Properties[$_].Value -isnot [bool]) { $_ }
        } } else { @('missing') }
        [bool]$fieldsComplete -and @($invalidBooleanFields).Count -eq 0 -and
            [string]$Receipt.PSObject.Properties['rollback_result'].Value -in @(
                'not_required', 'prepared', 'running', 'completed', 'failed',
                'blocked_migration_compatibility_uncertain')
    }
    return [pscustomobject][ordered]@{
        schema_version = 1
        operation_id = [string](Get-StateValue $Receipt 'operation_id' $State.operation_id)
        target_sha = $target
        result = $result
        current_phase = [string](Get-StateValue $Receipt 'current_phase' 'accepted')
        active_game_sha = $gameSha
        active_public_sha = $publicSha
        migration_result = $migrationResult
        activation_result = $activationResult
        readiness_result = $readinessResult
        failure_phase = $failurePhase
        failure_code = if ($result -eq 'failed') { ConvertTo-SanitizedFailureCode $failurePhase } else { '' }
        mutation_evidence_complete = $mutationEvidenceComplete
        migration_started = if ($null -ne $Receipt.PSObject.Properties['migration_started']) {
            $Receipt.PSObject.Properties['migration_started'].Value
        } else { $null }
        migration_completed = if ($null -ne $Receipt.PSObject.Properties['migration_completed']) {
            $Receipt.PSObject.Properties['migration_completed'].Value
        } else { $null }
        migration_outcome_uncertain = if ($null -ne $Receipt.PSObject.Properties['migration_outcome_uncertain']) {
            $Receipt.PSObject.Properties['migration_outcome_uncertain'].Value
        } else { $null }
        activation_started = if ($null -ne $Receipt.PSObject.Properties['activation_started']) {
            $Receipt.PSObject.Properties['activation_started'].Value
        } else { $null }
        activation_completed = if ($null -ne $Receipt.PSObject.Properties['activation_completed']) {
            $Receipt.PSObject.Properties['activation_completed'].Value
        } else { $null }
        rollback_result = if ($null -ne $Receipt.PSObject.Properties['rollback_result']) {
            [string]$Receipt.PSObject.Properties['rollback_result'].Value
        } else { $null }
        state_transitions = @(Get-StateValue $Receipt 'state_transitions' @())
        updated_at_utc = $updatedAt
    }
}

function Set-DeploymentOutcome {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][string]$Outcome
    )
    $State.deployment_last_outcome = $Outcome
    Write-State $State
}

function Set-DeploymentAdmissionDiscovered {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)]
        [ValidateSet('controller', 'https', 'ssh')][string]$Source
    )
    if (-not $State.deployment_admission_discovered_at_utc) {
        $discoveredAt = (Get-Date).ToUniversalTime()
        $State.deployment_admission_discovered_at_utc = $discoveredAt.ToString('o')
        $State.deployment_admission_source = $Source
        if ($State.deployment_submission_first_attempt_at_utc) {
            $State.deployment_admission_duration_ms = Get-ReleaseElapsedMilliseconds `
                $State.deployment_submission_first_attempt_at_utc $discoveredAt -DiagnosticOnly
            if ($Source -eq 'https') {
                $State.deployment_https_admission_duration_ms =
                    $State.deployment_admission_duration_ms
            }
        }
        Write-State $State
    }
}

function Wait-HttpsSubmissionReconciliation {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][string]$Target
    )
    $deadline = (Get-Date).AddSeconds($DeploymentTimeoutSeconds)
    $delaySeconds = [math]::Min(2, $DeploymentPollIntervalSeconds)
    while ((Get-Date) -lt $deadline) {
        $response = Invoke-HttpsDeploymentStatus $State
        if ([bool]$response.available -and -not [bool]$response.conflict -and
            $null -ne $response.payload) {
            Assert-DeploymentStatusPayload $response.payload $State $Target
            Set-RemoteReceipt $State $response.payload
            Set-DeploymentAdmissionDiscovered $State https
            Set-DeploymentOutcome $State 'reconciliation-found-accepted'
            return $response.payload
        }
        if ([bool]$response.conflict) {
            Stop-Workflow "HTTPS deployment admission conflicts with the submitted operation ($($response.code))"
        }
        $State.deployment_status_read_failures = [int]$State.deployment_status_read_failures + 1
        $State.deployment_automatic_reconciliation_required = $true
        Write-State $State
        $remainingMilliseconds = [math]::Max(0, ($deadline - (Get-Date)).TotalMilliseconds)
        if ($remainingMilliseconds -le 0) { break }
        $sleepMilliseconds = [int][math]::Min($delaySeconds * 1000, $remainingMilliseconds)
        if ($sleepMilliseconds -gt 0) { Start-Sleep -Milliseconds $sleepMilliseconds }
        $delaySeconds = [math]::Min(10, $delaySeconds * 2)
    }
    return $null
}

function Invoke-SshSubmissionReconciliation {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][string]$Target
    )
    $State.deployment_ssh_fallback_count = [int]$State.deployment_ssh_fallback_count + 1
    $State.deployment_ssh_fallback_attempted_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    $State.deployment_automatic_reconciliation_required = $true
    Write-State $State
    $response = Invoke-DeploymentController $State status @()
    if ($null -eq $response.payload) {
        return [pscustomobject]@{ state = 'unknown'; receipt = $null }
    }
    Assert-ConsistentControllerPayload $response
    $result = [string](Get-StateValue $response.payload 'result' '')
    $operationState = [string](Get-StateValue $response.payload 'operation_state' '')
    if ($result -eq 'absent' -and $operationState -eq 'genuinely_unknown') {
        Set-DeploymentOutcome $State 'reconciliation-found-not-accepted'
        return [pscustomobject]@{ state = 'not_accepted'; receipt = $null }
    }
    if ($result -notin @('accepted', 'running', 'prepared', 'completed', 'failed')) {
        return [pscustomobject]@{ state = 'unknown'; receipt = $null }
    }
    $status = ConvertFrom-ControllerReceipt $response.payload $State
    Assert-DeploymentStatusPayload $status $State $Target
    Set-RemoteReceipt $State $response.payload
    Set-RemoteReceipt $State $status
    Set-DeploymentAdmissionDiscovered $State ssh
    Set-DeploymentOutcome $State 'reconciliation-found-accepted'
    return [pscustomobject]@{ state = 'accepted'; receipt = $status }
}

function Resolve-AmbiguousSubmission {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][string]$Target
    )
    $httpsReceipt = Wait-HttpsSubmissionReconciliation $State $Target
    if ($null -ne $httpsReceipt) {
        return [pscustomobject]@{ state = 'accepted'; receipt = $httpsReceipt }
    }
    return Invoke-SshSubmissionReconciliation $State $Target
}

function Invoke-SshStatusFallback {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][string]$Target
    )
    $State.deployment_ssh_fallback_count = [int]$State.deployment_ssh_fallback_count + 1
    $State.deployment_ssh_fallback_attempted_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    $State.deployment_automatic_reconciliation_required = $true
    Write-State $State
    $response = Invoke-DeploymentController $State status @()
    if ($null -eq $response.payload) { return $null }
    Assert-ConsistentControllerPayload $response
    $result = [string]$response.payload.result
    if ($result -in @('absent', 'removed', 'incomplete', 'unreadable', 'malformed',
            'permission_failure', 'version_mismatch', 'unknown')) {
        $operationState = [string](Get-StateValue $response.payload 'operation_state' $result)
        Stop-Workflow "authoritative remote deployment operation is unavailable ($operationState)"
    }
    Set-RemoteReceipt $State $response.payload
    $status = ConvertFrom-ControllerReceipt $response.payload $State
    Assert-DeploymentStatusPayload $status $State $Target
    Set-RemoteReceipt $State $status
    return $status
}

function Complete-ReceiptOutage {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][datetime]$StartedAt,
        [Parameter(Mandatory = $true)][datetime]$FinishedAt
    )
    $durationMilliseconds = [long][math]::Max(
        0, [math]::Round(($FinishedAt - $StartedAt).TotalMilliseconds))
    $State.deployment_longest_receipt_outage_ms = [long][math]::Max(
        [long]$State.deployment_longest_receipt_outage_ms, $durationMilliseconds)
    $State.deployment_total_receipt_outage_ms =
        [long]$State.deployment_total_receipt_outage_ms + $durationMilliseconds
    $State.deployment_receipt_outage_started_at_utc = ''
    $State.deployment_receipt_outage_next_delay_seconds =
        [math]::Min(10, $DeploymentPollIntervalSeconds)
}

function Get-ReceiptOutageStart {
    param([Parameter(Mandatory = $true)]$State)
    $recordedOutageStart = ConvertTo-ReleaseTimestampUtc (Get-StateValue $State 'deployment_receipt_outage_started_at_utc' '') -AllowEmpty
    if (-not $recordedOutageStart) { return $null }
    try {
        return [DateTimeOffset]::Parse(
            $recordedOutageStart, [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind).UtcDateTime
    } catch {
        Stop-Workflow 'operation state contains an invalid receipt outage start time'
    }
}

function Invoke-ReceiptOutageBackoff {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][int]$DelaySeconds,
        [Parameter(Mandatory = $true)][datetime]$Deadline
    )
    $now = Get-Date
    $remainingDeadlineMilliseconds = [math]::Max(0, ($Deadline - $now).TotalMilliseconds)
    $sleepMilliseconds = [int][math]::Min(
        $DelaySeconds * 1000, $remainingDeadlineMilliseconds)
    $nextDelaySeconds = [math]::Min(10, $DelaySeconds * 2)
    $State.deployment_receipt_outage_next_delay_seconds = $nextDelaySeconds
    Write-State $State
    if ($sleepMilliseconds -gt 0) {
        $stopwatch = [Diagnostics.Stopwatch]::StartNew()
        Start-Sleep -Milliseconds $sleepMilliseconds
        $stopwatch.Stop()
        $State.deployment_poll_wait_duration_ms =
            [long]$State.deployment_poll_wait_duration_ms + [long]$stopwatch.ElapsedMilliseconds
    }
    return $nextDelaySeconds
}

function Invoke-DeploymentPollSleep {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][int]$Seconds
    )
    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    Start-Sleep -Seconds $Seconds
    $stopwatch.Stop()
    $State.deployment_poll_wait_duration_ms =
        [long]$State.deployment_poll_wait_duration_ms + [long]$stopwatch.ElapsedMilliseconds
}

function Wait-RemoteDeployment {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)]$InitialReceipt,
        [Parameter(Mandatory = $true)][string]$Target
    )
    $receipt = $InitialReceipt
    $deadline = (Get-Date).AddSeconds($DeploymentTimeoutSeconds)
    $outageStartedAt = Get-ReceiptOutageStart $State
    $nextStatusDelaySeconds = [int](Get-StateValue $State `
        'deployment_receipt_outage_next_delay_seconds' ([math]::Min(10, $DeploymentPollIntervalSeconds)))
    $delayBeforeFirstStatus = $null -ne $outageStartedAt
    $monitorStartedAt = Get-Date
    $phaseStartedAt = $monitorStartedAt
    $lastProgressAt = [datetime]::MinValue
    $lastPhase = ''
    $jsonOutput = [bool](Get-Variable -Name Json -ValueOnly -ErrorAction SilentlyContinue)
    while ([string]$receipt.result -in @('accepted', 'running')) {
        $now = Get-Date
        $nowUtc = $now.ToUniversalTime()
        if ($now -ge $deadline) {
            if ($null -ne $outageStartedAt) {
                Complete-ReceiptOutage $State $outageStartedAt $nowUtc
                Write-State $State
            }
            Stop-Workflow 'remote deployment exceeded its bounded monitoring window'
        }
        if ($delayBeforeFirstStatus) {
            $nextStatusDelaySeconds = Invoke-ReceiptOutageBackoff $State $nextStatusDelaySeconds `
                $deadline
            $delayBeforeFirstStatus = $false
            continue
        }
        $statusAttemptedAt = $nowUtc
        $response = Invoke-HttpsDeploymentStatus $State
        if (-not [bool]$response.available) {
            if ($null -eq $outageStartedAt) {
                $outageStartedAt = $statusAttemptedAt
                $State.deployment_receipt_outage_started_at_utc =
                    $outageStartedAt.ToUniversalTime().ToString('o')
            }
            $State.deployment_status_read_failures = [int]$State.deployment_status_read_failures + 1
            $State.deployment_automatic_reconciliation_required = $true
            $outageMilliseconds = [long][math]::Max(
                0, [math]::Round(((Get-Date).ToUniversalTime() - $outageStartedAt).TotalMilliseconds))
            $State.deployment_longest_receipt_outage_ms = [long][math]::Max(
                [long]$State.deployment_longest_receipt_outage_ms, $outageMilliseconds)
            if ($outageMilliseconds -ge ($HttpsStatusFallbackSeconds * 1000)) {
                $fallbackReceipt = Invoke-SshStatusFallback $State $Target
                if ($null -ne $fallbackReceipt) {
                    Complete-ReceiptOutage $State $outageStartedAt (Get-Date).ToUniversalTime()
                    $outageStartedAt = $null
                    $receipt = $fallbackReceipt
                    Set-DeploymentOutcome $State $(switch ([string]$receipt.result) {
                            'running' { 'operation-running' }
                            'completed' { 'operation-completed' }
                            'failed' { 'operation-failed' }
                            default { 'controller-accepted' }
                    })
                    if ([string]$receipt.result -in @('accepted', 'running')) {
                        Invoke-DeploymentPollSleep $State $DeploymentPollIntervalSeconds
                    }
                    continue
                }
            }
            $nextStatusDelaySeconds = Invoke-ReceiptOutageBackoff $State $nextStatusDelaySeconds `
                $deadline
            continue
        }
        if ([bool]$response.conflict -or $null -eq $response.payload) {
            Stop-Workflow "HTTPS deployment status conflicted with the submitted operation ($($response.code))"
        }
        Assert-DeploymentStatusPayload $response.payload $State $Target
        if ($null -ne $outageStartedAt) {
            Complete-ReceiptOutage $State $outageStartedAt (Get-Date).ToUniversalTime()
            $outageStartedAt = $null
            Write-State $State
        } else {
            $State.deployment_receipt_outage_next_delay_seconds =
                [math]::Min(10, $DeploymentPollIntervalSeconds)
        }
        $nextStatusDelaySeconds = [math]::Min(10, $DeploymentPollIntervalSeconds)
        $receipt = $response.payload
        Set-RemoteReceipt $State $receipt
        $observedAt = Get-Date
        $currentPhase = [string](Get-StateValue $receipt 'current_phase' ([string]$receipt.result))
        if ($currentPhase -ne $lastPhase) {
            $lastPhase = $currentPhase
            $phaseStartedAt = $observedAt
        }
        if (-not $jsonOutput -and ($lastProgressAt -eq [datetime]::MinValue -or
            ($observedAt - $lastProgressAt).TotalSeconds -ge 15 -or
            $currentPhase -ne [string](Get-StateValue $State 'deployment_last_reported_phase' ''))) {
            $elapsed = [math]::Round(($observedAt - $monitorStartedAt).TotalSeconds)
            $phaseElapsed = [math]::Round(($observedAt - $phaseStartedAt).TotalSeconds)
            $waitingOn = if ([string]$receipt.result -in @('accepted', 'running')) {
                'authoritative_vps_completion'
            } else { 'none' }
            Write-Host "[remote deployment] phase=$currentPhase elapsed=${elapsed}s phase_elapsed=${phaseElapsed}s waiting=$waitingOn"
            $lastProgressAt = $observedAt
            Set-StateValue $State 'deployment_last_reported_phase' $currentPhase
        }
        Set-DeploymentOutcome $State $(switch ([string]$receipt.result) {
                'running' { 'operation-running' }
                'completed' { 'operation-completed' }
                'failed' { 'operation-failed' }
                default { 'controller-accepted' }
            })
        if ([string]$receipt.result -in @('accepted', 'running')) {
            Invoke-DeploymentPollSleep $State $DeploymentPollIntervalSeconds
        }
    }
    Set-DeploymentOutcome $State $(switch ([string]$receipt.result) {
            'running' { 'operation-running' }
            'completed' { 'operation-completed' }
            'failed' { 'operation-failed' }
            default { 'controller-accepted' }
        })
    return $receipt
}

function Invoke-GitPlumbingWithInput {
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$InputText
    )
    $temporaryPrefix = Join-Path ([IO.Path]::GetTempPath()) (
        'ash-atlas-git-stdin-' + [guid]::NewGuid().ToString('n')
    )
    $inputPath = "$temporaryPrefix.in"
    $outputPath = "$temporaryPrefix.out"
    $errorPath = "$temporaryPrefix.err"
    $process = $null
    $exitCode = -1
    $output = ''
    $errorOutput = ''
    try {
        [IO.File]::WriteAllBytes(
            $inputPath,
            [Text.UTF8Encoding]::new($false).GetBytes($InputText)
        )
        $git = Get-Command git -ErrorAction Stop
        $nativeArguments = (@('-C', (Get-GameRepositoryRoot)) + $Arguments | ForEach-Object {
            ConvertTo-NativeCommandArgument ([string]$_)
        }) -join ' '
        $process = Start-Process -FilePath $git.Source -ArgumentList $nativeArguments `
            -NoNewWindow -Wait -PassThru -RedirectStandardInput $inputPath `
            -RedirectStandardOutput $outputPath -RedirectStandardError $errorPath
        $exitCode = $process.ExitCode
        $output = [IO.File]::ReadAllText($outputPath)
        $errorOutput = [IO.File]::ReadAllText($errorPath)
    } finally {
        if ($null -ne $process) { $process.Dispose() }
        foreach ($path in @($inputPath, $outputPath, $errorPath)) {
            if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
        }
    }
    if ($exitCode -ne 0) {
        Stop-Workflow "git $($Arguments -join ' ') failed: $errorOutput"
    }
    return $output.Trim()
}

function Get-DeploymentRequestRemoteSha {
    param([Parameter(Mandatory = $true)][string]$RequestRef)
    $git = Get-Command git -ErrorAction Stop
    $result = Invoke-BoundedNativeProcess -FilePath $git.Source -Arguments @(
        '-C', (Get-GameRepositoryRoot), 'ls-remote', '--refs', 'origin', $RequestRef
    ) -TimeoutMilliseconds 20000
    if (-not $result.start_succeeded -or $result.timed_out -or $result.exit_code -ne 0) {
        return [pscustomobject]@{ available = $false; sha = ''; output = [string]$result.stderr }
    }
    $line = ([string]$result.stdout).Trim()
    if (-not $line) { return [pscustomobject]@{ available = $true; sha = ''; output = '' } }
    if ($line -notmatch '^(?<sha>[0-9a-f]{40})\s+') {
        return [pscustomobject]@{ available = $false; sha = ''; output = 'malformed ls-remote output' }
    }
    return [pscustomobject]@{ available = $true; sha = $Matches.sha; output = '' }
}

function New-DeploymentRequestCommit {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][string]$Target,
        [Parameter(Mandatory = $true)][string]$UpdaterHash
    )
    $controller = Join-Path $RepositoryRoot 'tools\release\vps\deploy-control.sh'
    $controllerHash = Get-FileSha256 $controller
    $testTag = [string](Get-StateValue $State 'new_generation' '')
    if ($testTag) { $testTag = "test/$testTag" }
    if (-not $testTag) {
        $tags = @(Get-GitFields (Get-GameRepositoryRoot) @('tag', '--points-at', $Target, '--list', 'test/t*'))
        if ($tags.Count -ne 1) {
            Stop-Workflow 'deployment target must have exactly one immutable test generation tag'
        }
        $testTag = $tags[0]
    }
    $requestedAt = ConvertTo-ReleaseTimestampUtc (Get-StateValue $State 'deployment_submission_first_attempt_at_utc' '') -AllowEmpty
    if (-not $requestedAt) {
        $requestedAt = (Get-Date).ToUniversalTime().ToString('o')
        $State.deployment_submission_first_attempt_at_utc = $requestedAt
    }
    $manifest = [pscustomobject][ordered]@{
        schema_version = 1
        operation_id = [string]$State.operation_id
        target_sha = $Target
        test_tag = $testTag
        updater_sha256 = $UpdaterHash
        controller_version = 7
        controller_sha256 = $controllerHash
        status_token = [string]$State.deployment_status_token
        release_patch_notes_hex = [string](Get-StateValue $State 'release_patch_notes_hex' 'none')
        requested_at_utc = $requestedAt
    }
    $manifestText = $manifest | ConvertTo-Json -Compress
    $manifestHash = Get-TextSha256 $manifestText
    $requestRef = [string]$State.deployment_request_ref
    $remote = Get-DeploymentRequestRemoteSha $requestRef
    if (-not $remote.available) {
        Stop-Workflow "deployment request ref could not be inspected: $($remote.output)"
    }
    $blob = Invoke-GitPlumbingWithInput -Arguments @('hash-object', '-w', '--stdin') `
        -InputText $manifestText
    $tree = Invoke-GitPlumbingWithInput -Arguments @('mktree') `
        -InputText "100644 blob $blob`t`"deployment-request.json`""
    $arguments = @('commit-tree', $tree)
    if ($remote.sha) {
        $arguments += @('-p', [string]$remote.sha)
    }
    $savedEnvironment = [ordered]@{
        GIT_AUTHOR_NAME = $env:GIT_AUTHOR_NAME
        GIT_AUTHOR_EMAIL = $env:GIT_AUTHOR_EMAIL
        GIT_AUTHOR_DATE = $env:GIT_AUTHOR_DATE
        GIT_COMMITTER_NAME = $env:GIT_COMMITTER_NAME
        GIT_COMMITTER_EMAIL = $env:GIT_COMMITTER_EMAIL
        GIT_COMMITTER_DATE = $env:GIT_COMMITTER_DATE
    }
    try {
        $env:GIT_AUTHOR_NAME = 'Ash Atlas Release Controller'
        $env:GIT_AUTHOR_EMAIL = 'release-controller@playashatlas.com'
        $env:GIT_AUTHOR_DATE = $requestedAt
        $env:GIT_COMMITTER_NAME = $env:GIT_AUTHOR_NAME
        $env:GIT_COMMITTER_EMAIL = $env:GIT_AUTHOR_EMAIL
        $env:GIT_COMMITTER_DATE = $requestedAt
        $commit = Invoke-GitPlumbingWithInput -Arguments $arguments `
            -InputText "deploy: request $($State.operation_id)"
    } finally {
        foreach ($entry in $savedEnvironment.GetEnumerator()) {
            if ($null -eq $entry.Value) {
                Remove-Item -Path "env:$($entry.Key)" -ErrorAction SilentlyContinue
            } else {
                Set-Item -Path "env:$($entry.Key)" -Value $entry.Value
            }
        }
    }
    if ($commit -notmatch '^[0-9a-f]{40}$') {
        Stop-Workflow 'deployment request commit identity is invalid'
    }
    $State.deployment_request_parent = [string]$remote.sha
    $State.deployment_request_commit = $commit
    $State.deployment_request_manifest_sha256 = $manifestHash
    $State.deployment_submission_state = 'pending_submission'
    Write-State $State
}

function Assert-DeploymentRequestCommit {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][string]$Target,
        [Parameter(Mandatory = $true)][string]$UpdaterHash
    )
    $commit = [string]$State.deployment_request_commit
    $manifestText = Get-GitText (Get-GameRepositoryRoot) @(
        'show', "${commit}:deployment-request.json")
    try { $manifest = $manifestText | ConvertFrom-Json }
    catch { Stop-Workflow 'persisted deployment request manifest is unreadable' }
    $controllerHash = Get-FileSha256 (
        Join-Path $RepositoryRoot 'tools\release\vps\deploy-control.sh')
    $expectedTag = [string](Get-StateValue $State 'new_generation' '')
    if ($expectedTag) { $expectedTag = "test/$expectedTag" }
    if ([int](Get-StateValue $manifest 'schema_version' 0) -ne 1 -or
        [string](Get-StateValue $manifest 'operation_id' '') -ne [string]$State.operation_id -or
        [string](Get-StateValue $manifest 'target_sha' '') -ne $Target -or
        [string](Get-StateValue $manifest 'updater_sha256' '') -ne $UpdaterHash -or
        [int](Get-StateValue $manifest 'controller_version' 0) -ne 7 -or
        [string](Get-StateValue $manifest 'controller_sha256' '') -ne $controllerHash -or
        [string](Get-StateValue $manifest 'release_patch_notes_hex' 'none') -cne
            [string](Get-StateValue $State 'release_patch_notes_hex' 'none') -or
        [string](Get-StateValue $manifest 'status_token' '') -ne
            [string]$State.deployment_status_token -or
        ($expectedTag -and [string](Get-StateValue $manifest 'test_tag' '') -ne $expectedTag) -or
        [string](Get-StateValue $State 'deployment_request_manifest_sha256' '') -ne
            (Get-TextSha256 $manifestText)) {
        Stop-Workflow 'persisted deployment request differs from the immutable operation tuple'
    }
}

function Publish-DeploymentRequest {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][string]$Target,
        [Parameter(Mandatory = $true)][string]$UpdaterHash
    )
    if (-not $State.deployment_request_commit) {
        New-DeploymentRequestCommit $State $Target $UpdaterHash
    }
    $requestRef = [string]$State.deployment_request_ref
    $commit = [string]$State.deployment_request_commit
    Get-GitText (Get-GameRepositoryRoot) @('cat-file', '-e', "$commit^{commit}") | Out-Null
    Assert-DeploymentRequestCommit $State $Target $UpdaterHash
    $git = Get-Command git -ErrorAction Stop
    $maxAttempts = 1 + $DeploymentSubmissionRetryLimit
    for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
        $State.deployment_submission_attempt_count =
            [int]$State.deployment_submission_attempt_count + 1
        $State.deployment_submission_state = 'pending_submission'
        Write-State $State
        $remote = Get-DeploymentRequestRemoteSha $requestRef
        if ($remote.available -and $remote.sha -eq $commit) {
            $State.deployment_submission_state = 'submitted'
            $State.deployment_start_attempted = $true
            $State.deployment_transport = 'github-pull-request-ref'
            Write-State $State
            return
        }
        if ($remote.available -and $remote.sha -and
            $remote.sha -ne [string]$State.deployment_request_parent) {
            Stop-Workflow 'deployment request ref contains a different unconsumed request'
        }
        $push = Invoke-BoundedNativeProcess -FilePath $git.Source -Arguments @(
            '-C', (Get-GameRepositoryRoot), 'push', 'origin', "$commit`:$requestRef"
        ) -TimeoutMilliseconds 45000
        $remote = Get-DeploymentRequestRemoteSha $requestRef
        if ($remote.available -and $remote.sha -eq $commit) {
            $State.deployment_submission_state = 'submitted'
            $State.deployment_start_attempted = $true
            $State.deployment_transport = 'github-pull-request-ref'
            Write-State $State
            return
        }
        if ($attempt -lt $maxAttempts) {
            $State.deployment_submission_retry_count =
                [int]$State.deployment_submission_retry_count + 1
            Write-State $State
            Start-Sleep -Seconds ([math]::Min(10, [math]::Pow(2, $attempt - 1)))
        }
    }
    Stop-Workflow 'deployment request publication remained unconfirmed after bounded retransmission'
}

function Stop-RemoteDeploymentFailure {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][string]$Target,
        [Parameter(Mandatory = $true)]$FallbackReceipt
    )
    $phase = [string](Get-StateValue $FallbackReceipt 'failure_phase' 'unknown')
    $code = [string](Get-StateValue $FallbackReceipt 'failure_code' 'deployment_failed')
    $message = ''
    $authoritativeFailureReconciled = $false
    try {
        $response = Invoke-DeploymentController $State status @()
        Assert-ConsistentControllerPayload $response
        $receipt = $response.payload
        if ([string](Get-StateValue $receipt 'operation_id' '') -eq [string]$State.operation_id -and
            [string](Get-StateValue $receipt 'requested_target_sha' '') -eq $Target -and
            [string](Get-StateValue $receipt 'result' '') -eq 'failed') {
            $phase = [string](Get-StateValue $receipt 'failure_phase' $phase)
            $code = [string](Get-StateValue $receipt 'failure_code' $code)
            $message = [string](Get-StateValue $receipt 'failure_message' '')
            $rollbackResult = [string](Get-StateValue $receipt 'rollback_result' 'not_required')
            $authoritativeFailureReconciled = $rollbackResult -in @('completed', 'not_required')
            Set-RemoteReceipt $State $receipt
        }
    } catch {
        $message = ''
    }
    $message = (($message -replace '[\x00-\x1f\x7f]', ' ') -replace '\s+', ' ').Trim()
    if ($message.Length -gt 500) { $message = $message.Substring(0, 500) }
    if ($authoritativeFailureReconciled) {
        $State.deployment_automatic_reconciliation_required = $false
    }
    Set-StateValue $State 'deployment_failure_message' $message
    Write-State $State
    $detail = if ($message) { ": $message" } else { '' }
    Stop-Workflow "remote deployment failed in $phase ($code)$detail"
}

function Invoke-DurableDeployment {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][string]$Target,
        [Parameter(Mandatory = $true)][string]$UpdaterHash
    )
    $receipt = $State.remote_deployment_receipt
    $token = [string](Get-StateValue $State 'deployment_status_token' '')

    if ($State.deployment_submission_target_sha -and
        [string]$State.deployment_submission_target_sha -ne $Target) {
        Stop-Workflow 'recorded deployment target differs from the requested target'
    }
    if ($State.deployment_submission_updater_hash -and
        [string]$State.deployment_submission_updater_hash -ne $UpdaterHash) {
        Stop-Workflow 'recorded deployment updater hash differs from the requested updater'
    }
    $State.deployment_submission_target_sha = $Target
    $State.deployment_submission_updater_hash = $UpdaterHash

    if (-not $token) {
        $token = New-DeploymentStatusToken
        $State.deployment_status_token = $token
    }
    if ($token -notmatch '^[0-9a-f]{64}$') {
        Stop-Workflow 'generated deployment-status token is unsafe'
    }
    Write-State $State

    Set-RemoteSideEffectIntent $State 'vps_activation' $Target `
        'deployment request publication and activation require terminal remote reconciliation'
    if ($null -eq $receipt) {
        Publish-DeploymentRequest $State $Target $UpdaterHash
        $acceptedAt = Get-Date
        $receipt = Wait-HttpsSubmissionReconciliation $State $Target
        $State.remote_acceptance_duration_ms =
            [math]::Round(((Get-Date) - $acceptedAt).TotalMilliseconds)
        Write-State $State
        if ($null -eq $receipt) {
            Set-DeploymentOutcome $State 'request-submitted-status-unavailable'
            Stop-Workflow 'deployment request is durably published but HTTPS admission remained unavailable through the bounded monitoring window'
        }
    }

    if ($null -ne $receipt.PSObject.Properties['requested_target_sha']) {
        $receipt = ConvertFrom-ControllerReceipt $receipt $State
    }
    Assert-DeploymentStatusPayload $receipt $State $Target
    switch ([string]$receipt.result) {
        { $_ -in @('accepted', 'running') } {
            Set-DeploymentOutcome $State $(if ([string]$receipt.result -eq 'running') {
                    'operation-running'
                } else { 'controller-accepted' })
            $receipt = Wait-RemoteDeployment $State $receipt $Target
            break
        }
        'completed' {
            Set-DeploymentOutcome $State 'operation-completed'
            break
        }
        'failed' {
            Set-DeploymentOutcome $State 'operation-failed'
            Stop-RemoteDeploymentFailure $State $Target $receipt
        }
        default { Stop-Workflow "remote deployment has unsafe result '$($receipt.result)'" }
    }
    if ([string]$receipt.result -eq 'failed') {
        Set-DeploymentOutcome $State 'operation-failed'
        Stop-RemoteDeploymentFailure $State $Target $receipt
    }
    if ([string]$receipt.result -ne 'completed') {
        Stop-Workflow "remote deployment did not reach a terminal completed receipt: $($receipt.result)"
    }
    $completedAt = (Get-Date).ToUniversalTime()
    $State.deployment_completion_discovered_at_utc = $completedAt.ToString('o')
    if ($State.deployment_submission_first_attempt_at_utc) {
        $State.deployment_operation_completion_duration_ms = Get-ReleaseElapsedMilliseconds `
            $State.deployment_submission_first_attempt_at_utc $completedAt -DiagnosticOnly
    }
    Set-DeploymentOutcome $State 'operation-completed'
    Set-RemoteReceipt $State $receipt
    return $receipt
}

function ConvertTo-ReleaseTimestampUtc($Value, [switch]$AllowEmpty) {
    if ($AllowEmpty -and ($null -eq $Value -or ($Value -is [string] -and $Value -ceq ''))) { return '' }
    try {
        if ($Value -is [DateTimeOffset]) { return $Value.UtcDateTime.ToString('o') }
        if ($Value -is [DateTime]) {
            if ($Value.Kind -eq [DateTimeKind]::Unspecified) { throw 'timestamp has no timezone' }
            return $Value.ToUniversalTime().ToString('o')
        }
        if ($Value -isnot [string] -or
            $Value -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$') {
            throw 'timestamp must be ISO 8601 with an explicit timezone'
        }
        return [DateTimeOffset]::Parse($Value, [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind).UtcDateTime.ToString('o')
    } catch { Stop-Workflow "invalid release timing timestamp: $($_.Exception.Message)" }
}

function Get-ReleaseElapsedMilliseconds($Started, $Finished, [switch]$DiagnosticOnly) {
    try {
        $start = [DateTimeOffset]::Parse((ConvertTo-ReleaseTimestampUtc $Started))
        $finish = [DateTimeOffset]::Parse((ConvertTo-ReleaseTimestampUtc $Finished))
        if ($finish -lt $start) { Stop-Workflow 'release timing interval is negative' }
        return [long][math]::Round(($finish - $start).TotalMilliseconds)
    } catch {
        if (-not $DiagnosticOnly) { throw }
        Write-Warning "Release timing unavailable: $($_.Exception.Message)"
        return $null
    }
}

function Get-ReleasePhaseTiming($Record, $ObservedAt) {
    $start = ConvertTo-ReleaseTimestampUtc (Get-StateValue $Record 'first_started_at_utc' $Record.started_at_utc)
    $finish = ConvertTo-ReleaseTimestampUtc $Record.finished_at_utc -AllowEmpty
    if (-not $finish -and [string]$Record.status -in @('completed', 'failed')) {
        Stop-Workflow 'terminal release phase has no finish timestamp'
    }
    $measuredUntil = if ($finish) { $finish } else { ConvertTo-ReleaseTimestampUtc $ObservedAt }
    $wall = Get-ReleaseElapsedMilliseconds $start $measuredUntil
    $active = 0L
    $attempts = @((Get-StateValue $Record 'attempts' @()) | ForEach-Object {
        $copy = $_.PSObject.Copy()
        $copy.started_at_utc = ConvertTo-ReleaseTimestampUtc $copy.started_at_utc
        $copy.finished_at_utc = ConvertTo-ReleaseTimestampUtc $copy.finished_at_utc -AllowEmpty
        $attemptEnd = if ($copy.finished_at_utc) { $copy.finished_at_utc } else { $measuredUntil }
        $copy.duration_ms = Get-ReleaseElapsedMilliseconds $copy.started_at_utc $attemptEnd
        $copy
    })
    if ($attempts.Count) {
        foreach ($attempt in $attempts) { $active += $attempt.duration_ms }
    } else { $active = $wall }
    return [pscustomobject]@{
        started_at_utc = $start; finished_at_utc = $finish
        duration_ms = $wall; wall_clock_duration_ms = $wall; active_duration_ms = $active
        attempts = $attempts; attempt_count = $(if ($attempts.Count) { $attempts.Count } else { 1 })
    }
}

function Test-ReleaseTimingBudget([long]$Duration, [long]$Limit, [bool]$Applicable) {
    if ($Duration -lt 0) { Stop-Workflow 'release timing duration is negative' }
    # JSON null is N/A, never a measured pass (or a truthy string such as "N/A").
    if (-not $Applicable) { return $null }
    return $Duration -le $Limit
}

function Invoke-Phase {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][scriptblock]$Action
    )
    $existing = $State.phases.PSObject.Properties[$Name]
    if ($null -ne $existing -and [string]$existing.Value.status -eq 'completed') { return $existing.Value.result }
    $started = Get-Date
    if ($null -eq $existing) {
        $record = [pscustomobject][ordered]@{
            status = 'running'
            started_at_utc = $started.ToUniversalTime().ToString('o')
            first_started_at_utc = $started.ToUniversalTime().ToString('o')
            finished_at_utc = ''
            duration_ms = 0
            active_duration_ms = 0
            wall_clock_duration_ms = 0
            attempt_count = 0
            attempts = @()
            result = ''
        }
        Add-Member -InputObject $State.phases -NotePropertyName $Name -NotePropertyValue $record
    } else {
        $record = $existing.Value
        if ($null -eq $record.PSObject.Properties['first_started_at_utc']) {
            Set-StateValue $record 'first_started_at_utc' $record.started_at_utc
        }
        if ($null -eq $record.PSObject.Properties['attempts']) {
            $legacyStatus = [string](Get-StateValue $record 'status' 'interrupted')
            $legacyAttempt = [pscustomobject][ordered]@{
                attempt = 1
                mode = 'legacy'
                status = $legacyStatus
                started_at_utc = $record.started_at_utc
                finished_at_utc = Get-StateValue $record 'finished_at_utc' ''
                duration_ms = Get-StateValue $record 'duration_ms' $null
                result = [string](Get-StateValue $record 'result' '')
            }
            Set-StateValue $record 'attempts' @($legacyAttempt)
        }
        if ($null -eq $record.PSObject.Properties['active_duration_ms']) {
            Set-StateValue $record 'active_duration_ms' (Get-StateValue $record 'duration_ms' $null)
        }
        if ($null -eq $record.PSObject.Properties['wall_clock_duration_ms']) {
            Set-StateValue $record 'wall_clock_duration_ms' (Get-StateValue $record 'duration_ms' $null)
        }
        if ($null -eq $record.PSObject.Properties['attempt_count']) {
            Set-StateValue $record 'attempt_count' @($record.attempts).Count
        }
        $lastAttempt = @($record.attempts | Select-Object -Last 1)
        if ([string]$record.status -eq 'running' -and $lastAttempt.Count -eq 1 -and
            [string]$lastAttempt[0].status -eq 'running') {
            $observed = $State.updated_at_utc
            $priorDuration = Get-ReleaseElapsedMilliseconds $lastAttempt[0].started_at_utc $observed -DiagnosticOnly
            $lastAttempt[0].status = 'interrupted'
            $lastAttempt[0].finished_at_utc = $observed
            $lastAttempt[0].duration_ms = $priorDuration
            $lastAttempt[0].result = 'runner invocation ended before phase completion'
        }
    }
    $attempt = [pscustomobject][ordered]@{
        attempt = @($record.attempts).Count + 1
        mode = [string]$Mode
        status = 'running'
        started_at_utc = $started.ToUniversalTime().ToString('o')
        finished_at_utc = ''
        duration_ms = 0
        result = ''
    }
    $record.attempts = @($record.attempts) + $attempt
    $record.attempt_count = @($record.attempts).Count
    $record.status = 'running'
    $record.finished_at_utc = ''
    $State.status = "running:$Name"
    Write-State $State
    $actionError = $null
    try {
        $result = & $Action
        $record.status = 'completed'
        $attempt.status = 'completed'
        $record.result = [string]($result | Select-Object -Last 1)
        $State.failure_phase = ''
    } catch {
        $actionError = $_
        $record.status = 'failed'
        $attempt.status = 'failed'
        $record.result = $_.Exception.Message
        $State.status = 'failed'
        $State.failure_phase = $Name
    }
    $finished = Get-Date
    $attempt.result = $record.result
    $attempt.finished_at_utc = $finished.ToUniversalTime().ToString('o')
    $record.finished_at_utc = $attempt.finished_at_utc
    # Timing is diagnostic: it must never relabel or replay a completed side effect.
    try {
        $measured = Get-ReleasePhaseTiming $record $finished
        $record.attempts = $measured.attempts
        $record.duration_ms = $measured.duration_ms
        $record.active_duration_ms = $measured.active_duration_ms
        $record.wall_clock_duration_ms = $measured.wall_clock_duration_ms
        Set-StateValue $record 'timing_error' ''
    } catch {
        $attempt.duration_ms = $null
        $record.duration_ms = $null
        $record.active_duration_ms = $null
        $record.wall_clock_duration_ms = $null
        Set-StateValue $record 'timing_error' $_.Exception.Message
        Write-Warning "Release phase $Name timing unavailable: $($_.Exception.Message)"
    }
    Write-State $State
    if ($null -ne $actionError) { throw $actionError }
    Write-Host ("[{0}] {1} - {2}" -f $Name, $(if ($null -eq $record.duration_ms) { 'timing N/A' } else { "$($record.duration_ms) ms" }), $record.result)
    return $record.result
}

function Get-GenerationStatus([string]$Path = (Get-GameRepositoryRoot)) {
    $output = @(& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $RepositoryRoot 'tools\dev\test-generation.ps1') `
        status -RepositoryPath $Path -Json 2>&1)
    if ($LASTEXITCODE -ne 0) { Stop-Workflow "generation snapshot failed: $($output -join [Environment]::NewLine)" }
    return (($output -join "`n") | ConvertFrom-Json)
}

function Assert-ExpectedPublishCandidate {
    param(
        [Parameter(Mandatory = $true)]$Snapshot,
        [Parameter(Mandatory = $true)][string]$Phase
    )
    if (-not $ExpectedGeneration) { return }
    $actualGeneration = [string]$Snapshot.generation
    $actualCandidateSha = [string]$Snapshot.integration_test_sha
    if ($actualGeneration -cne $ExpectedGeneration -or
        $actualCandidateSha -cne $ExpectedCandidateSha) {
        Stop-Workflow ("expected candidate test/{0}@{1} differs from authoritative {2}@{3} at {4}" -f
            $ExpectedGeneration, $ExpectedCandidateSha, $actualGeneration, $actualCandidateSha, $Phase)
    }
}

function Get-RemoteFeatureSha([string]$Branch) {
    $line = Get-GitText (Get-GameRepositoryRoot) @('ls-remote', '--heads', 'origin', "refs/heads/$Branch")
    if ($line -notmatch '^([0-9a-f]{40})\s+refs/heads/.+$') { Stop-Workflow "origin/$Branch did not resolve exactly" }
    return $Matches[1]
}

function Assert-CleanWorktree([string]$Path, [string]$ExpectedBranch, [string]$Label,
    [switch]$AllowUntracked) {
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { Stop-Workflow "$Label is absent: $Path" }
    $gitRoot = Get-GitText $Path @('rev-parse', '--show-toplevel')
    if (-not (Test-AshAtlasSamePath $gitRoot $Path)) { Stop-Workflow "$Label path identity differs" }
    if ((Get-GitText $Path @('branch', '--show-current')) -ne $ExpectedBranch) { Stop-Workflow "$Label is not on $ExpectedBranch" }
    # The permanent checkout may contain user-owned untracked files. Git's ff-only
    # merge still refuses a target that would overwrite any of those paths.
    $statusArgs = @('status', '--porcelain')
    if ($AllowUntracked) { $statusArgs += '--untracked-files=no' }
    if ((Get-GitText $Path $statusArgs) -ne '') { Stop-Workflow "$Label is dirty" }
}

function Require-CandidateAdmission {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][string]$Reason
    )
    $State.candidate_admission_required = $true
    if (-not [string](Get-StateValue $State 'candidate_admission_reason' '')) {
        $State.candidate_admission_reason = $Reason
    }
    Write-State $State
}

function Set-RemoteSideEffectIntent {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][ValidateSet(
            'git_candidate_ref', 'git_protected_publication', 'git_master_publication',
            'vps_activation')][string]$Kind,
        [AllowEmptyString()][string]$Target = '',
        [Parameter(Mandatory = $true)][string]$Reason
    )
    if ($Target -and $Target -notmatch '^[0-9a-f]{40}$') {
        Stop-Workflow 'remote side-effect intent target is not a canonical SHA'
    }
    $existing = Get-StateValue $State 'remote_side_effect_intent' $null
    $existingStatus = if ($null -ne $existing) {
        [string](Get-StateValue $existing 'status' '')
    } else { '' }
    if ($existingStatus -eq 'pending') {
        $existingKind = [string](Get-StateValue $existing 'kind' '')
        $existingTarget = [string](Get-StateValue $existing 'target_sha' '')
        if ($existingKind -ne $Kind -or ($existingTarget -and $Target -and $existingTarget -ne $Target)) {
            Stop-Workflow 'a different remote side-effect intent is still pending reconciliation'
        }
        if (-not $Target) { $Target = $existingTarget }
        $existing.target_sha = $Target
        $existing.reason = $Reason
        $existing.operation_id = [string]$State.operation_id
        Set-StateValue $State 'remote_side_effect_intent' $existing
    } else {
        Set-StateValue $State 'remote_side_effect_intent' ([pscustomobject][ordered]@{
            schema_version = 1
            operation_id = [string]$State.operation_id
            kind = $Kind
            target_sha = $Target
            reason = $Reason
            status = 'pending'
            started_at_utc = (Get-Date).ToUniversalTime().ToString('o')
            reconciled_at_utc = ''
            terminal_result = ''
        })
    }
    if ($Kind -eq 'vps_activation') {
        Set-StateValue $State 'deployment_automatic_reconciliation_required' $true
    }
    Write-State $State
}

# A lost ACTIVATE response is provably harmless only when the server's authoritative status
# for this exact operation and target is still PREPARED, reports no mutation, the live game
# is not the target, and the request is old enough that it cannot still be in flight.
function Test-PreparedActivationProvablyNotStarted {
    param(
        [Parameter(Mandatory = $true)]$State,
        $Receipt,
        [Parameter(Mandatory = $true)][string]$Target,
        [int]$MinimumAgeMinutes = 10
    )
    if ($null -eq $Receipt) { return $false }
    $intent = Get-StateValue $State 'remote_side_effect_intent' $null
    if ($null -eq $intent -or
        [string](Get-StateValue $intent 'status' '') -ne 'pending' -or
        [string](Get-StateValue $intent 'kind' '') -ne 'vps_activation' -or
        [string](Get-StateValue $intent 'target_sha' '') -ne $Target) { return $false }
    $startedAt = [datetime]::MinValue
    if (-not [datetime]::TryParse([string](Get-StateValue $intent 'started_at_utc' ''),
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind, [ref]$startedAt)) { return $false }
    if (((Get-Date).ToUniversalTime() - $startedAt.ToUniversalTime()).TotalMinutes -lt $MinimumAgeMinutes) {
        return $false
    }
    return [string](Get-StateValue $Receipt 'operation_id' '') -eq [string]$State.operation_id -and
        [string](Get-StateValue $Receipt 'target_sha' '') -eq $Target -and
        [string](Get-StateValue $Receipt 'result' '') -eq 'prepared' -and
        [string](Get-StateValue $Receipt 'current_phase' '') -eq 'prepared' -and
        [string](Get-StateValue $Receipt 'active_game_sha' '') -ne $Target -and
        (Test-ReceiptNoMutation $Receipt)
}

function Complete-RemoteSideEffectIntent {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][ValidateSet(
            'git_candidate_ref', 'git_protected_publication', 'git_master_publication',
            'vps_activation')][string]$Kind,
        [AllowEmptyString()][string]$Target = '',
        [Parameter(Mandatory = $true)][ValidateSet('completed', 'failed')][string]$TerminalResult
    )
    $intent = Get-StateValue $State 'remote_side_effect_intent' $null
    if ($null -eq $intent -or [string](Get-StateValue $intent 'status' '') -ne 'pending') {
        return
    }
    $intentKind = [string](Get-StateValue $intent 'kind' '')
    $intentTarget = [string](Get-StateValue $intent 'target_sha' '')
    if ($intentKind -ne $Kind -or ($intentTarget -and $Target -and $intentTarget -ne $Target)) {
        Stop-Workflow 'remote side-effect terminal evidence does not match its durable intent'
    }
    $reconciledAt = (Get-Date).ToUniversalTime().ToString('o')
    Set-StateValue $State 'remote_side_effect_intent' $null
    Set-StateValue $State 'remote_side_effect_intent_reconciled_at_utc' $reconciledAt
    Set-StateValue $State 'remote_side_effect_intent_terminal_result' $TerminalResult
    if ($Kind -eq 'vps_activation') {
        Set-StateValue $State 'deployment_automatic_reconciliation_required' $false
    }
    Write-State $State
}

function Require-ReleaseSideEffectReconciliation {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][string]$Reason,
        [ValidateSet('git_protected_publication', 'git_master_publication')]
        [string]$Kind = 'git_protected_publication'
    )
    $State.side_effect_reconciliation_required = $true
    if (-not [string](Get-StateValue $State 'side_effect_reconciliation_reason' '')) {
        $State.side_effect_reconciliation_reason = $Reason
    }
    if (-not [string](Get-StateValue $State 'side_effect_reconciliation_started_at_utc' '')) {
        $State.side_effect_reconciliation_started_at_utc =
            (Get-Date).ToUniversalTime().ToString('o')
    }
    $target = [string](Get-StateValue $State 'final_candidate_sha' '')
    if ($target -notmatch '^[0-9a-f]{40}$') {
        $target = [string](Get-StateValue $State 'candidate_integration_sha' '')
    }
    Set-RemoteSideEffectIntent $State $Kind $target $Reason
}

function Invoke-LocalPublishedCheckoutReconciliation {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$Target,
        [switch]$RequireMaster
    )
    Assert-CleanWorktree $IntegrationWorktree 'integration/test' 'dedicated integration worktree'
    if ($RequireMaster) {
        Assert-CleanWorktree $PermanentCheckout 'master' 'permanent master checkout' -AllowUntracked
    }
    Invoke-Git $IntegrationWorktree @(
        'fetch', 'origin', '--prune', '--no-tags',
        'refs/heads/integration/test:refs/remotes/origin/integration/test',
        'refs/heads/master:refs/remotes/origin/master'
    )
    Invoke-Git $PermanentCheckout @(
        'fetch', 'origin', '--prune', '--no-tags',
        'refs/heads/integration/test:refs/remotes/origin/integration/test',
        'refs/heads/master:refs/remotes/origin/master'
    )
    $remoteIntegration = Get-GitCommitId $PermanentCheckout 'origin/integration/test'
    if ($remoteIntegration -ne $Target) {
        Stop-Workflow 'remote integration/test is not the published reconciliation target'
    }
    if ($RequireMaster) {
        $remoteMaster = Get-GitCommitId $PermanentCheckout 'origin/master'
        if ($remoteMaster -ne $Target) {
            Stop-Workflow 'remote master is not the published reconciliation target'
        }
    }

    $localIntegration = Get-GitCommitId $IntegrationWorktree 'HEAD'
    if ($localIntegration -ne $Target) {
        Invoke-Git $IntegrationWorktree @('merge-base', '--is-ancestor', $localIntegration, $Target)
        Invoke-Git $IntegrationWorktree @('merge', '--ff-only', $Target)
    }
    if ((Get-GitCommitId $IntegrationWorktree 'HEAD') -ne $Target) {
        Stop-Workflow 'dedicated integration worktree did not reconcile to the published target'
    }

    if ($RequireMaster) {
        $localMaster = Get-GitCommitId $PermanentCheckout 'HEAD'
        if ($localMaster -ne $Target) {
            Invoke-Git $PermanentCheckout @('merge-base', '--is-ancestor', $localMaster, $Target)
            Invoke-Git $PermanentCheckout @('merge', '--ff-only', $Target)
        }
        if ((Get-GitCommitId $PermanentCheckout 'HEAD') -ne $Target) {
            Stop-Workflow 'permanent master checkout did not reconcile to the published target'
        }
    }
    Assert-CleanWorktree $IntegrationWorktree 'integration/test' 'reconciled integration worktree'
    if ($RequireMaster) {
        Assert-CleanWorktree $PermanentCheckout 'master' 'reconciled permanent master checkout' -AllowUntracked
    }
    $State.local_checkout_reconciliation_target_sha = $Target
    $State.local_checkout_reconciliation_result = if ($RequireMaster) {
        "integration/test and master reconciled@$Target"
    } else { "integration/test reconciled@$Target" }
    $intent = Get-StateValue $State 'remote_side_effect_intent' $null
    $intentKind = if ($null -ne $intent) { [string](Get-StateValue $intent 'kind' '') } else { '' }
    if ($intentKind -in @('git_protected_publication', 'git_master_publication')) {
        Complete-RemoteSideEffectIntent $State $intentKind $Target 'completed'
    }
    $State.side_effect_reconciliation_required = $false
    $State.side_effect_reconciliation_completed_at_utc =
        (Get-Date).ToUniversalTime().ToString('o')
    Write-State $State
    return $State.local_checkout_reconciliation_result
}

function Invoke-FocusedCandidateAdmission {
    param([Parameter(Mandatory = $true)]$State)
    $candidate = [string]$State.candidate_integration_sha
    if ($candidate -notmatch '^[0-9a-f]{40}$') {
        Stop-Workflow 'focused candidate admission requires one canonical candidate SHA'
    }
    $candidateRoot = Get-GitText $IntegrationWorktree @('rev-parse', '--show-toplevel')
    if (-not (Test-AshAtlasSamePath $candidateRoot $IntegrationWorktree)) {
        Stop-Workflow 'focused candidate admission worktree identity differs'
    }
    Assert-CleanWorktree $IntegrationWorktree 'integration/test' 'focused admission candidate worktree'
    $before = Get-GitCommitId $IntegrationWorktree 'HEAD'
    if ($before -ne $candidate) {
        Stop-Workflow 'focused candidate admission candidate SHA is no longer checked out'
    }
    $command = [string](Get-StateValue $State 'admission_command' '')
    if (-not $command) {
        Stop-Workflow 'candidate admission requires a command because merge provenance is uncertain'
    }
    $oldSha = $env:ASH_ATLAS_ADMISSION_SHA
    $oldCwd = $env:ASH_ATLAS_ADMISSION_CWD
    $receipt = $null
    try {
        $env:ASH_ATLAS_ADMISSION_SHA = $candidate
        $env:ASH_ATLAS_ADMISSION_CWD = $candidateRoot
        $gate = New-BatchGate 'focused_candidate_admission' 'powershell.exe' @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $command
        ) $false 1800 'native' $candidateRoot $candidate
        $State.admission_before_sha = $before
        $State.admission_candidate_sha = $candidate
        $State.admission_working_directory = $candidateRoot
        Write-State $State
        $receipt = @(Complete-BatchGateProcesses $State @(
                (Start-BatchGateProcess $State $gate)
            ) -PhaseName 'focused_admission')[0]
    } catch {
        $State.admission_result = "command failed at $candidate in cwd $candidateRoot"
        $State.admission_receipt = $receipt
        Write-State $State
        throw
    } finally {
        if ($null -eq $oldSha) { Remove-Item Env:\ASH_ATLAS_ADMISSION_SHA -ErrorAction SilentlyContinue }
        else { $env:ASH_ATLAS_ADMISSION_SHA = $oldSha }
        if ($null -eq $oldCwd) { Remove-Item Env:\ASH_ATLAS_ADMISSION_CWD -ErrorAction SilentlyContinue }
        else { $env:ASH_ATLAS_ADMISSION_CWD = $oldCwd }
    }
    $after = Get-GitCommitId $IntegrationWorktree 'HEAD'
    Assert-CleanWorktree $IntegrationWorktree 'integration/test' 'focused admission candidate worktree after command'
    if ($after -ne $candidate) {
        Stop-Workflow 'focused candidate admission changed the candidate checkout'
    }
    $State.admission_after_sha = $after
    $State.admission_receipt = $receipt
    $State.admission_result = "command passed at $candidate in cwd $candidateRoot"
    Write-State $State
    return $State.admission_result
}

function Assert-IntegrationWorktreeRecoveryState {
    param([Parameter(Mandatory = $true)]$State)
    $receipt = Get-StateValue $State 'remote_deployment_receipt' $null
    $recoverableOrphan = [string]$State.status -eq 'running:prepare_candidate_on_vps' -and
        $null -ne $receipt -and
        [string](Get-StateValue $receipt 'result' '') -eq 'prepared' -and
        [string](Get-StateValue $receipt 'prepare_result' '') -eq 'completed'
    if ([string]$State.status -ne 'failed' -and -not $recoverableOrphan) {
        Stop-Workflow 'integration-worktree recovery requires a failed operation or an exact orphaned PREPARE'
    }
    if ([string]$State.requested_mode -notin @('Integrate', 'IntegrateAndPublish')) {
        Stop-Workflow 'failed operation did not own an integration candidate'
    }
    $baseline = [string]$State.original_integration_sha
    $candidate = [string]$State.candidate_integration_sha
    if ($baseline -notmatch '^[0-9a-f]{40}$' -or $candidate -notmatch '^[0-9a-f]{40}$' -or
        $baseline -eq $candidate) {
        Stop-Workflow 'failed operation does not record a distinct safe baseline and candidate'
    }
    $mergePhase = $State.phases.PSObject.Properties['local_merge']
    if ($null -eq $mergePhase -or [string]$mergePhase.Value.status -ne 'completed') {
        Stop-Workflow 'failed operation did not complete the recorded local candidate merge'
    }
    foreach ($field in @('new_generation', 'atomic_push_result', 'master_publication_result',
            'exact_deployed_sha')) {
        if ([string](Get-StateValue $State $field '')) {
            Stop-Workflow "failed operation records protected publication or deployment state in $field"
        }
    }
    $pendingIntent = Get-StateValue $State 'remote_side_effect_intent' $null
    if ($null -ne $pendingIntent -and
        [string](Get-StateValue $pendingIntent 'status' '') -eq 'pending') {
        Stop-Workflow 'failed operation has an unresolved remote side-effect intent'
    }
    if ($null -ne $receipt) {
        $receiptTarget = [string](Get-StateValue $receipt 'target_sha' '')
        if (-not $receiptTarget) {
            $receiptTarget = [string](Get-StateValue $receipt 'requested_target_sha' '')
        }
        $receiptResult = [string](Get-StateValue $receipt 'result' '')
        if ($receiptTarget -ne $candidate -or
            $receiptResult -notin @('failed', 'prepared') -or
            [string](Get-StateValue $receipt 'active_game_sha' '') -eq $candidate -or
            [string](Get-StateValue $receipt 'active_public_sha' '') -eq $candidate -or
            [string](Get-StateValue $receipt 'activation_result' '') -eq 'completed') {
            Stop-Workflow 'failed deployment receipt does not prove the candidate remained inactive'
        }
        $durablePreparedReceipt = [string](Get-StateValue $State 'prepared_receipt_sha256' '') -match
            '^[0-9a-f]{64}$'
        $fullPreparedReceipt = [string](Get-StateValue $receipt 'prepare_result' '') -eq 'completed' -and
            [string](Get-StateValue $receipt 'candidate_preflight_result' '') -eq 'completed'
        if ($receiptResult -eq 'prepared' -and (
                (-not $fullPreparedReceipt -and -not $durablePreparedReceipt) -or
                [string](Get-StateValue $receipt 'current_phase' '') -ne 'prepared' -or
                [bool](Get-StateValue $receipt 'activation_started' $false) -or
                [bool](Get-StateValue $receipt 'activation_completed' $false) -or
                [string](Get-StateValue $receipt 'activation_result' '') -ne 'pending')) {
            Stop-Workflow 'prepared deployment receipt is not an exact completed PREPARE with activation pending'
        }
    }
}

function Get-IntegrationWorktreeRecoveryEvidence {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)]$Truth,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$RemoteTagSnapshot,
        [Parameter(Mandatory = $true)][string]$RemoteCandidateSha
    )
    $baseline = [string]$State.original_integration_sha
    $candidate = [string]$State.candidate_integration_sha
    $featureTip = [string]$State.feature_tip
    $currentIntegration = [string](Get-StateValue $Truth 'integration_test_sha' '')
    $currentMaster = [string](Get-StateValue $Truth 'master_sha' '')
    $currentDeployed = [string](Get-StateValue $Truth 'deployed_sha' '')
    $currentPublic = [string](Get-StateValue $Truth 'public_release_sha' '')
    foreach ($identity in @(
            @('integration_test_sha', $currentIntegration),
            @('master_sha', $currentMaster),
            @('deployed_sha', $currentDeployed),
            @('public_release_sha', $currentPublic))) {
        if ([string]$identity[1] -notmatch '^[0-9a-f]{40}$') {
            Stop-Workflow "current $($identity[0]) is not an exact Git identity"
        }
    }
    if (-not (Test-GitAncestor (Get-GameRepositoryRoot) $baseline $currentIntegration)) {
        Stop-Workflow 'current integration/test does not descend from the failed operation baseline'
    }
    $masterBaseline = [string](Get-StateValue $State 'original_master_sha' '')
    if ($masterBaseline -notmatch '^[0-9a-f]{40}$' -or
        -not (Test-GitAncestor (Get-GameRepositoryRoot) $masterBaseline $currentMaster)) {
        Stop-Workflow 'current master does not descend from the failed operation baseline'
    }
    if ($RemoteCandidateSha -ne $candidate) {
        Stop-Workflow 'preserved release-candidate ref does not equal the failed candidate'
    }
    $candidateInIntegration = Test-GitAncestor (Get-GameRepositoryRoot) $candidate $currentIntegration
    $candidateInMaster = Test-GitAncestor (Get-GameRepositoryRoot) $candidate $currentMaster
    $candidateTagged = $RemoteTagSnapshot -match "(?m)^$candidate\s+refs/tags/test/t\d{3,4}(\^\{\})?$"
    if ($candidateTagged -and -not $candidateInIntegration) {
        Stop-Workflow 'failed candidate has an immutable generation but is absent from current integration/test'
    }
    $candidateInDeployed = Test-GitAncestor (Get-GameRepositoryRoot) $candidate $currentDeployed
    $candidateInPublic = Test-GitAncestor (Get-GameRepositoryRoot) $candidate $currentPublic
    if (($candidateInDeployed -or $candidateInPublic) -and -not $candidateInIntegration) {
        Stop-Workflow 'current deployed or public state contains the candidate outside protected integration history'
    }
    $featureInIntegration = Test-GitAncestor (Get-GameRepositoryRoot) $featureTip $currentIntegration
    $cherry = if ($featureInIntegration) { '' } else {
        Get-GitText (Get-GameRepositoryRoot) @('cherry', $currentIntegration, $featureTip)
    }
    $featurePatchEquivalent = -not $featureInIntegration -and
        $cherry -match "(?m)^-\s+$featureTip$"
    $classification = if ($candidateInIntegration) {
        'candidate_admitted'
    } elseif ($featureInIntegration) {
        'feature_incorporated'
    } elseif ($featurePatchEquivalent) {
        'feature_patch_equivalent'
    } else {
        'unmerged'
    }
    return [pscustomobject][ordered]@{
        schema_version = 1
        classification = $classification
        original_integration_sha = $baseline
        current_integration_sha = $currentIntegration
        original_master_sha = $masterBaseline
        current_master_sha = $currentMaster
        current_deployed_sha = $currentDeployed
        current_public_sha = $currentPublic
        candidate_sha = $candidate
        feature_tip = $featureTip
        candidate_in_integration = $candidateInIntegration
        candidate_in_master = $candidateInMaster
        candidate_in_deployed = $candidateInDeployed
        candidate_in_public = $candidateInPublic
        candidate_has_generation = $candidateTagged
        feature_in_integration = $featureInIntegration
        feature_patch_equivalent = $featurePatchEquivalent
        preserved_candidate_sha = $RemoteCandidateSha
        checked_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    }
}

function Restore-IntegrationWorktreeToProtectedIntegration {
    param(
        [Parameter(Mandatory = $true)][string]$Candidate,
        [Parameter(Mandatory = $true)][string]$ProtectedIntegration
    )
    Assert-CleanWorktree $IntegrationWorktree 'integration/test' 'dedicated integration worktree'
    if ((Get-GitCommitId $IntegrationWorktree 'HEAD') -ne $Candidate) {
        Stop-Workflow 'dedicated integration worktree is not exactly at the failed candidate'
    }
    Invoke-Git $IntegrationWorktree @('reset', '--hard', $ProtectedIntegration) | Out-Null
    Assert-CleanWorktree $IntegrationWorktree 'integration/test' 'restored integration worktree'
    if ((Get-GitCommitId $IntegrationWorktree 'HEAD') -ne $ProtectedIntegration) {
        Stop-Workflow 'integration worktree recovery did not restore exact protected integration'
    }
}

function Complete-RelatedBlockedRecoveryAttempt {
    param(
        [Parameter(Mandatory = $true)]$PrimaryState,
        [Parameter(Mandatory = $true)][string]$RelatedId,
        [Parameter(Mandatory = $true)][string]$RestoredIntegrationSha
    )
    $related = Read-State $RelatedId
    Initialize-DeploymentState $related
    if ([string]$related.status -ne 'failed' -or
        [string]$related.failure_phase -ne 'feature_and_worktree_validation' -or
        [string](Get-StateValue $related 'candidate_integration_sha' '') -or
        [string](Get-StateValue $related 'new_generation' '') -or
        [string]$related.original_integration_sha -ne $RestoredIntegrationSha) {
        Stop-Workflow 'related blocked operation is not an exact pre-candidate validation failure'
    }
    Set-StateValue $related 'integration_worktree_recovery_reconciliation' ([pscustomobject][ordered]@{
            schema_version = 1
            status = 'completed'
            primary_operation_id = [string]$PrimaryState.operation_id
            failed_candidate_sha = [string]$PrimaryState.candidate_integration_sha
            original_candidate_baseline_sha = [string]$PrimaryState.original_integration_sha
            restored_integration_sha = $RestoredIntegrationSha
            candidate_created = $false
            reconciled_at_utc = (Get-Date).ToUniversalTime().ToString('o')
        })
    Write-State $related
}

function Invoke-IntegrationWorktreeRecovery {
    param([Parameter(Mandatory = $true)]$State)
    if (-not $ConfirmIntegrationWorktreeRecovery) {
        Stop-Workflow 'integration-worktree recovery requires -ConfirmIntegrationWorktreeRecovery'
    }
    $baseline = [string]$State.original_integration_sha
    $candidate = [string]$State.candidate_integration_sha
    $projectedReceipt = Get-StateValue $State 'remote_deployment_receipt' $null
    if ([string]$State.status -eq 'running:prepare_candidate_on_vps' -or
        ($null -ne $projectedReceipt -and
         [string](Get-StateValue $projectedReceipt 'result' '') -eq 'prepared' -and
         [string](Get-StateValue $projectedReceipt 'prepare_result' '') -ne 'completed')) {
        $exact = Invoke-DeploymentController $State status @()
        Assert-ConsistentControllerPayload $exact
        if ([string](Get-StateValue $exact.payload 'result' '') -ne 'prepared' -or
            [string](Get-StateValue $exact.payload 'requested_target_sha' '') -ne $candidate -or
            [string](Get-StateValue $exact.payload 'activation_result' '') -ne 'pending' -or
            [bool](Get-StateValue $exact.payload 'activation_started' $true) -or
            [string](Get-StateValue $exact.payload 'active_game_sha' '') -eq $candidate -or
            [string](Get-StateValue $exact.payload 'active_public_sha' '') -eq $candidate) {
            Stop-Workflow 'exact recovery receipt does not prove the candidate remained prepared and inactive'
        }
        Set-RemoteReceipt $State $exact.payload
    }
    Assert-IntegrationWorktreeRecoveryState $State
    $candidateRef = [string](Get-StateValue $State 'release_candidate_ref' '')
    if ($candidateRef -notmatch '^refs/heads/integration/release-candidates/[A-Za-z0-9._-]+$') {
        Stop-Workflow 'failed operation does not record a safe preserved release-candidate ref'
    }

    Invoke-Git (Get-GameRepositoryRoot) @('fetch', '--prune', '--tags', 'origin')
    $truth = Reconcile-RemoteTruth $State
    $tags = Get-GitText (Get-GameRepositoryRoot) @('ls-remote', '--tags', 'origin', 'refs/tags/test/t*')
    $candidateLine = Get-GitText (Get-GameRepositoryRoot) @('ls-remote', '--heads', 'origin', $candidateRef)
    $remoteCandidate = if ($candidateLine -match '^([0-9a-f]{40})\s+') { $Matches[1] } else { '' }
    $evidence = Get-IntegrationWorktreeRecoveryEvidence $State $truth $tags $remoteCandidate
    $reason = if ($CandidateDispositionReason) { $CandidateDispositionReason.Trim() } else { '' }
    $resolvedDisposition = $CandidateDisposition
    if ($CandidateDisposition -eq 'Auto') {
        $resolvedDisposition = switch ([string]$evidence.classification) {
            'candidate_admitted' { 'Incorporated' }
            'feature_incorporated' { 'Incorporated' }
            'feature_patch_equivalent' { 'Superseded' }
            default {
                Stop-Workflow 'candidate remains unmerged; choose Reintegrate, Superseded, or Abandoned with forensic reason'
            }
        }
        if (-not $reason) {
            $reason = "automatic recovery classification: $($evidence.classification)"
        }
    } elseif ($CandidateDisposition -eq 'Reintegrate') {
        if ([string]$evidence.classification -ne 'unmerged') {
            Stop-Workflow "Reintegrate requires an unmerged candidate, not $($evidence.classification)"
        }
        if (-not $reason) {
            Stop-Workflow 'Reintegrate requires -CandidateDispositionReason for the forensic record'
        }
        $remoteFeatureTip = Get-RemoteFeatureSha ([string]$State.feature_branch)
        if (-not (Test-GitAncestor (Get-GameRepositoryRoot) ([string]$State.feature_tip) $remoteFeatureTip)) {
            Stop-Workflow 'continued remote feature branch does not contain the failed candidate feature tip'
        }
        Assert-CleanWorktree ([string]$State.feature_worktree) ([string]$State.feature_branch) `
            'continued candidate feature worktree'
        if ((Get-GitCommitId ([string]$State.feature_worktree) 'HEAD') -ne $remoteFeatureTip) {
            Stop-Workflow 'continued candidate feature worktree does not equal its exact remote tip'
        }
        Add-Member -InputObject $evidence -NotePropertyName continued_feature_tip `
            -NotePropertyValue $remoteFeatureTip -Force
    } else {
        if (-not $ConfirmCandidateRetirement) {
            Stop-Workflow "$CandidateDisposition requires -ConfirmCandidateRetirement"
        }
        if (-not $reason) {
            Stop-Workflow "$CandidateDisposition requires -CandidateDispositionReason for the forensic record"
        }
    }
    if ($reason.Length -gt 1000) {
        Stop-Workflow '-CandidateDispositionReason exceeds 1000 characters'
    }

    Assert-CleanWorktree $IntegrationWorktree 'integration/test' 'dedicated integration worktree'
    $head = Get-GitCommitId $IntegrationWorktree 'HEAD'
    $protectedIntegration = [string]$evidence.current_integration_sha
    $existing = Get-StateValue $State 'integration_worktree_recovery' $null
    if ($null -ne $existing -and [string](Get-StateValue $existing 'status' '') -in @('running', 'completed') -and
        $head -eq $protectedIntegration) {
        $result = $existing
    } else {
        if ($head -ne $candidate) {
            Stop-Workflow 'dedicated integration worktree is neither the failed candidate nor a resumable restored baseline'
        }
        $parents = @(Get-GitFields $IntegrationWorktree @('show', '-s', '--format=%P', $candidate))
        if (-not (Test-ExactMergeParents $parents $baseline ([string]$State.feature_tip))) {
            Stop-Workflow 'failed candidate parents do not match its recorded baseline and feature tip'
        }
        $playerPatchNoteMatch = [pscustomobject][ordered]@{
            match_type = 'not_checked'
            repair_pass_count = 0
            immutable_candidate_trailer = ''
        }
        $frozenPlayerPatchNote = [string](Get-StateValue $State 'player_patch_note' '')
        if ($frozenPlayerPatchNote) {
            $immutableCandidateTrailer = Get-CommitPlayerPatchNoteTrailer $IntegrationWorktree $candidate
            $playerPatchNoteMatch = Get-PlayerPatchNoteRecoveryMatch `
                $frozenPlayerPatchNote $immutableCandidateTrailer
        }
        $result = [pscustomobject][ordered]@{
            schema_version = 2
            status = 'running'
            candidate_sha = $candidate
            original_baseline_sha = $baseline
            restored_integration_sha = $protectedIntegration
            preserved_candidate_ref = $candidateRef
            disposition = $resolvedDisposition
            disposition_reason = $reason
            evidence = $evidence
            player_patch_note_match_type = [string]$playerPatchNoteMatch.match_type
            player_patch_note_repair_pass_count = [int]$playerPatchNoteMatch.repair_pass_count
            immutable_candidate_trailer = [string]$playerPatchNoteMatch.immutable_candidate_trailer
            started_at_utc = (Get-Date).ToUniversalTime().ToString('o')
            completed_at_utc = ''
            local_candidate_ownership = 'held'
        }
        Set-StateValue $State 'integration_worktree_recovery' $result
        Write-State $State
        Restore-IntegrationWorktreeToProtectedIntegration $candidate $protectedIntegration
    }
    $result.status = 'completed'
    $result.completed_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    $result.local_candidate_ownership = 'released'
    Set-StateValue $State 'integration_worktree_recovery' $result
    if ([string]$State.status -eq 'running:prepare_candidate_on_vps') {
        $State.status = 'failed'
        $State.failure_phase = 'recovered_inactive_prepare'
        $State.completed_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    }
    Write-State $State
    if ($RelatedBlockedOperationId) {
        Complete-RelatedBlockedRecoveryAttempt $State $RelatedBlockedOperationId $protectedIntegration
    }
    return $result
}

function Get-BatchRemoteSnapshot {
    param([Parameter(Mandatory = $true)]$State)
    Invoke-Git (Get-GameRepositoryRoot) @('fetch', '--prune', 'origin')
    $State.initial_remote_fetch_count = [int]$State.initial_remote_fetch_count + 1
    $lines = Get-GitText (Get-GameRepositoryRoot) @(
        'ls-remote', 'origin', 'refs/heads/*', 'refs/tags/test/*'
    )
    $State.initial_remote_snapshot_count = [int]$State.initial_remote_snapshot_count + 1
    $heads = @{}
    $tagObjects = @{}
    $peeled = @{}
    $canonical = @()
    foreach ($line in @($lines -split '\r?\n' | Where-Object { $_ })) {
        if ($line -notmatch '^([0-9a-f]{40})\s+(.+)$') {
            Stop-Workflow "batch preflight received malformed remote ref output: $line"
        }
        $sha = $Matches[1]
        $ref = $Matches[2]
        if ($ref -match '^refs/heads/(.+)$') {
            if ($heads.ContainsKey($Matches[1])) {
                Stop-Workflow "batch preflight received duplicate remote branch $ref"
            }
            $heads[$Matches[1]] = $sha
        } elseif ($ref -match '^refs/tags/(test/t\d{3,4})\^\{\}$') {
            if ($peeled.ContainsKey($Matches[1])) {
                Stop-Workflow "batch preflight received duplicate peeled generation $ref"
            }
            $peeled[$Matches[1]] = $sha
        } elseif ($ref -match '^refs/tags/(test/t\d{3,4})$') {
            if ($tagObjects.ContainsKey($Matches[1])) {
                Stop-Workflow "batch preflight received duplicate generation $ref"
            }
            $tagObjects[$Matches[1]] = $sha
        } else {
            Stop-Workflow "batch preflight received an unexpected remote ref: $ref"
        }
    }
    foreach ($required in @('master', 'integration/test')) {
        if (-not $heads.ContainsKey($required)) {
            Stop-Workflow "batch preflight could not resolve origin/$required"
        }
    }
    foreach ($name in $peeled.Keys) {
        if (-not $tagObjects.ContainsKey($name)) {
            Stop-Workflow "batch preflight received peeled generation $name without its tag object"
        }
    }
    $generations = @($tagObjects.Keys | ForEach-Object {
        [pscustomobject]@{
            name = [string]$_
            commit_sha = $(if ($peeled.ContainsKey($_)) { [string]$peeled[$_] } else { [string]$tagObjects[$_] })
            object_sha = [string]$tagObjects[$_]
        }
    } | Sort-Object { [int]([string]$_.name).Substring(6) })
    for ($index = 0; $index -lt $generations.Count; $index++) {
        if ([string]$generations[$index].name -ne "test/t$($index.ToString('D3'))") {
            Stop-Workflow "batch preflight found a malformed, duplicate, or gapped generation namespace"
        }
    }
    $duplicateGenerationCommits = @($generations | Group-Object commit_sha | Where-Object Count -gt 1)
    if ($duplicateGenerationCommits.Count -gt 0) {
        Stop-Workflow "batch preflight found multiple gameplay generations at $($duplicateGenerationCommits[0].Name)"
    }
    if ($generations.Count -eq 0) { Stop-Workflow 'batch preflight requires an immutable gameplay generation' }
    $canonical = @(
        "refs/heads/integration/test $($heads['integration/test'])",
        "refs/heads/master $($heads['master'])"
    )
    $canonical += @($generations | ForEach-Object {
        "refs/tags/$($_.name) $($_.object_sha) $($_.commit_sha)"
    })
    return [pscustomobject][ordered]@{
        heads = $heads
        generations = $generations
        integration_test_sha = [string]$heads['integration/test']
        master_sha = [string]$heads['master']
        latest_generation = [string]$generations[-1].name.Substring(5)
        latest_generation_sha = [string]$generations[-1].commit_sha
        snapshot_id = Get-TextSha256 ($canonical -join "`n")
    }
}

function Test-BatchForbiddenInfrastructurePath {
    param([Parameter(Mandatory = $true)][string]$Path)
    return $Path -eq '.gitattributes' -or
        $Path -match '^tools/release/' -or
        $Path -match '^tools/dev/(?:test-generation|integration-admission-policy|feature-(?:runtime|merged-receipt)|runtime-(?:lib|policy)|run-main|world-runtime-groups)' -or
        $Path -match '^tools/telemetry-home/' -or
        $Path -match '^\.github/workflows/' -or
        $Path -match '^(?:pnpm-lock\.yaml|pnpm-workspace\.yaml)$' -or
        $Path -match '(?:^|/)package\.json$' -or
        $Path -match '(?:^|/)(?:tsconfig(?:\.[^/]+)?\.json|eslint\.config\.[^/]+|vite\.config\.[^/]+|playwright[^/]*\.config\.[^/]+)$' -or
        $Path -match '^(?:Dockerfile|docker-compose\.ya?ml)$' -or
        $Path -match '^config/(?:dev-runtime|world-runtime|release|deployment)' -or
        $Path -match '(?:^|/)(?:Caddyfile|[^/]+\.caddy|[^/]+\.service)$'
}

function Get-BatchDisplayName {
    param([Parameter(Mandatory = $true)][string]$Branch, [string]$RequestedDisplayName)
    if ($RequestedDisplayName) { return $RequestedDisplayName }
    $slug = ($Branch -split '/', 2)[-1] -replace '--from-t\d{3,4}$', ''
    return ((Get-Culture).TextInfo.ToTitleCase(($slug -replace '[-_]+', ' ')))
}

function Get-BatchFeatureManifest {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)]$Snapshot
    )
    $requested = @($State.feature_worktrees)
    if ($requested.Count -eq 0) { Stop-Workflow '-FeatureWorktrees requires at least one feature worktree' }
    $notes = @($State.player_patch_notes)
    if ($notes.Count -ne $requested.Count) {
        Stop-Workflow '-PlayerPatchNotes must align exactly with -FeatureWorktrees'
    }
    $expectedBranches = @(Get-StateValue $State 'feature_branches' @())
    $expectedTips = @(Get-StateValue $State 'feature_tip_shas' @())
    $hasExpectedIdentity = $expectedBranches.Count -gt 0 -or $expectedTips.Count -gt 0
    if ($hasExpectedIdentity -and
        ($expectedBranches.Count -ne $requested.Count -or $expectedTips.Count -ne $requested.Count)) {
        Stop-Workflow 'batch admission feature refs and expected SHAs must align exactly with -FeatureWorktrees'
    }
    if ($hasExpectedIdentity -and
        @($expectedTips | Where-Object { [string]$_ -notmatch '^[0-9a-fA-F]{40}$' }).Count -gt 0) {
        Stop-Workflow 'batch admission expected feature tips must be canonical 40-character SHAs'
    }
    $paths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $branches = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $manifest = @()
    for ($requestedIndex = 0; $requestedIndex -lt $requested.Count; $requestedIndex++) {
        $requestedPath = $requested[$requestedIndex]
        $path = Get-AshAtlasCanonicalPath ([string]$requestedPath)
        if (-not $paths.Add($path)) { Stop-Workflow "duplicate feature worktree in batch: $path" }
        if (-not (Test-Path -LiteralPath $path -PathType Container)) {
            Stop-Workflow "batch feature worktree is absent: $path"
        }
        $gitRoot = Get-GitText $path @('rev-parse', '--show-toplevel')
        if (-not (Test-AshAtlasSamePath $gitRoot $path)) {
            Stop-Workflow "batch feature path is not an exact worktree root: $path"
        }
        $branch = Get-GitText $path @('branch', '--show-current')
        if ($branch -notmatch '^(feature|fix|chore|audit)/[^/].+') {
            Stop-Workflow "batch feature branch is not eligible: $branch"
        }
        if (-not $branches.Add($branch)) { Stop-Workflow "duplicate feature branch in batch: $branch" }
        if ($hasExpectedIdentity -and [string]$expectedBranches[$requestedIndex] -cne $branch) {
            Stop-Workflow "batch feature ref drift at order $($requestedIndex): expected $($expectedBranches[$requestedIndex]), found $branch"
        }
        if (-not (Test-FeatureAdmissionStatus (
                    Get-GitText $path @('status', '--porcelain')))) {
            Stop-Workflow "batch feature worktree is dirty: $path"
        }
        $tip = Get-GitCommitId $path 'HEAD'
        if ($hasExpectedIdentity -and [string]$expectedTips[$requestedIndex].ToLowerInvariant() -cne $tip) {
            Stop-Workflow "batch feature tip drift at order $($requestedIndex): expected $($expectedTips[$requestedIndex]), found $tip"
        }
        if (-not $Snapshot.heads.ContainsKey($branch)) {
            Stop-Workflow "origin/$branch is absent from the frozen batch snapshot"
        }
        $remoteTip = [string]$Snapshot.heads[$branch]
        if ($remoteTip -ne $tip) {
            Stop-Workflow "batch feature tip drift: $branch local $tip, origin $remoteTip"
        }
        $mergeBase = Get-GitText $path @('merge-base', $tip, [string]$Snapshot.integration_test_sha)
        $effectiveMatches = @($Snapshot.generations | Where-Object {
                & git -C $path merge-base --is-ancestor ([string]$_.commit_sha) $mergeBase 2>$null
                $LASTEXITCODE -eq 0
            })
        if ($effectiveMatches.Count -eq 0) {
            Stop-Workflow "feature $branch has no immutable gameplay generation in its effective ancestry"
        }
        $effective = @($effectiveMatches | Sort-Object {
                [int]([string]$_.name).Substring(6)
            })[-1]
        & git -C $path merge-base --is-ancestor ([string]$effective.commit_sha) $tip
        if ($LASTEXITCODE -ne 0) {
            Stop-Workflow "feature $branch does not descend from effective base $($effective.name)"
        }
        if ($tip -eq [string]$effective.commit_sha) {
            Stop-Workflow "feature $branch has no commit beyond effective base $($effective.name)"
        }
        & git -C $path merge-base --is-ancestor ([string]$effective.commit_sha) ([string]$Snapshot.integration_test_sha)
        if ($LASTEXITCODE -ne 0) {
            Stop-Workflow "feature $branch is incompatible with the current protected infrastructure head"
        }
        $historical = if ($branch -match '--from-(t\d{3,4})$') { $Matches[1] } else {
            [string]$effective.name.Substring(5)
        }
        $historicalMatches = @($Snapshot.generations | Where-Object name -eq "test/$historical")
        if ($historicalMatches.Count -ne 1) {
            Stop-Workflow "feature $branch names absent historical gameplay generation $historical"
        }
        $historicalBase = $historicalMatches[0]
        & git -C $path merge-base --is-ancestor ([string]$historicalBase.commit_sha) $tip
        if ($LASTEXITCODE -ne 0) {
            Stop-Workflow "feature $branch does not descend from its historical gameplay base $historical"
        }
        $changedPaths = @(
            (Get-GitText $path @('diff', '--name-only', "$mergeBase..$tip")) -split '\r?\n' |
                Where-Object { $_ }
        )
        $forbidden = @($changedPaths | Where-Object { Test-BatchForbiddenInfrastructurePath $_ })
        if ($forbidden.Count -gt 0) {
            Stop-Workflow ("gameplay batch refuses release infrastructure in {0}: {1}. " +
                'Publish that infrastructure separately.' -f $branch, ($forbidden -join ', '))
        }
        & git -C $path merge-base --is-ancestor $tip ([string]$Snapshot.integration_test_sha)
        $alreadyContained = $LASTEXITCODE -eq 0
        $manifest += [pscustomobject][ordered]@{
            order = $manifest.Count
            worktree = $path
            branch = $branch
            requested_branch = if ($hasExpectedIdentity) { [string]$expectedBranches[$requestedIndex] } else { $branch }
            requested_tip_sha = if ($hasExpectedIdentity) { [string]$expectedTips[$requestedIndex].ToLowerInvariant() } else { $tip }
            local_tip_sha = $tip
            origin_tip_sha = $remoteTip
            historical_base_generation = $historical
            historical_base_sha = [string]$historicalBase.commit_sha
            effective_base_generation = [string]$effective.name.Substring(5)
            effective_base_sha = [string]$effective.commit_sha
            source_interval_base_sha = $mergeBase
            admission_mode = [string]$AdmissionMode
            admission_command = [string]$AdmissionCommand
            display_name = Get-BatchDisplayName $branch $(if ($requested.Count -eq 1) { $DisplayName } else { '' })
            player_patch_note = [string]$notes[$requestedIndex]
            already_contained_in_protected_base = $alreadyContained
            changed_paths = $changedPaths
            source_verification = [pscustomobject][ordered]@{
                clean = $true
                exact_worktree_root = $true
                eligible_branch = $true
                exact_origin_tip = $true
                verified_at_utc = (Get-Date).ToUniversalTime().ToString('o')
            }
            verification_result = ''
            verification_receipt = $null
            merge_result = ''
            merge_commit_sha = ''
            receipt_result = ''
        }
    }
    return $manifest
}

function Assert-BatchManifestUnchanged {
    param([Parameter(Mandatory = $true)]$State)
    $refs = @($State.batch_manifest | ForEach-Object { "refs/heads/$($_.branch)" })
    $lines = Get-GitText (Get-GameRepositoryRoot) (@('ls-remote', 'origin') + $refs)
    $tips = @{}
    foreach ($line in @($lines -split '\r?\n' | Where-Object { $_ })) {
        if ($line -notmatch '^([0-9a-f]{40})\s+refs/heads/(.+)$') {
            Stop-Workflow "batch resume received malformed feature ref output: $line"
        }
        $tips[$Matches[2]] = $Matches[1]
    }
    foreach ($feature in @($State.batch_manifest)) {
        if (-not $tips.ContainsKey([string]$feature.branch) -or
            [string]$tips[[string]$feature.branch] -ne [string]$feature.origin_tip_sha) {
            Stop-Workflow "batch feature branch changed after manifest creation: $($feature.branch)"
        }
        if ((Get-GitCommitId ([string]$feature.worktree) 'HEAD') -ne
            [string]$feature.local_tip_sha) {
            Stop-Workflow "batch feature local tip changed after manifest creation: $($feature.branch)"
        }
        if (-not (Test-FeatureAdmissionStatus (
                    Get-GitText ([string]$feature.worktree) @('status', '--porcelain')))) {
            Stop-Workflow "batch feature became dirty after manifest creation: $($feature.branch)"
        }
    }
}

function Get-BatchStagingIdentity {
    param([Parameter(Mandatory = $true)]$State)
    $generation = [string]$State.latest_gameplay_generation
    $slug = "batch-release-$((Get-TextSha256 ([string]$State.operation_id)).Substring(0, 10))"
    $worktreeRoot = Join-Path (Split-Path -Parent (Get-GameRepositoryRoot)) 'worktrees'
    return [pscustomobject]@{
        path = Join-Path $worktreeRoot "$slug`__$generation"
        branch = "integration/$slug--from-$generation"
    }
}

function Initialize-BatchStagingWorktree {
    param([Parameter(Mandatory = $true)]$State)
    $identity = Get-BatchStagingIdentity $State
    if (-not $State.staging_worktree) {
        $State.staging_worktree = [IO.Path]::GetFullPath($identity.path).TrimEnd('\')
        $State.staging_branch = [string]$identity.branch
        Write-State $State
    }
    if (-not (Test-Path -LiteralPath ([string]$State.staging_worktree) -PathType Container)) {
        & git -C (Get-GameRepositoryRoot) show-ref --verify --quiet "refs/heads/$($State.staging_branch)"
        if ($LASTEXITCODE -eq 0) {
            Invoke-Git (Get-GameRepositoryRoot) @(
                'worktree', 'add', [string]$State.staging_worktree, [string]$State.staging_branch
            ) | Out-Null
        } else {
            Invoke-Git (Get-GameRepositoryRoot) @(
                'worktree', 'add', '-b', [string]$State.staging_branch,
                [string]$State.staging_worktree, [string]$State.original_integration_sha
            ) | Out-Null
        }
    }
    $gitRoot = Get-GitText ([string]$State.staging_worktree) @('rev-parse', '--show-toplevel')
    if (-not (Test-AshAtlasSamePath $gitRoot ([string]$State.staging_worktree)) -or
        (Get-GitText ([string]$State.staging_worktree) @('branch', '--show-current')) -ne
            [string]$State.staging_branch) {
        Stop-Workflow 'batch staging worktree identity changed'
    }
    if ($null -eq $State.merge_conflict -and
        (Get-GitText ([string]$State.staging_worktree) @('status', '--porcelain')) -ne '') {
        Stop-Workflow 'batch staging worktree is unexpectedly dirty'
    }
}

function Test-GitAncestor {
    param([string]$Repository, [string]$Ancestor, [string]$Descendant)
    & git -C $Repository merge-base --is-ancestor $Ancestor $Descendant 2>$null
    return $LASTEXITCODE -eq 0
}

function Assert-CanonicalSha {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value,
        [Parameter(Mandatory = $true)][string]$Label
    )
    if ($Value -cnotmatch '^[0-9a-f]{40}$') {
        Stop-Workflow "$Label is not a canonical lowercase 40-character SHA"
    }
}

function Get-BatchMergeChainProof {
    param([Parameter(Mandatory = $true)]$State)

    if (-not [bool](Get-StateValue $State 'is_batch' $false)) {
        Stop-Workflow 'batch merge-chain proof requires a batch operation'
    }
    $manifest = @($State.batch_manifest)
    $records = @($State.merge_chain)
    if ($manifest.Count -eq 0 -or $records.Count -ne $manifest.Count) {
        Stop-Workflow 'batch merge-chain record count does not exactly match the frozen manifest'
    }
    $baseline = [string](Get-StateValue $State 'original_integration_sha' '')
    Assert-CanonicalSha $baseline 'batch original integration SHA'
    Assert-CleanWorktree ([string]$State.staging_worktree) ([string]$State.staging_branch) `
        'batch staging worktree'

    $previous = $baseline
    $featureTips = @()
    $branches = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    for ($index = 0; $index -lt $manifest.Count; $index++) {
        $feature = $manifest[$index]
        $record = $records[$index]
        $expectedOrder = [int](Get-StateValue $feature 'order' $index)
        $recordOrder = [int](Get-StateValue $record 'order' -1)
        $branch = [string](Get-StateValue $feature 'branch' '')
        $recordBranch = [string](Get-StateValue $record 'branch' '')
        $tip = [string](Get-StateValue $feature 'local_tip_sha' '')
        $recordTip = [string](Get-StateValue $record 'feature_tip_sha' '')
        $recordPrevious = [string](Get-StateValue $record 'previous_candidate_sha' '')
        $note = [string](Get-StateValue $feature 'player_patch_note' '')
        $recordNote = [string](Get-StateValue $record 'player_patch_note' '')
        if ($expectedOrder -ne $index -or $recordOrder -ne $index -or
            $recordOrder -ne $expectedOrder -or -not $branch -or
            -not $branches.Add($branch) -or $recordBranch -cne $branch) {
            Stop-Workflow "batch merge-chain order or branch identity changed at manifest item $index"
        }
        Assert-CanonicalSha $tip "frozen feature tip for $branch"
        if ($recordTip -cne $tip) {
            Stop-Workflow "batch merge-chain feature tip changed at $branch"
        }
        Assert-CanonicalSha $recordPrevious "previous candidate for $branch"
        if ($recordPrevious -cne $previous -or $recordNote -cne $note) {
            Stop-Workflow "batch merge-chain previous candidate or patch note changed at $branch"
        }
        $skippedValue = Get-StateValue $record 'skipped' $null
        if ($skippedValue -isnot [bool]) {
            Stop-Workflow "batch merge-chain skipped flag is not boolean at $branch"
        }
        $skipped = [bool]$skippedValue
        $merge = [string](Get-StateValue $record 'merge_commit_sha' '')
        if ($skipped) {
            if ($merge) { Stop-Workflow "skipped batch merge unexpectedly has a merge commit at $branch" }
            if (-not (Test-GitAncestor ([string]$State.staging_worktree) $tip $previous)) {
                Stop-Workflow "skipped batch feature is not contained by candidate: $branch"
            }
        } else {
            Assert-CanonicalSha $merge "merge commit for $branch"
            $parents = Get-GitFields ([string]$State.staging_worktree) @(
                'show', '-s', '--format=%P', $merge
            )
            if (-not (Test-ExactMergeParents $parents $previous $tip)) {
                Stop-Workflow "batch merge-chain parentage changed at $branch"
            }
            Assert-CommitPlayerPatchNote ([string]$State.staging_worktree) $merge $note
            if (-not (Test-GitAncestor ([string]$State.staging_worktree) $tip $merge)) {
                Stop-Workflow "batch merge-chain merge does not contain its frozen feature tip at $branch"
            }
            $previous = $merge
        }
        $featureTips += $tip
    }

    $head = Get-GitCommitId ([string]$State.staging_worktree) 'HEAD'
    Assert-CanonicalSha $head 'batch staging HEAD'
    if ($head -cne $previous) {
        Stop-Workflow 'batch staging HEAD differs from the final ordered merge-chain entry'
    }
    foreach ($tip in $featureTips) {
        if (-not (Test-GitAncestor ([string]$State.staging_worktree) $tip $head)) {
            Stop-Workflow "frozen feature tip $tip is not an ancestor of the batch staging HEAD"
        }
    }
    if ((Get-GitText ([string]$State.staging_worktree) @('status', '--porcelain')) -ne '') {
        Stop-Workflow 'batch staging worktree differs from the exact frozen candidate'
    }
    return [pscustomobject][ordered]@{
        staging_head_sha = $head
        final_merge_chain_sha = $previous
        record_count = $records.Count
        feature_count = $manifest.Count
        ordered = $true
        frozen_feature_tips = @($featureTips)
        all_frozen_feature_tips_ancestors = $true
        merge_chain_json_sha256 = Get-TextSha256 (
            (ConvertTo-Json -InputObject @($records) -Depth 12 -Compress)
        )
    }
}

function Assert-BatchMergeChain {
    param([Parameter(Mandatory = $true)]$State)
    $proof = Get-BatchMergeChainProof $State
    Assert-CanonicalSha ([string](Get-StateValue $State 'final_candidate_sha' '')) `
        'recorded batch final candidate SHA'
    Assert-CanonicalSha ([string](Get-StateValue $State 'candidate_integration_sha' '')) `
        'recorded batch integration candidate SHA'
    if ([string]$proof.final_merge_chain_sha -ne [string]$State.final_candidate_sha -or
        [string]$proof.staging_head_sha -ne [string]$State.candidate_integration_sha) {
        Stop-Workflow 'batch final candidate differs from the frozen ordered merge chain'
    }
}

function Invoke-BatchMergeChain {
    param([Parameter(Mandatory = $true)]$State)
    Initialize-BatchStagingWorktree $State
    $candidate = [string]$State.original_integration_sha
    $records = @($State.merge_chain)
    foreach ($feature in @($State.batch_manifest)) {
        $existing = @($records | Where-Object branch -eq [string]$feature.branch)
        if ($existing.Count -eq 1) {
            if ([string]$existing[0].previous_candidate_sha -ne $candidate) {
                Stop-Workflow "stored batch merge order changed at $($feature.branch)"
            }
            if (-not [bool]$existing[0].skipped) { $candidate = [string]$existing[0].merge_commit_sha }
            continue
        }
        $tip = [string]$feature.local_tip_sha
        $head = Get-GitCommitId ([string]$State.staging_worktree) 'HEAD'
        $manuallyResolved = $false
        if ($head -ne $candidate) {
            $headParents = Get-GitFields ([string]$State.staging_worktree) @(
                'show', '-s', '--format=%P', $head
            )
            if (-not (Test-ExactMergeParents $headParents $candidate $tip)) {
                Stop-Workflow "batch staging HEAD changed outside the frozen merge chain before $($feature.branch)"
            }
            $manuallyResolved = $true
            Require-CandidateAdmission $State "batch merge for $($feature.branch) was resolved outside the automatic merge command"
            if ($null -ne $State.merge_conflict -and -not $ConfirmConflictResolution) {
                Stop-Workflow "resolved conflict for $($feature.branch) requires -ConfirmConflictResolution on Resume"
            }
        }
        if (-not $manuallyResolved -and
            (Test-GitAncestor ([string]$State.staging_worktree) $tip $candidate)) {
            $record = [pscustomobject][ordered]@{
                order = [int]$feature.order
                branch = [string]$feature.branch
                feature_tip_sha = $tip
                previous_candidate_sha = $candidate
                merge_commit_sha = ''
                skipped = $true
                duration_ms = 0
                player_patch_note = [string]$feature.player_patch_note
            }
            $feature.merge_result = 'already contained; skipped'
        } else {
            $duration = 0
            $mergeHeadPath = Join-Path (Get-GitText ([string]$State.staging_worktree) @('rev-parse', '--git-dir')) 'MERGE_HEAD'
            $unmerged = Get-GitText ([string]$State.staging_worktree) @('diff', '--name-only', '--diff-filter=U')
            if ($unmerged) {
                Stop-Workflow "batch merge conflict remains unresolved for $($feature.branch): $($unmerged -replace '\r?\n', ', ')"
            }
            if ($manuallyResolved) {
                $merged = $head
            } elseif (Test-Path -LiteralPath $mergeHeadPath) {
                if (-not $ConfirmConflictResolution) {
                    Stop-Workflow "resolved conflict for $($feature.branch) requires -ConfirmConflictResolution on Resume"
                }
                Require-CandidateAdmission $State "batch merge for $($feature.branch) was resumed from an interrupted conflict"
                $mergeHead = (Get-Content -Raw -LiteralPath $mergeHeadPath).Trim()
                if ($mergeHead -ne $tip) { Stop-Workflow 'resolved conflict MERGE_HEAD differs from frozen feature tip' }
                Invoke-Git ([string]$State.staging_worktree) @(
                    'commit', '-m', (Get-IntegrationMergeMessage `
                        "Merge $($feature.branch) into batch release (resolved)" `
                        ([string]$feature.player_patch_note))
                ) | Out-Null
            } else {
                $started = Get-Date
                $mergeOutput = @(& git -C ([string]$State.staging_worktree) merge --no-ff `
                    -m (Get-IntegrationMergeMessage `
                        "Merge $($feature.branch) into batch release" `
                        ([string]$feature.player_patch_note)) $tip 2>&1)
                $mergeExitCode = $LASTEXITCODE
                if ($mergeExitCode -ne 0) {
                    $conflicts = Get-GitText ([string]$State.staging_worktree) @(
                        'diff', '--name-only', '--diff-filter=U'
                    )
                    $State.merge_conflict = [pscustomobject]@{
                        feature_order = [int]$feature.order
                        branch = [string]$feature.branch
                        feature_tip_sha = $tip
                        paths = @($conflicts -split '\r?\n' | Where-Object { $_ })
                    }
                    Write-State $State
                    $diagnostic = ($mergeOutput -join [Environment]::NewLine).Trim()
                    if ($diagnostic) {
                        Stop-Workflow "batch merge conflict in $($feature.branch): $($conflicts -replace '\r?\n', ', ') ($diagnostic)"
                    }
                    Stop-Workflow "batch merge conflict in $($feature.branch): $($conflicts -replace '\r?\n', ', ')"
                }
                $duration = [math]::Round(((Get-Date) - $started).TotalMilliseconds)
            }
            if (-not $manuallyResolved) {
                $merged = Get-GitCommitId ([string]$State.staging_worktree) 'HEAD'
            }
            $parents = Get-GitFields ([string]$State.staging_worktree) @('show', '-s', '--format=%P', $merged)
            if (-not (Test-ExactMergeParents $parents $candidate $tip)) {
                Stop-Workflow "batch merge for $($feature.branch) does not have exact ordered parents"
            }
            if (-not (Test-GitAncestor ([string]$State.staging_worktree) $tip $merged)) {
                Stop-Workflow "batch merge for $($feature.branch) does not contain its frozen feature tip"
            }
            Assert-CommitPlayerPatchNote ([string]$State.staging_worktree) $merged `
                ([string]$feature.player_patch_note)
            $record = [pscustomobject][ordered]@{
                order = [int]$feature.order
                branch = [string]$feature.branch
                feature_tip_sha = $tip
                previous_candidate_sha = $candidate
                merge_commit_sha = $merged
                skipped = $false
                duration_ms = [long]$duration
                player_patch_note = [string]$feature.player_patch_note
            }
            $candidate = $merged
            $feature.merge_result = "merged as $merged"
        }
        $records += $record
        $State.merge_chain = $records
        $State.merge_conflict = $null
        Write-State $State
    }
    Get-BatchMergeChainProof $State | Out-Null
    return [string]$candidate
}

function Get-BatchImpactClassification {
    param([Parameter(Mandatory = $true)][string[]]$Paths)
    $has = {
        param([string]$Pattern)
        return @($Paths | Where-Object { $_ -match $Pattern }).Count -gt 0
    }
    # Text-only classification is intentionally restricted to data/document extensions and
    # explicit content directories. Executable source files may contain words such as
    # "content" in their names and must retain the runtime gate.
    $clientTextPathPatterns = @(
        '^apps/client/(?:.*\.(?:md|mdx|txt|po|pot)|public/.*\.(?:txt|md|html))$',
        '^apps/client/(?:src/)?(?:content|i18n|locale|locales|translation|translations)/.+\.json$',
        '^apps/client/(?:src/)?(?:.+/)?(?:copy|content|i18n|locale|locales|translation|translations)[^/]*\.json$'
    )
    $serverTextPathPatterns = @(
        '^apps/server/.*\.(?:md|mdx|txt|po|pot)$',
        '^apps/server/(?:src/)?(?:content|i18n|locale|locales|translation|translations)/.+\.json$',
        '^apps/server/(?:src/)?(?:.+/)?(?:copy|content|i18n|locale|locales|translation|translations)[^/]*\.json$'
    )
    $isTextOnlyPath = {
        param([string]$Path, [string[]]$Patterns)
        foreach ($pattern in $Patterns) {
            if ($Path -match $pattern) { return $true }
        }
        return $false
    }
    $clientPaths = @($Paths | Where-Object { $_ -match '^apps/client/' })
    $serverPaths = @($Paths | Where-Object { $_ -match '^apps/server/' })
    $clientTextOnly = $clientPaths.Count -gt 0 -and
        @($clientPaths | Where-Object { -not (& $isTextOnlyPath $_ $clientTextPathPatterns) }).Count -eq 0
    $serverTextOnly = $serverPaths.Count -gt 0 -and
        @($serverPaths | Where-Object { -not (& $isTextOnlyPath $_ $serverTextPathPatterns) }).Count -eq 0
    $classification = [ordered]@{
        client = & $has '^apps/client/'
        client_text_only = $clientTextOnly
        client_runtime = ((& $has '^apps/client/') -and (-not $clientTextOnly))
        server = & $has '^apps/server/'
        server_text_only = $serverTextOnly
        server_runtime = ((& $has '^apps/server/') -and (-not $serverTextOnly))
        shared_protocol = & $has '^packages/shared/'
        database_migrations = & $has '^(?:db/|apps/server/src/db/)'
        population_world = & $has '^(?:(?:apps/(?:client|server)|packages/shared)/.*(?:population|flag)|config/world|packages/world)'
        combat = & $has '^(?:apps/(?:client|server)|packages/shared)/.*combat'
        inventory_economy = & $has '^(?:apps/(?:client|server)|packages/shared)/.*(?:inventory|market|economy|reward|currency|xp)'
        movement_travel_connectivity = & $has '^(?:apps/(?:client|server)|packages/shared)/.*(?:movement|travel|websocket|connect)'
        ui_assets = & $has '^(?:apps/client/src|apps/client/public)/'
        documentation_only = $false
        release_infrastructure = @($Paths | Where-Object { Test-BatchForbiddenInfrastructurePath $_ }).Count -gt 0
        dependencies_toolchain = & $has '^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|.*/package\.json|tsconfig|vite|eslint)'
    }
    $nonDocumentation = @($Paths | Where-Object { $_ -notmatch '^(?:docs/|README(?:\.md)?$|.*\.md$)' })
    $classification.documentation_only = $Paths.Count -gt 0 -and $nonDocumentation.Count -eq 0
    return [pscustomobject]$classification
}

function New-BatchGate {
    param(
        [string]$Name,
        [string]$FilePath,
        [string[]]$Arguments,
        [bool]$Parallel = $true,
        [int]$DeadlineSeconds = 1800,
        [string]$Kind = 'native',
        [string]$WorkingDirectory = '',
        [string]$BindingSha = '',
        [bool]$BaselineComparable = $false
    )
    return [pscustomobject][ordered]@{
        name = $Name
        kind = $Kind
        file_path = $FilePath
        arguments = @($Arguments)
        parallel = $Parallel
        deadline_seconds = $DeadlineSeconds
        working_directory = $WorkingDirectory
        binding_sha = $BindingSha
        baseline_comparable = $BaselineComparable
    }
}

function Get-BatchValidationPlan {
    param([Parameter(Mandatory = $true)]$State)
    $changedEntries = @(Get-BatchChangedPathEntries `
        ([string]$State.staging_worktree) `
        ([string]$State.original_integration_sha) `
        ([string]$State.final_candidate_sha))
    $paths = @(
        foreach ($entry in $changedEntries) {
            if ([string]$entry.status_code -in @('R', 'C')) {
                [string]$entry.old_path
            }
            [string]$entry.path
        }
    )
    if ($paths.Count -eq 0) {
        Stop-Workflow 'batch candidate has no effective file changes; refusing a no-op production release'
    }
    $impact = Get-BatchImpactClassification $paths
    if ($impact.release_infrastructure) {
        Stop-Workflow 'gameplay batch candidate contains release infrastructure after local merge'
    }
    if ($impact.documentation_only) {
        Stop-Workflow 'documentation-only batches are not eligible for production deployment'
    }
    $requiresWorkspaceInstall = [bool]$impact.dependencies_toolchain -or
        [bool]$impact.database_migrations -or [bool]$impact.shared_protocol -or
        [bool]$impact.client_runtime -or [bool]$impact.server_runtime
    $gates = @(
        (New-BatchGate 'git_diff_check' 'git' @(
                'diff', '--check', [string]$State.original_integration_sha, [string]$State.final_candidate_sha
            )),
        (New-BatchGate 'repository_hygiene' 'pnpm.cmd' @('check:hygiene'))
    )
    if ($requiresWorkspaceInstall) {
        $gates = @(
            (New-BatchGate 'workspace_install' 'pnpm.cmd' @(
                    'install', '--frozen-lockfile'
                ) $false 1800 'install')
        ) + $gates
    }
    if ([bool](Get-StateValue $State 'candidate_admission_required' $false)) {
        if ([string](Get-StateValue $State 'admission_mode' '') -ne 'Command') {
            Stop-Workflow 'conflict-resolved or interrupted batch merge requires Command admission on the final candidate'
        }
        $candidateAdmissionCommand = [string](Get-StateValue $State 'admission_command' '')
        if (-not $candidateAdmissionCommand) {
            Stop-Workflow 'conflict-resolved or interrupted batch merge has no candidate admission command'
        }
        $candidateGate = New-BatchGate 'focused_candidate_admission' 'powershell.exe' @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $candidateAdmissionCommand
        ) $false 1800 'native' ([string]$State.staging_worktree) ([string]$State.final_candidate_sha)
        $gates = @($candidateGate) + $gates
    }
    $lintPaths = @(
        foreach ($entry in $changedEntries) {
            $path = [string]$entry.path
            if ([bool]$entry.deleted -or $path -notmatch '\.(?:[cm]?[jt]sx?)$') { continue }
            if (Test-Path -LiteralPath (Join-Path ([string]$State.staging_worktree) $path) -PathType Leaf) {
                $path
            }
        }
    )
    if ($lintPaths.Count -gt 0) {
        $gates += New-BatchGate 'changed_file_lint' 'pnpm.cmd' (@('exec', 'eslint', '--') + $lintPaths)
    }
    if ($impact.client_runtime) {
        $gates += New-BatchGate 'client_affected_tests' 'pnpm.cmd' @(
            '--filter', '@ash-atlas/client', 'test'
        )
    }
    if ($impact.server_runtime -or $impact.database_migrations) {
        $gates += New-BatchGate 'server_affected_tests' 'pnpm.cmd' @(
            '--filter', '@ash-atlas/server', 'test'
        )
    }
    if ($impact.shared_protocol) {
        $gates += New-BatchGate 'shared_affected_tests' 'pnpm.cmd' @(
            '--filter', '@ash-atlas/shared', 'test'
        )
    }
    if ($impact.client_runtime -or $impact.shared_protocol) {
        $gates += New-BatchGate 'client_typecheck' 'pnpm.cmd' @(
            '--filter', '@ash-atlas/client', 'typecheck'
        ) -BaselineComparable $true
    }
    if ($impact.server_runtime -or $impact.database_migrations -or $impact.shared_protocol) {
        $gates += New-BatchGate 'server_typecheck' 'pnpm.cmd' @(
            '--filter', '@ash-atlas/server', 'typecheck'
        ) -BaselineComparable $true
    }
    if ($impact.shared_protocol) {
        $gates += New-BatchGate 'shared_typecheck' 'pnpm.cmd' @(
            '--filter', '@ash-atlas/shared', 'typecheck'
        ) -BaselineComparable $true
    }
    if ($impact.database_migrations) {
        $gates += New-BatchGate 'disposable_postgres_matrix' 'pnpm.cmd' @('test:postgres') $false 3600
    }
    if ($impact.client_runtime -or $impact.shared_protocol) {
        $gates += New-BatchGate 'client_production_build' 'pnpm.cmd' @('--filter', '@ash-atlas/client', 'build') $false 1800
    }
    if ($impact.server_runtime -or $impact.database_migrations -or $impact.shared_protocol) {
        $gates += New-BatchGate 'server_production_build' 'pnpm.cmd' @('--filter', '@ash-atlas/server', 'build') $false 1800
        $gates += New-BatchGate 'server_build_verify' 'pnpm.cmd' @('--filter', '@ash-atlas/server', 'build:verify') $false 600
    }
    $runtimeChanged = $impact.population_world -or $impact.combat -or
        $impact.inventory_economy -or $impact.movement_travel_connectivity
    if ($runtimeChanged) {
        $gates += New-BatchGate 'combined_disposable_browser_acceptance' 'internal' @(
            'Invoke-BatchBrowserAcceptance:v1'
        ) $false 1800 'browser'
    }
    $plan = [pscustomobject][ordered]@{
        candidate_sha = [string]$State.final_candidate_sha
        changed_paths = $paths
        impact = $impact
        gates = $gates
        skips = [pscustomobject][ordered]@{
            postgres = -not [bool]$impact.database_migrations
            release_infrastructure_suites = $true
            repeated_feature_suites = $true
        }
    }
    return $plan
}

function Get-BatchToolchainFingerprint {
    param([Parameter(Mandatory = $true)]$State)
    $inputs = @(
        (Get-GitText ([string]$State.staging_worktree) @('show', "$($State.final_candidate_sha):package.json")),
        (Get-GitText ([string]$State.staging_worktree) @('show', "$($State.final_candidate_sha):pnpm-lock.yaml")),
        (& node --version),
        (& pnpm --version)
    ) -join "`n"
    return Get-TextSha256 $inputs
}

function Get-BatchValidationPlanFingerprint {
    param([Parameter(Mandatory = $true)]$Plan, [Parameter(Mandatory = $true)][string]$ToolchainFingerprint)
    $commands = @($Plan.gates | ForEach-Object {
        "$($_.name)|$($_.kind)|$($_.file_path)|$(@($_.arguments) -join [char]0x1f)|$($_.parallel)|$($_.deadline_seconds)|$($_.baseline_comparable)"
    })
    return Get-TextSha256 ((@([string]$Plan.candidate_sha, $ToolchainFingerprint) + $commands) -join "`n")
}

function Start-BatchGateProcess {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)]$Gate
    )
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = [string]$Gate.file_path
    $startInfo.Arguments = (@($Gate.arguments | ForEach-Object {
                ConvertTo-NativeCommandArgument ([string]$_)
            }) -join ' ')
    $startInfo.WorkingDirectory = if ([string]$Gate.working_directory) {
        [string]$Gate.working_directory
    } else { [string]$State.staging_worktree }
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    $admissionSha = if ([string]$Gate.binding_sha -and
        [string]$Gate.name -match 'admission') { [string]$Gate.binding_sha } else { '' }
    $oldAdmissionSha = $env:ASH_ATLAS_ADMISSION_SHA
    $oldAdmissionCwd = $env:ASH_ATLAS_ADMISSION_CWD
    try {
        if ($admissionSha) { $env:ASH_ATLAS_ADMISSION_SHA = $admissionSha }
        if ([string]$Gate.working_directory -and [string]$Gate.name -match 'admission') {
            $env:ASH_ATLAS_ADMISSION_CWD = [string]$Gate.working_directory
        }
        if (-not $process.Start()) { Stop-Workflow "could not start validation gate $($Gate.name)" }
    } finally {
        if ($null -eq $oldAdmissionSha) { Remove-Item Env:\ASH_ATLAS_ADMISSION_SHA -ErrorAction SilentlyContinue }
        else { $env:ASH_ATLAS_ADMISSION_SHA = $oldAdmissionSha }
        if ($null -eq $oldAdmissionCwd) { Remove-Item Env:\ASH_ATLAS_ADMISSION_CWD -ErrorAction SilentlyContinue }
        else { $env:ASH_ATLAS_ADMISSION_CWD = $oldAdmissionCwd }
    }
    return [pscustomobject]@{
        gate = $Gate
        process = $process
        stdout = $process.StandardOutput.ReadToEndAsync()
        stderr = $process.StandardError.ReadToEndAsync()
        started = Get-Date
    }
}

function Stop-BatchGateWorkers {
    param([object[]]$Workers)
    foreach ($worker in @($Workers)) {
        if ($null -ne $worker.process) {
            if (-not $worker.process.HasExited) { [void](Stop-NativeProcessTree $worker.process) }
            try { $worker.process.Dispose() } catch { }
        }
    }
}

function Complete-BatchGateProcesses {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][object[]]$Workers,
        [string]$LastCompleted = '',
        [string]$PhaseName = 'final_validation',
        [switch]$AllowFailure
    )
    $pending = @($Workers)
    $lastHeartbeat = Get-Date
    $receipts = @()
    while ($pending.Count -gt 0) {
        foreach ($worker in @($pending)) {
            $elapsed = ((Get-Date) - $worker.started).TotalSeconds
            if (-not $worker.process.HasExited -and $elapsed -gt [int]$worker.gate.deadline_seconds) {
                Stop-BatchGateWorkers $pending
                Stop-Workflow "validation gate $($worker.gate.name) exceeded its hard deadline"
            }
            if ($worker.process.HasExited) {
                $worker.process.WaitForExit()
                $finished = Get-Date
                $stdout = [string]$worker.stdout.Result
                $stderr = [string]$worker.stderr.Result
                $logBase = Join-Path $StateRoot "$($State.operation_id).validation.$($worker.gate.name)"
                $stdout | Set-Content -LiteralPath "$logBase.stdout.log" -Encoding utf8
                $stderr | Set-Content -LiteralPath "$logBase.stderr.log" -Encoding utf8
                $receipt = [pscustomobject][ordered]@{
                    name = [string]$worker.gate.name
                    candidate_sha = $(if ([string]$worker.gate.binding_sha) {
                            [string]$worker.gate.binding_sha
                        } else { [string]$State.final_candidate_sha })
                    command = "$($worker.gate.file_path) $(@($worker.gate.arguments) -join ' ')"
                    working_directory = if ([string]$worker.gate.working_directory) {
                        [string]$worker.gate.working_directory
                    } else { [string]$State.staging_worktree }
                    exit_code = [int]$worker.process.ExitCode
                    duration_ms = [math]::Round(($finished - $worker.started).TotalMilliseconds)
                    stdout_log = "$logBase.stdout.log"
                    stderr_log = "$logBase.stderr.log"
                    completed_at_utc = $finished.ToUniversalTime().ToString('o')
                }
                $receipts += $receipt
                $lastCompleted = [string]$worker.gate.name
                $pending = @($pending | Where-Object { $_ -ne $worker })
                $worker.process.Dispose()
                if ($receipt.exit_code -ne 0 -and -not $AllowFailure) {
                    Stop-BatchGateWorkers $pending
                    Stop-Workflow "validation gate $($receipt.name) failed with exit code $($receipt.exit_code)"
                }
            }
        }
        if ($pending.Count -gt 0 -and ((Get-Date) - $lastHeartbeat).TotalSeconds -ge 30) {
            $active = @($pending | ForEach-Object { [string]$_.gate.name }) -join ', '
            $elapsed = [math]::Round(((Get-Date) - @($pending)[0].started).TotalSeconds)
            Write-Host "[$PhaseName] active=$active elapsed=${elapsed}s last_completed=$lastCompleted"
            $State.active_validation_gate = $active
            Write-State $State
            $lastHeartbeat = Get-Date
        }
        if ($pending.Count -gt 0) { Start-Sleep -Milliseconds 250 }
    }
    return $receipts
}

function ConvertTo-NormalizedGateDiagnostics {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text,
        [Parameter(Mandatory = $true)][string[]]$WorktreePaths
    )
    $normalized = [regex]::Replace($Text, "$([char]27)\[[0-?]*[ -/]*[@-~]", '')
    foreach ($path in @($WorktreePaths | Where-Object { $_ })) {
        foreach ($form in @($path, $path.Replace('\', '/'))) {
            $normalized = [regex]::Replace(
                $normalized, [regex]::Escape($form), '<worktree>',
                [Text.RegularExpressions.RegexOptions]::IgnoreCase)
        }
    }
    $normalized = $normalized.Replace('\', '/')
    return (@($normalized.Replace("`r`n", "`n").Replace("`r", "`n") -split "`n" |
            ForEach-Object { $_.TrimEnd() }) -join "`n").Trim()
}

function Resolve-UnchangedBaselineGateFailure {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)]$Gate,
        [Parameter(Mandatory = $true)]$CandidateReceipt
    )
    if (-not [bool]$Gate.baseline_comparable) {
        Stop-Workflow "validation gate $($CandidateReceipt.name) failed with exit code $($CandidateReceipt.exit_code)"
    }
    if ((Get-GitCommitId $IntegrationWorktree 'HEAD') -ne [string]$State.original_integration_sha -or
        (Get-GitText $IntegrationWorktree @('status', '--porcelain'))) {
        Stop-Workflow 'cannot compare a failed candidate gate because the protected baseline worktree is not clean at the recorded baseline SHA'
    }
    if ($null -eq $State.baseline_workspace_install_receipt) {
        $install = New-BatchGate 'baseline_workspace_install' 'pnpm.cmd' @(
            'install', '--frozen-lockfile'
        ) $false 1800 'install' $IntegrationWorktree ([string]$State.original_integration_sha)
        $State.baseline_workspace_install_receipt = @(
            Complete-BatchGateProcesses $State @((Start-BatchGateProcess $State $install))
        )[0]
        Write-State $State
    }
    $baselineGate = New-BatchGate -Name "baseline_$($Gate.name)" `
        -FilePath ([string]$Gate.file_path) -Arguments @($Gate.arguments) -Parallel $false `
        -DeadlineSeconds ([int]$Gate.deadline_seconds) -Kind ([string]$Gate.kind) `
        -WorkingDirectory $IntegrationWorktree -BindingSha ([string]$State.original_integration_sha)
    $baselineReceipt = @(
        Complete-BatchGateProcesses $State @((Start-BatchGateProcess $State $baselineGate)) `
            -PhaseName 'baseline_comparison' -AllowFailure
    )[0]
    $State.baseline_validation_receipts = @($State.baseline_validation_receipts) + $baselineReceipt
    if ([int]$baselineReceipt.exit_code -eq 0) {
        Write-State $State
        Stop-Workflow "validation gate $($Gate.name) is a new candidate failure; the exact baseline passes"
    }
    $candidateDiagnostics = ConvertTo-NormalizedGateDiagnostics -Text (
        (Get-Content -Raw -LiteralPath $CandidateReceipt.stdout_log) + "`n" +
        (Get-Content -Raw -LiteralPath $CandidateReceipt.stderr_log)
    ) -WorktreePaths @([string]$State.staging_worktree, $IntegrationWorktree)
    $baselineDiagnostics = ConvertTo-NormalizedGateDiagnostics -Text (
        (Get-Content -Raw -LiteralPath $baselineReceipt.stdout_log) + "`n" +
        (Get-Content -Raw -LiteralPath $baselineReceipt.stderr_log)
    ) -WorktreePaths @($IntegrationWorktree, [string]$State.staging_worktree)
    if ($candidateDiagnostics -cne $baselineDiagnostics) {
        Write-State $State
        Stop-Workflow "validation gate $($Gate.name) has diagnostics that differ from the failing baseline"
    }
    Set-StateValue $CandidateReceipt 'candidate_exit_code' ([int]$CandidateReceipt.exit_code)
    Set-StateValue $CandidateReceipt 'exit_code' 0
    Set-StateValue $CandidateReceipt 'result' 'accepted_unchanged_baseline_failure'
    Set-StateValue $CandidateReceipt 'baseline_sha' ([string]$State.original_integration_sha)
    Set-StateValue $CandidateReceipt 'baseline_receipt' $baselineReceipt
    Write-Host "[batch_final_validation] accepted unchanged baseline failure: $($Gate.name)"
    Write-State $State
    return $CandidateReceipt
}

function Invoke-BatchBrowserAcceptance {
    param([Parameter(Mandatory = $true)]$State)
    $featureRuntime = Join-Path $RepositoryRoot 'tools\dev\feature-runtime.ps1'
    $runMain = Join-Path $RepositoryRoot 'tools\dev\run-main.ps1'
    $display = "Batch Release $($State.operation_id)"
    $quote = {
        param([string]$Value)
        return "'" + $Value.Replace("'", "''") + "'"
    }
    $featureRuntimeLiteral = & $quote $featureRuntime
    $runMainLiteral = & $quote $runMain
    $worktreeLiteral = & $quote ([string]$State.staging_worktree)
    $displayLiteral = & $quote $display
    $command = @(
        '$ErrorActionPreference = ''Stop'''
        "`$featureRuntime = $featureRuntimeLiteral"
        "`$runMain = $runMainLiteral"
        "`$worktree = $worktreeLiteral"
        "`$display = $displayLiteral"
        '$registered = $false'
        'try {'
        '& powershell -NoProfile -ExecutionPolicy Bypass -File $featureRuntime create -WorktreePath $worktree -DisplayName $display'
        'if ($LASTEXITCODE -ne 0) { throw ''could not register the disposable batch runtime'' }'
        '$registered = $true'
        '$validated = @(& powershell -NoProfile -ExecutionPolicy Bypass -File $runMain -RuntimeMode Feature -WorktreePath $worktree -ValidateOnly 2>&1)'
        'if ($LASTEXITCODE -ne 0) { throw "batch runtime validation failed: $($validated -join [Environment]::NewLine)" }'
        '$runtime = ($validated -join [Environment]::NewLine) | ConvertFrom-Json'
        '  try {'
        '    & powershell -NoProfile -ExecutionPolicy Bypass -File $runMain -RuntimeMode Feature -WorktreePath $worktree -NoBrowser'
        '    if ($LASTEXITCODE -ne 0) { throw ''disposable batch runtime failed to start'' }'
        '    $env:ASH_ATLAS_TEST_BASE_URL = "http://127.0.0.1:$($runtime.ports.frontend)"'
        '    & pnpm.cmd --dir $worktree --filter ''@ash-atlas/client'' test:full-app'
        '    if ($LASTEXITCODE -ne 0) { throw ''combined disposable browser acceptance failed'' }'
        '  } finally {'
        '    Remove-Item Env:\ASH_ATLAS_TEST_BASE_URL -ErrorAction SilentlyContinue'
        '    & powershell -NoProfile -ExecutionPolicy Bypass -File $runMain -RuntimeMode Feature -WorktreePath $worktree -Stop'
        '  }'
        '} finally {'
        '  if ($registered) {'
        '    & powershell -NoProfile -ExecutionPolicy Bypass -File $featureRuntime remove -WorktreePath $worktree'
        '    if ($LASTEXITCODE -ne 0) { throw ''could not remove the disposable batch runtime'' }'
        '  }'
        '}'
    ) -join '; '
    $gate = New-BatchGate 'combined_disposable_browser_acceptance' 'powershell.exe' @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $command
    ) $false 1800 'native'
    $receipt = @(Complete-BatchGateProcesses $State @((Start-BatchGateProcess $State $gate)))[0]
    $receipt.command = 'internal Invoke-BatchBrowserAcceptance:v1'
    return $receipt
}

function Invoke-BatchFeatureVerification {
    param([Parameter(Mandatory = $true)]$State)
    foreach ($feature in @($State.batch_manifest)) {
        if ($feature.verification_result) { continue }
        if ([string]$feature.admission_mode -eq 'PreservedExactFeatureVerification') {
            $feature.verification_result = "reused exact-tip verification@$($feature.local_tip_sha)"
            $feature.verification_receipt = [pscustomobject][ordered]@{
                mode = 'PreservedExactFeatureVerification'
                feature_sha = [string]$feature.local_tip_sha
                reused = $true
                completed_at_utc = (Get-Date).ToUniversalTime().ToString('o')
            }
            $State.validations_reused = [int]$State.validations_reused + 1
        } else {
            if (-not $feature.admission_command) {
                Stop-Workflow "feature $($feature.branch) selected Command admission without a command"
            }
            $oldSha = $env:ASH_ATLAS_ADMISSION_SHA
            try {
                $env:ASH_ATLAS_ADMISSION_SHA = [string]$feature.local_tip_sha
                $gate = New-BatchGate "feature_admission_$($feature.order)" 'powershell.exe' @(
                    '-NoProfile', '-ExecutionPolicy', 'Bypass',
                    '-Command', [string]$feature.admission_command
                ) $false 1800 'native' ([string]$feature.worktree) ([string]$feature.local_tip_sha)
                $State.active_validation_gate = [string]$gate.name
                Write-State $State
                $receipt = @(Complete-BatchGateProcesses $State @(
                        (Start-BatchGateProcess $State $gate)
                    ) -PhaseName 'batch_exact_feature_verification')[0]
            } finally {
                $env:ASH_ATLAS_ADMISSION_SHA = $oldSha
            }
            $feature.verification_result = "focused command passed@$($feature.local_tip_sha)"
            $feature.verification_receipt = $receipt
            $State.validations_executed = [int]$State.validations_executed + 1
        }
        Write-State $State
    }
    $State.active_validation_gate = ''
    Write-State $State
}

function Assert-BatchValidationReceiptsComplete {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)]$Plan
    )
    $receipts = @($State.validation_receipts)
    if ($receipts.Count -ne @($Plan.gates).Count) {
        Stop-Workflow 'completed final validation has an incomplete gate receipt set'
    }
    foreach ($gate in @($Plan.gates)) {
        $matches = @($receipts | Where-Object name -eq [string]$gate.name)
        if ($matches.Count -ne 1 -or
            -not (Test-BatchGateReceiptReusable $State $gate $matches[0])) {
            Stop-Workflow "completed final validation receipt is invalid for $($gate.name)"
        }
    }
}

function Test-BatchGateReceiptReusable {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)]$Gate,
        [Parameter(Mandatory = $true)]$Receipt
    )
    $expectedCommand = "$($Gate.file_path) $(@($Gate.arguments) -join ' ')"
    if ([string]$Receipt.name -ne [string]$Gate.name -or
        [string]$Receipt.candidate_sha -ne [string]$State.final_candidate_sha -or
        [string]$Receipt.command -ne $expectedCommand -or
        [int]$Receipt.exit_code -ne 0) {
        return $false
    }
    foreach ($logProperty in @('stdout_log', 'stderr_log')) {
        $logPath = [string]$Receipt.$logProperty
        if (-not $logPath -or -not (Test-Path -LiteralPath $logPath -PathType Leaf)) {
            return $false
        }
    }
    return $true
}

function Invoke-BatchFinalValidation {
    param([Parameter(Mandatory = $true)]$State)
    $plan = Get-BatchValidationPlan $State
    $toolchain = Get-BatchToolchainFingerprint $State
    $fingerprint = Get-BatchValidationPlanFingerprint $plan $toolchain
    if ($State.validation_plan_fingerprint -and
        ([string]$State.validation_plan_fingerprint -ne $fingerprint -or
         [string]$State.validation_toolchain_fingerprint -ne $toolchain)) {
        Stop-Workflow 'stored final validation receipt differs from candidate, commands, or toolchain'
    }
    $State.final_validation_plan = $plan
    $State.validation_plan_fingerprint = $fingerprint
    $State.validation_toolchain_fingerprint = $toolchain
    Write-State $State
    Write-Host ("Final validation plan: {0}" -f ($plan | ConvertTo-Json -Depth 8 -Compress))

    $receipts = @($State.validation_receipts)
    $pendingGates = @()
    foreach ($gate in @($plan.gates)) {
        $existing = @($receipts | Where-Object name -eq [string]$gate.name)
        if ($existing.Count -eq 1 -and (Test-BatchGateReceiptReusable $State $gate $existing[0])) {
            $State.validations_reused = [int]$State.validations_reused + 1
        } else {
            $receipts = @($receipts | Where-Object name -ne [string]$gate.name)
            $pendingGates += $gate
        }
    }
    $State.validation_receipts = $receipts
    Write-State $State
    $preparation = @($pendingGates | Where-Object kind -eq 'install')
    $parallel = @($pendingGates | Where-Object { $_.parallel -and $_.kind -eq 'native' })
    $serial = @($pendingGates | Where-Object { -not $_.parallel -and $_.kind -ne 'install' })
    foreach ($gate in $preparation) {
        $State.active_validation_gate = [string]$gate.name
        Write-State $State
        $receipt = @(Complete-BatchGateProcesses $State @((Start-BatchGateProcess $State $gate)))[0]
        $receipts += $receipt
        $State.validations_executed = [int]$State.validations_executed + 1
        $State.validation_receipts = $receipts
        Write-State $State
    }
    if ($parallel.Count -gt 0) {
        $State.active_validation_gate = @($parallel | ForEach-Object {
                [string]$_.name
            }) -join ', '
        Write-State $State
        $workers = @()
        try {
            foreach ($gate in $parallel) {
                $workers += Start-BatchGateProcess $State $gate
            }
        } catch {
            Stop-BatchGateWorkers $workers
            throw
        }
        $newReceipts = @(Complete-BatchGateProcesses $State $workers -AllowFailure)
        $State.validation_receipts = @($receipts + $newReceipts)
        Write-State $State
        for ($index = 0; $index -lt $newReceipts.Count; $index += 1) {
            if ([int]$newReceipts[$index].exit_code -eq 0) { continue }
            $failedGate = @($parallel | Where-Object name -eq [string]$newReceipts[$index].name)
            if ($failedGate.Count -ne 1) {
                Stop-Workflow "failed validation gate could not be mapped uniquely: $($newReceipts[$index].name)"
            }
            $newReceipts[$index] = Resolve-UnchangedBaselineGateFailure $State $failedGate[0] $newReceipts[$index]
        }
        $receipts += $newReceipts
        $State.validations_executed = [int]$State.validations_executed + $newReceipts.Count
        $State.validation_receipts = $receipts
        Write-State $State
    }
    foreach ($gate in $serial) {
        $State.active_validation_gate = [string]$gate.name
        Write-State $State
        $receipt = if ([string]$gate.kind -eq 'browser') {
            Invoke-BatchBrowserAcceptance $State
        } else {
            @(Complete-BatchGateProcesses $State @((Start-BatchGateProcess $State $gate)))[0]
        }
        $receipts += $receipt
        $State.validations_executed = [int]$State.validations_executed + 1
        $State.validation_receipts = $receipts
        Write-State $State
    }
    $State.active_validation_gate = ''
    Write-State $State
}

function Reconcile-RemoteTruth {
    param([Parameter(Mandatory = $true)]$State, [switch]$GitOnly)
    $generation = Get-GenerationStatus
    $masterLine = Get-GitText (Get-GameRepositoryRoot) @('ls-remote', '--heads', 'origin', 'refs/heads/master')
    $masterSha = if ($masterLine -match '^([0-9a-f]{40})\s+') { $Matches[1] } else { '' }
    if ($GitOnly) {
        $truth = [pscustomobject][ordered]@{
            checked_at_utc = (Get-Date).ToUniversalTime().ToString('o')
            integration_test_sha = [string]$generation.integration_test_sha
            integration_generation = $(if ($generation.generation) {
                    [string]$generation.generation
                } else { [string]$generation.latest_generation })
            generation_snapshot_id = [string]$generation.snapshot_id
            master_sha = $masterSha
            deployed_sha = ''
            public_release_sha = ''
            remote_receipt_reachable = $false
            last_known_receipt_result = ''
            status_query_error = 'VPS verification deferred during Git-only workflow'
        }
        $State.reconciled_remote_truth = $truth
        Write-State $State
        return $truth
    }
    $lastKnownReceipt = $State.remote_deployment_receipt
    $lastKnownResult = if ($null -ne $lastKnownReceipt) {
        [string](Get-StateValue $lastKnownReceipt 'result' '')
    } else { '' }
    $receiptGame = if ($null -ne $lastKnownReceipt) {
        Get-StateValue $lastKnownReceipt 'active_game_sha' ''
    } else { '' }
    $deployed = if ($null -ne $lastKnownReceipt) {
        [string](Get-StateValue $lastKnownReceipt 'observed_game_sha' $receiptGame)
    } else { '' }
    $target = [string](Get-StateValue $State 'candidate_integration_sha' '')
    if ($target -notmatch '^[0-9a-f]{40}$' -and $null -ne $lastKnownReceipt) {
        $target = [string](Get-StateValue $lastKnownReceipt 'target_sha' (
            Get-StateValue $lastKnownReceipt 'requested_target_sha' ''))
    }
    $public = ''
    $remoteReceiptReachable = $false
    $statusQueryError = ''
    $statusAttemptedAtUtc = $null
    $token = [string](Get-StateValue $State 'deployment_status_token' '')
    if ($token -match '^[0-9a-f]{64}$' -and $target -match '^[0-9a-f]{40}$') {
        $statusAttemptedAtUtc = (Get-Date).ToUniversalTime()
        $httpsStatus = Invoke-HttpsDeploymentStatus $State
        if ([bool]$httpsStatus.available -and -not [bool]$httpsStatus.conflict -and
            $null -ne $httpsStatus.payload) {
            try { Assert-DeploymentStatusPayload $httpsStatus.payload $State $target }
            catch {
                try { Invoke-SshStatusFallback $State $target | Out-Null } catch { }
                throw
            }
            $status = $httpsStatus.payload
            Set-RemoteReceipt $State $status
            $lastKnownResult = [string]$status.result
            $deployed = [string](Get-StateValue $status 'active_game_sha' '')
            $remotePublic = [string](Get-StateValue $status 'active_public_sha' '')
            if ($remotePublic -match '^[0-9a-f]{40}$') { $public = $remotePublic }
            $remoteReceiptReachable = $true
        } elseif ([bool]$httpsStatus.conflict) {
            try { Invoke-SshStatusFallback $State $target | Out-Null } catch { }
            Stop-Workflow "HTTPS deployment status conflicted during reconciliation ($($httpsStatus.code))"
        } else {
            $statusQueryError = "HTTPS deployment status unavailable ($($httpsStatus.code))"
        }
    } elseif (Test-Path -LiteralPath $SshKey -PathType Leaf) {
        $status = $null
        $statusAttemptedAtUtc = (Get-Date).ToUniversalTime()
        try { $status = Invoke-DeploymentController $State status @() }
        catch { $statusQueryError = $_.Exception.Message }
        if ($null -ne $status -and $null -ne $status.payload) {
            $outageStartedAt = Get-ReceiptOutageStart $State
            if ($null -ne $outageStartedAt) {
                Complete-ReceiptOutage $State $outageStartedAt (Get-Date).ToUniversalTime()
                Write-State $State
            }
            Assert-ConsistentControllerPayload $status
            if ($lastKnownResult -in @('accepted', 'running', 'prepared', 'completed', 'failed') -and
                [string]$status.payload.result -eq 'absent') {
                Stop-Workflow 'authoritative remote deployment receipt disappeared after acceptance'
            }
            if ([string]$status.payload.result -eq 'absent') {
                if ([int](Get-StateValue $status.payload 'schema_version' 0) -ne 1 -or
                    [string](Get-StateValue $status.payload 'operation_id' '') -cne [string]$State.operation_id -or
                    [string](Get-StateValue $status.payload 'unit_state' '') -cne 'inactive' -or
                    [bool](Get-StateValue $State 'deployment_start_attempted' $false) -or
                    $null -ne (Get-StateValue $State 'remote_side_effect_intent' $null) -or
                    $null -ne (Get-StateValue $State 'activation_intent' $null)) {
                    Stop-Workflow 'absent remote operation is not a safe pre-submission observation'
                }
                $lastKnownResult = 'absent'
                $statusQueryError = 'deployment operation has not been submitted'
            } else {
                $normalizedStatus = ConvertFrom-ControllerReceipt $status.payload $State
                Assert-DeploymentStatusPayload $normalizedStatus $State $target
                Set-RemoteReceipt $State $status.payload
                Set-RemoteReceipt $State $normalizedStatus
                $lastKnownResult = [string](Get-StateValue $status.payload 'result' '')
                $receiptGame = Get-StateValue $status.payload 'active_game_sha' ''
                $receiptPublic = Get-StateValue $status.payload 'active_public_sha' ''
                $deployed = [string](Get-StateValue $status.payload 'observed_game_sha' $receiptGame)
                $remotePublic = [string](Get-StateValue $status.payload 'observed_public_sha' $receiptPublic)
                if ($remotePublic -match '^[0-9a-f]{40}$') { $public = $remotePublic }
                $remoteReceiptReachable = $true
            }
        } elseif ($null -ne $status) {
            $statusQueryError = "status exit $($status.exit_code): $($status.output)".Trim()
        }
    } else {
        $statusQueryError = if ($token) {
            'operation state does not contain a safe HTTPS status identity'
        } else {
            "SSH key is absent: $SshKey"
        }
    }
    if ($Mode -eq 'Resume' -and $null -ne $statusAttemptedAtUtc -and
        -not $remoteReceiptReachable -and $lastKnownResult -in @('accepted', 'running')) {
        $outageStartedAt = Get-ReceiptOutageStart $State
        if ($null -eq $outageStartedAt) {
            $outageStartedAt = $statusAttemptedAtUtc
            $State.deployment_receipt_outage_started_at_utc =
                $outageStartedAt.ToString('o')
            $State.deployment_receipt_outage_next_delay_seconds =
                [math]::Min(10, $DeploymentPollIntervalSeconds)
        }
        $State.deployment_status_read_failures = [int]$State.deployment_status_read_failures + 1
        $State.deployment_automatic_reconciliation_required = $true
        $outageMilliseconds = [long][math]::Max(
            0, [math]::Round(((Get-Date).ToUniversalTime() - $outageStartedAt).TotalMilliseconds))
        $State.deployment_longest_receipt_outage_ms = [long][math]::Max(
            [long]$State.deployment_longest_receipt_outage_ms, $outageMilliseconds)
        Write-State $State
    }
    try {
        $release = Invoke-RestMethod -Uri 'https://playashatlas.com/play/release.json' -TimeoutSec 10
        if ([string]$release.game_sha -match '^[0-9a-f]{40}$') { $public = [string]$release.game_sha }
    } catch { }
    $truth = [pscustomobject][ordered]@{
        checked_at_utc = (Get-Date).ToUniversalTime().ToString('o')
        integration_test_sha = [string]$generation.integration_test_sha
        integration_generation = $(if ($generation.generation) {
                [string]$generation.generation
            } else { [string]$generation.latest_generation })
        generation_snapshot_id = [string]$generation.snapshot_id
        master_sha = $masterSha
        deployed_sha = $deployed
        public_release_sha = $public
        remote_receipt_reachable = $remoteReceiptReachable
        last_known_receipt_result = $lastKnownResult
        status_query_error = $statusQueryError
    }
    $State.reconciled_remote_truth = $truth
    Write-State $State
    return $truth
}

function Assert-IntegrationAuthorization($State) {
    if (-not $ConfirmIntegration) { Stop-Workflow 'integration requires -ConfirmIntegration' }
    if (-not $ConfirmGenerationCheckpoint) { Stop-Workflow 'integration requires -ConfirmGenerationCheckpoint' }
    if ([bool]$State.atomic_master_publication) {
        if ([string]$State.requested_mode -eq 'IntegrateAndPublish') {
            Assert-DeploymentAuthorization
        } else {
            Assert-MasterPublicationAuthorization
        }
    }
}

function Get-LiveMobileCompatibilitySetting {
    param(
        [Parameter(Mandatory = $true)][string]$ServerUrl,
        [Parameter(Mandatory = $true)]$Release
    )
    try { $serverUri = [Uri]$ServerUrl }
    catch { Stop-Workflow "mobile compatibility server URL is invalid: $ServerUrl" }
    if ($serverUri.Scheme -cne 'https') {
        Stop-Workflow 'mobile compatibility server URL must use HTTPS'
    }
    $build = 0
    $protocolMin = 0
    $protocolMax = 0
    $releaseProtocol = Get-StateValue $Release 'protocol' $null
    if ($null -eq $releaseProtocol -or
        -not [int]::TryParse([string](Get-StateValue $Release 'build' ''), [ref]$build) -or
        -not [int]::TryParse([string](Get-StateValue $releaseProtocol 'min' ''), [ref]$protocolMin) -or
        -not [int]::TryParse([string](Get-StateValue $releaseProtocol 'max' ''), [ref]$protocolMax) -or
        $build -le 0 -or $protocolMin -le 0 -or $protocolMin -gt $protocolMax) {
        Stop-Workflow 'mobile registry release has an invalid build or protocol identity'
    }
    $platform = [string](Get-StateValue $Release 'platform' '')
    $version = [string](Get-StateValue $Release 'marketingVersion' '')
    $sourceSha = [string](Get-StateValue $Release 'sourceSha' '')
    if ($platform -notin @('ios', 'android') -or
        $version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$' -or
        $sourceSha -cnotmatch '^[0-9a-f]{40}$') {
        Stop-Workflow 'mobile registry release has an invalid platform, version, or source SHA'
    }
    $uri = [UriBuilder]::new($serverUri)
    $path = $serverUri.AbsolutePath.TrimEnd('/')
    $uri.Path = "$path/api/auth/native/compatibility"
    $uri.Query = @(
        "platform=$([Uri]::EscapeDataString($platform))",
        "version=$([Uri]::EscapeDataString($version))",
        "build=$build",
        "wsMin=$protocolMin",
        "wsMax=$protocolMax"
    ) -join '&'
    try {
        $response = Invoke-RestMethod -Uri $uri.Uri.AbsoluteUri -Method Get `
            -Headers @{ Accept = 'application/json' } -TimeoutSec 15 -ErrorAction Stop
    } catch {
        Stop-Workflow "live mobile compatibility probe failed for $platform $version ($build): $($_.Exception.Message)"
    }
    $hardMinimum = Get-StateValue $response 'hardMinimum' $null
    if ($null -eq $hardMinimum) {
        Stop-Workflow "live mobile compatibility response has no hard minimum for $platform $version ($build)"
    }
    $serverSha = [string](Get-StateValue $response 'serverSha' '')
    $serverProtocolMin = 0
    $serverProtocolMax = 0
    $hardBuild = 0
    if ([int](Get-StateValue $response 'contractVersion' 0) -ne 1 -or
        [string](Get-StateValue $response 'platform' '') -cne $platform -or
        [string](Get-StateValue $response 'version' '') -cne $version -or
        [int](Get-StateValue $response 'build' 0) -ne $build -or
        -not [int]::TryParse([string](Get-StateValue $response 'wsMin' ''), [ref]$serverProtocolMin) -or
        -not [int]::TryParse([string](Get-StateValue $response 'wsMax' ''), [ref]$serverProtocolMax) -or
        -not [int]::TryParse([string](Get-StateValue $hardMinimum 'build' ''), [ref]$hardBuild) -or
        $serverProtocolMin -le 0 -or $serverProtocolMin -gt $serverProtocolMax -or
        [string](Get-StateValue $hardMinimum 'version' '') -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$' -or
        $hardBuild -lt 0 -or $serverSha -cnotmatch '^[0-9a-f]{40}$' -or
        [string](Get-StateValue $response 'status' '') -notin @('supported', 'recommended', 'required')) {
        Stop-Workflow "live mobile compatibility response is invalid for $platform $version ($build)"
    }
    return [pscustomobject][ordered]@{
        platform = $platform
        registry_source_sha = $sourceSha
        registry_version = $version
        registry_build = $build
        server_sha = $serverSha
        server_protocol_min = $serverProtocolMin
        server_protocol_max = $serverProtocolMax
        hard_minimum_version = [string](Get-StateValue $hardMinimum 'version' '')
        hard_minimum_build = $hardBuild
        status = [string](Get-StateValue $response 'status' '')
    }
}

function Get-TrustedMobileReleaseToolPath {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('candidate-protocol-range.mjs', 'server-compatibility-gate.mjs', 'registry-remote.mjs')]
        [string]$Name
    )
    $trustedRoot = [IO.Path]::GetFullPath((Join-Path $RepositoryRoot 'tools\mobile-release')).TrimEnd('\')
    $path = Join-Path $trustedRoot $Name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Stop-Workflow "trusted mobile release tool is missing from the pinned tooling checkout: $path"
    }
    return $path
}

function Get-MobileRegistryRemote {
    param(
        [object]$State = $null,
        [string]$FallbackRepository
    )
    $configured = if ($null -ne $State) {
        [string](Get-StateValue $State 'mobile_compatibility_registry_remote' '')
    } else { '' }
    if (-not $configured) {
        $configuredInput = Get-Variable MobileRegistryRemote -ErrorAction SilentlyContinue
        if ($null -ne $configuredInput) { $configured = [string]$configuredInput.Value }
    }
    if (-not $configured -and $FallbackRepository) {
        $configured = Get-GitText $FallbackRepository @('remote', 'get-url', 'origin')
    }
    if (-not $configured) {
        $permanent = if ($null -ne (Get-Variable PermanentCheckout -ErrorAction SilentlyContinue)) {
            [string](Get-Variable PermanentCheckout -ValueOnly)
        } else { '' }
        if ($permanent) {
            $configured = Get-GitText $permanent @('remote', 'get-url', 'origin')
        }
    }
    if (-not $configured) {
        $repository = if ($null -ne (Get-Variable RepositoryRoot -ErrorAction SilentlyContinue)) {
            [string](Get-Variable RepositoryRoot -ValueOnly)
        } else { '' }
        if ($repository) {
            $configured = Get-GitText $repository @('remote', 'get-url', 'origin')
        }
    }
    $configured = $configured.Trim()
    if ($configured -notmatch '^(?:(?:https://|ssh://|git@)[^\s\r\n]+|[A-Za-z]:[\\/][^\s\r\n]+|/[^\s\r\n]+)$') {
        Stop-Workflow 'mobile compatibility registry remote is missing or invalid'
    }
    if ($null -ne $State) {
        $State.mobile_compatibility_registry_remote = $configured
    }
    return $configured
}

function Assert-MobileBackwardCompatibility {
    param(
        [Parameter(Mandatory = $true)][string]$CandidateWorktree,
        [Parameter(Mandatory = $true)][string]$CandidateSha,
        [object]$State = $null
    )
    Assert-CanonicalSha $CandidateSha 'mobile backward-compatibility candidate SHA'
    $candidateRoot = [IO.Path]::GetFullPath($CandidateWorktree).TrimEnd('\')
    if (-not (Test-Path -LiteralPath $candidateRoot -PathType Container)) {
        Stop-Workflow "mobile backward-compatibility candidate worktree is missing: $candidateRoot"
    }
    $candidateHead = Get-GitCommitId $candidateRoot 'HEAD'
    if ($candidateHead -ne $CandidateSha) {
        Stop-Workflow ("mobile backward-compatibility candidate identity mismatch: " +
            "worktree HEAD $candidateHead, expected $CandidateSha")
    }
    if (Get-GitText $candidateRoot @('status', '--porcelain')) {
        Stop-Workflow 'mobile backward-compatibility candidate worktree is dirty'
    }
    $registryRemote = Get-MobileRegistryRemote -State $State -FallbackRepository $candidateRoot
    $registryPath = [IO.Path]::GetTempFileName()
    try {
        $stateRef = 'refs/heads/mobile-release-state'
        $registrySource = 'seed'
        $registryCommitSha = ''
        $remoteState = Get-GitText $candidateRoot @('ls-remote', $registryRemote, $stateRef)
        if ($remoteState) {
            Invoke-Git $candidateRoot @(
                'fetch', '--force', $registryRemote, "$stateRef`:refs/remotes/origin/mobile-release-state")
            $registryCommitSha = Get-GitCommitId $candidateRoot 'refs/remotes/origin/mobile-release-state'
            $registryJson = Get-GitText $candidateRoot @(
                'show', 'refs/remotes/origin/mobile-release-state:mobile-release-registry.json')
            [IO.File]::WriteAllText($registryPath, $registryJson + [Environment]::NewLine)
            $registrySource = 'origin/mobile-release-state:mobile-release-registry.json'
        } else {
            Copy-Item -LiteralPath (Join-Path $candidateRoot 'config\mobile-release-registry.seed.json') `
                -Destination $registryPath -Force
        }
        $registrySha = Get-FileSha256 $registryPath
        try {
            $registry = Get-Content -Raw -LiteralPath $registryPath -Encoding utf8 | ConvertFrom-Json -ErrorAction Stop
        } catch {
            Stop-Workflow "mobile release registry is invalid: $($_.Exception.Message)"
        }
        $compatibilityJson = @(& node (Get-TrustedMobileReleaseToolPath 'registry-remote.mjs') `
            compatibility-releases --file $registryPath 2>&1)
        if ($LASTEXITCODE -ne 0) {
            Stop-Workflow "mobile compatibility registry validation failed: $($compatibilityJson -join [Environment]::NewLine)"
        }
        $supported = @(($compatibilityJson -join "`n" | ConvertFrom-Json -ErrorAction Stop).compatibilityReleases)
        $probeReleases = [ordered]@{}
        foreach ($platform in @('ios', 'android')) {
            $matches = @($supported | Where-Object {
                    [string](Get-StateValue $_ 'platform' '') -eq $platform
                } | Sort-Object -Property @{ Expression = { [int](Get-StateValue $_ 'build' 0) }; Descending = $true })
            if ($matches.Count -lt 1) {
                Stop-Workflow "mobile release registry has no supported $platform release"
            }
            $probeReleases[$platform] = $matches[0]
        }
        $protocolJson = @(& node (Get-TrustedMobileReleaseToolPath 'candidate-protocol-range.mjs') `
            $candidateRoot $CandidateSha 2>&1)
        if ($LASTEXITCODE -ne 0) {
            Stop-Workflow "candidate protocol derivation failed: $($protocolJson -join [Environment]::NewLine)"
        }
        try {
            $candidateProtocol = ($protocolJson -join "`n") | ConvertFrom-Json -ErrorAction Stop
        } catch {
            Stop-Workflow "candidate protocol derivation returned invalid JSON: $($protocolJson -join [Environment]::NewLine)"
        }
        $protocolMin = [string]$candidateProtocol.min
        $protocolMax = [string]$candidateProtocol.max
        $serverUrl = [string]$MobileCompatibilityServerUrl
        $liveSettings = @(
            Get-LiveMobileCompatibilitySetting $serverUrl $probeReleases.ios
            Get-LiveMobileCompatibilitySetting $serverUrl $probeReleases.android
        )
        $evidenceJson = @($liveSettings | Sort-Object platform | ForEach-Object {
                [ordered]@{
                    platform = [string]$_.platform
                    server_sha = [string]$_.server_sha
                    server_protocol_min = [int]$_.server_protocol_min
                    server_protocol_max = [int]$_.server_protocol_max
                    hard_minimum_version = [string]$_.hard_minimum_version
                    hard_minimum_build = [int]$_.hard_minimum_build
                    status = [string]$_.status
                }
            } | ConvertTo-Json -Depth 8 -Compress)
        $compatibilityFingerprint = Get-TextSha256 ((@($serverUrl, $registrySha, $evidenceJson)) -join "`n")
        if ($null -ne $State) {
            $previousFingerprint = [string](Get-StateValue $State 'mobile_compatibility_fingerprint' '')
            if ($previousFingerprint -and $previousFingerprint -cne $compatibilityFingerprint) {
                # The registry is a durable, independently published state. A harmless registry
                # update invalidates the cached gate, so the candidate is admitted again against
                # the current evidence instead of being permanently rejected on Resume.
                $State.mobile_compatibility_gate_result = 'stale_recheck_required'
                $State.mobile_compatibility_fingerprint = ''
                Write-State $State
            }
            $State.mobile_compatibility_server_url = $serverUrl
            $State.mobile_compatibility_registry_source = $registrySource
            $State.mobile_compatibility_registry_commit_sha = $registryCommitSha
            $State.mobile_compatibility_registry_sha256 = $registrySha
            $State.mobile_compatibility_server_sha256 = @($liveSettings | ForEach-Object {
                    [string]$_.server_sha
                }) -join ','
            $State.mobile_compatibility_protocol_min = [int]$protocolMin
            $State.mobile_compatibility_protocol_max = [int]$protocolMax
            $State.mobile_compatibility_fingerprint = $compatibilityFingerprint
            $State.mobile_compatibility_settings = @($liveSettings)
            $State.mobile_compatibility_checked_at_utc = (Get-Date).ToUniversalTime().ToString('o')
            $State.mobile_compatibility_gate_result = 'running'
            Write-State $State
        }
        $iosSettings = @($liveSettings | Where-Object platform -eq 'ios')[0]
        $androidSettings = @($liveSettings | Where-Object platform -eq 'android')[0]
        try {
            $output = @(& node (Get-TrustedMobileReleaseToolPath 'server-compatibility-gate.mjs') `
                '--registry' $registryPath '--protocol-min' $protocolMin '--protocol-max' $protocolMax `
                '--ios-hard-version' ([string]$iosSettings.hard_minimum_version) `
                '--ios-hard-build' ([string]$iosSettings.hard_minimum_build) `
                '--android-hard-version' ([string]$androidSettings.hard_minimum_version) `
                '--android-hard-build' ([string]$androidSettings.hard_minimum_build) 2>&1)
            if ($LASTEXITCODE -ne 0) {
                Stop-Workflow "mobile backward-compatibility gate failed: $($output -join [Environment]::NewLine)"
            }
        } catch {
            if ($null -ne $State) {
                $State.mobile_compatibility_gate_result = 'failed'
                Write-State $State
            }
            throw
        }
        if ($null -ne $State) {
            $State.mobile_compatibility_gate_result = 'passed'
            Write-State $State
        }
        return ($output -join "`n")
    } finally {
        Remove-Item -LiteralPath $registryPath -Force -ErrorAction SilentlyContinue
    }
}

function Set-MobileActivationIntent {
    param(
        [Parameter(Mandatory = $true)][string]$CandidateWorktree,
        [Parameter(Mandatory = $true)][string]$CandidateSha,
        [Parameter(Mandatory = $true)]$State
    )
    Assert-CanonicalSha $CandidateSha 'mobile activation target SHA'
    $candidateRoot = [IO.Path]::GetFullPath($CandidateWorktree).TrimEnd('\')
    if (-not (Test-Path -LiteralPath $candidateRoot -PathType Container)) {
        Stop-Workflow "mobile activation candidate worktree is missing: $candidateRoot"
    }
    if ((Get-GitCommitId $candidateRoot 'HEAD') -ne $CandidateSha) {
        Stop-Workflow 'mobile activation candidate worktree is not the exact target'
    }
    $intentId = [string](Get-StateValue $State 'operation_id' '')
    $preparedReceipt = [string](Get-StateValue $State 'prepared_remote_receipt_sha256' '')
    $preparedEnv = [string](Get-StateValue $State 'prepared_env_sha256' '')
    $component = [string](Get-StateValue $State 'prepared_server_component_sha' '')
    $registryCommit = [string](Get-StateValue $State 'mobile_compatibility_registry_commit_sha' '')
    $preparedNativeJson = [string](Get-StateValue $State 'prepared_native_compatibility_json' '')
    $preparedNativeHash = [string](Get-StateValue $State 'prepared_native_compatibility_sha256' '')
    if ($intentId -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$' -or
        $preparedReceipt -notmatch '^[0-9a-f]{64}$' -or
        $preparedEnv -notmatch '^[0-9a-f]{64}$' -or
        $component -notmatch '^[0-9a-f]{40}$' -or
        $registryCommit -notmatch '^[0-9a-f]{40}$' -or
        $preparedNativeJson.Length -eq 0 -or
        $preparedNativeHash -notmatch '^[0-9a-f]{64}$' -or
        (Get-TextSha256 $preparedNativeJson) -cne $preparedNativeHash) {
        Stop-Workflow 'PREPARE and mobile compatibility evidence is incomplete for activation intent'
    }
    try {
        $preparedNative = $preparedNativeJson | ConvertFrom-Json -ErrorAction Stop
    } catch {
        Stop-Workflow "prepared native compatibility policy is invalid JSON: $($_.Exception.Message)"
    }
    $preparedProtocol = Get-StateValue $preparedNative 'serverProtocol' $null
    if ($null -eq $preparedProtocol) {
        Stop-Workflow 'prepared native compatibility policy has no server protocol range'
    }
    $protocolMin = [int](Get-StateValue $preparedProtocol 'min' 0)
    $protocolMax = [int](Get-StateValue $preparedProtocol 'max' 0)
    if ($protocolMin -le 0 -or $protocolMax -lt $protocolMin) {
        Stop-Workflow 'prepared native compatibility policy has an invalid server protocol range'
    }
    $preparedHardMinimum = Get-StateValue $preparedNative 'hardMinimum' $null
    if ($null -eq $preparedHardMinimum) {
        Stop-Workflow 'prepared native compatibility policy has no hard minimums'
    }
    $minimums = [ordered]@{}
    foreach ($platform in @('ios', 'android')) {
        $preparedMinimum = Get-StateValue $preparedHardMinimum $platform $null
        if ($null -eq $preparedMinimum) {
            Stop-Workflow "prepared native compatibility policy has no $platform hard minimum"
        }
        $version = [string](Get-StateValue $preparedMinimum 'version' '')
        $build = [int](Get-StateValue $preparedMinimum 'build' -1)
        if ($version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$' -or $build -lt 0) {
            Stop-Workflow "prepared native compatibility policy has no valid $platform hard minimum"
        }
        $minimums[$platform] = [ordered]@{ version = $version; build = $build }
    }
    $existingIntent = Get-StateValue $State 'activation_intent' $null
    $intentResolved = [bool](Get-StateValue $State 'activation_intent_resolved' $false)
    if ($null -ne $existingIntent -and -not $intentResolved) {
        $existingProtocol = Get-StateValue $existingIntent 'serverProtocol' $null
        if ([string](Get-StateValue $existingIntent 'intentId' '') -ne $intentId -or
            [string](Get-StateValue $existingIntent 'serverSha' '') -ne $CandidateSha -or
            [string](Get-StateValue $existingIntent 'candidateComponentSha' '') -ne $component -or
            [string](Get-StateValue $existingIntent 'preparedReceiptSha' '') -ne $preparedReceipt -or
            [string](Get-StateValue $existingIntent 'preSwitchEnvSha' '') -ne $preparedEnv -or
            $null -eq $existingProtocol -or
            [int](Get-StateValue $existingProtocol 'min' 0) -ne $protocolMin -or
            [int](Get-StateValue $existingProtocol 'max' 0) -ne $protocolMax) {
            Stop-Workflow 'unresolved mobile activation intent differs from the current prepared admission'
        }
        foreach ($platform in @('ios', 'android')) {
            $existingMinimum = Get-StateValue (Get-StateValue $existingIntent 'hardMinimum' $null) $platform $null
            if ($null -eq $existingMinimum -or
                [string](Get-StateValue $existingMinimum 'version' '') -ne
                    [string]$minimums[$platform].version -or
                [int](Get-StateValue $existingMinimum 'build' -1) -ne
                    [int]$minimums[$platform].build) {
                Stop-Workflow 'unresolved mobile activation intent hard minimum differs from current admission'
            }
        }
        $intent = $existingIntent
    } else {
        $intent = [ordered]@{
            schemaVersion = 1
            intentId = $intentId
            serverSha = $CandidateSha
            candidateComponentSha = $component
            preparedReceiptSha = $preparedReceipt
            preSwitchEnvSha = $preparedEnv
            serverProtocol = [ordered]@{ min = $protocolMin; max = $protocolMax }
            hardMinimum = $minimums
            createdAt = (Get-Date).ToUniversalTime().ToString('o')
        }
    }
    # Persist the exact intent before the registry CAS. A lost response must be
    # resumable with the same createdAt and identity rather than creating a new
    # intent that the registry correctly rejects as a conflicting operation.
    $State.activation_intent = $intent | ConvertTo-Json -Depth 10 | ConvertFrom-Json
    $State.activation_intent_id = $intentId
    $State.activation_intent_resolved = $false
    $State.activation_registry_resolved_at_utc = ''
    $State.activation_intent_terminal_result = ''
    Write-State $State
    $registryRemote = Get-MobileRegistryRemote -State $State -FallbackRepository $candidateRoot
    $intentPath = [IO.Path]::GetTempFileName()
    try {
        [IO.File]::WriteAllText(
            $intentPath,
            ($intent | ConvertTo-Json -Depth 10) + [Environment]::NewLine,
            [Text.UTF8Encoding]::new($false))
        $output = @(& node (Get-TrustedMobileReleaseToolPath 'registry-remote.mjs') `
            set-activation-intent '--remote' $registryRemote '--intent-file' $intentPath 2>&1)
        if ($LASTEXITCODE -ne 0) {
            Stop-Workflow "mobile activation intent CAS failed: $($output -join [Environment]::NewLine)"
        }
        $resultLine = @($output | Where-Object { $_.ToString().TrimStart().StartsWith('{') } | Select-Object -Last 1)
        if ($resultLine.Count -ne 1) { Stop-Workflow 'mobile activation intent CAS returned no JSON result' }
        try { $result = ($resultLine[0].ToString() | ConvertFrom-Json -ErrorAction Stop) }
        catch { Stop-Workflow "mobile activation intent CAS returned invalid JSON: $($_.Exception.Message)" }
        $activeIntent = Get-StateValue $result 'activationIntent' $null
        if ($null -eq $activeIntent -or
            (ConvertTo-Json $activeIntent -Depth 10 -Compress) -cne
                (ConvertTo-Json $intent -Depth 10 -Compress)) {
            Stop-Workflow 'mobile activation intent CAS did not persist the exact intent'
        }
        $stateRef = 'refs/heads/mobile-release-state'
        $remoteState = Get-GitText $candidateRoot @('ls-remote', $registryRemote, $stateRef)
        $resultCommit = if ($remoteState) { ([string]$remoteState -split '\s+')[0] } else { '' }
        Assert-CanonicalSha $resultCommit 'mobile activation registry commit SHA'
        if ($null -ne $existingIntent -and -not $intentResolved -and
            [string](Get-StateValue $State 'activation_registry_commit_sha' '') -match '^[0-9a-f]{40}$' -and
            $resultCommit -cne [string](Get-StateValue $State 'activation_registry_commit_sha' '')) {
            Stop-Workflow 'unresolved mobile activation registry commit changed before the same ACTIVATE retry'
        }
        # Keep the same property-based identity used after reading durable JSON.
        # An OrderedDictionary has no PSObject properties for its intent keys.
        $State.activation_intent = $intent | ConvertTo-Json -Depth 10 | ConvertFrom-Json
        $State.activation_intent_id = $intentId
        $State.activation_registry_commit_sha = $resultCommit
        $State.activation_intent_resolved = $false
        $State.mobile_compatibility_registry_commit_sha = $resultCommit
        Write-State $State
        return $resultCommit
    } finally {
        Remove-Item -LiteralPath $intentPath -Force -ErrorAction SilentlyContinue
    }
}

function Test-MobileActivationIntentIdentity {
    param(
        [Parameter(Mandatory = $true)]$Expected,
        [Parameter(Mandatory = $true)]$Actual
    )
    if ($null -eq $Expected -or $null -eq $Actual) { return $false }
    foreach ($field in @('schemaVersion', 'intentId', 'serverSha', 'candidateComponentSha',
            'preparedReceiptSha', 'preSwitchEnvSha')) {
        if ([string](Get-StateValue $Actual $field '') -cne
            [string](Get-StateValue $Expected $field '')) { return $false }
    }
    # Round-trip 'o' timestamps carry 7 fraction digits; other serializers drop
    # trailing zeros. Compare the spellings as the same instant.
    $canonicalCreatedAt = {
        param($value)
        ([string]$value) -replace '(\.\d*?)0+Z$', '$1Z' -replace '\.Z$', 'Z'
    }
    if ((& $canonicalCreatedAt (Get-StateValue $Actual 'createdAt' '')) -cne
        (& $canonicalCreatedAt (Get-StateValue $Expected 'createdAt' ''))) { return $false }
    $expectedProtocol = Get-StateValue $Expected 'serverProtocol' $null
    $actualProtocol = Get-StateValue $Actual 'serverProtocol' $null
    if ($null -eq $expectedProtocol -or $null -eq $actualProtocol -or
        [int](Get-StateValue $actualProtocol 'min' 0) -ne
            [int](Get-StateValue $expectedProtocol 'min' 0) -or
        [int](Get-StateValue $actualProtocol 'max' 0) -ne
            [int](Get-StateValue $expectedProtocol 'max' 0)) { return $false }
    foreach ($platform in @('ios', 'android')) {
        $expectedMinimum = Get-StateValue (Get-StateValue $Expected 'hardMinimum' $null) $platform $null
        $actualMinimum = Get-StateValue (Get-StateValue $Actual 'hardMinimum' $null) $platform $null
        if ($null -eq $expectedMinimum -or $null -eq $actualMinimum -or
            [string](Get-StateValue $actualMinimum 'version' '') -cne
                [string](Get-StateValue $expectedMinimum 'version' '') -or
            [int](Get-StateValue $actualMinimum 'build' -1) -ne
                [int](Get-StateValue $expectedMinimum 'build' -1)) { return $false }
    }
    return $true
}

function Get-MobileActivationRegistryStatus {
    param(
        [Parameter(Mandatory = $true)][string]$CandidateWorktree,
        [object]$State = $null
    )
    $registryRemote = Get-MobileRegistryRemote -State $State -FallbackRepository $CandidateWorktree
    $output = @(& node (Get-TrustedMobileReleaseToolPath 'registry-remote.mjs') `
        activation-status '--remote' $registryRemote 2>&1)
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        Stop-Workflow "mobile activation registry status failed: $($output -join [Environment]::NewLine)"
    }
    $resultLine = @($output | Where-Object {
            $_.ToString().TrimStart().StartsWith('{')
        } | Select-Object -Last 1)
    if ($resultLine.Count -ne 1) {
        Stop-Workflow 'mobile activation registry status returned no JSON result'
    }
    try { return ($resultLine[0].ToString() | ConvertFrom-Json -ErrorAction Stop) }
    catch { Stop-Workflow "mobile activation registry status returned invalid JSON: $($_.Exception.Message)" }
}

function Resolve-MobileActivationIntentRemote {
    param(
        [Parameter(Mandatory = $true)][string]$CandidateWorktree,
        [Parameter(Mandatory = $true)]$Intent,
        [object]$State = $null,
        [object]$TerminalReceipt = $null
    )
    $registryRemote = Get-MobileRegistryRemote -State $State -FallbackRepository $CandidateWorktree
    $status = Get-MobileActivationRegistryStatus $CandidateWorktree -State $State
    $active = Get-StateValue $status 'activationIntent' $null
    $resolvedRecords = @(Get-StateValue $status 'resolvedIntents' @())
    if ($resolvedRecords.Count -eq 0) {
        $legacyResolved = Get-StateValue $status 'resolvedIntent' $null
        if ($null -ne $legacyResolved) { $resolvedRecords = @($legacyResolved) }
    }
    $resolved = @($resolvedRecords | Where-Object {
            Test-MobileActivationIntentIdentity $Intent (Get-StateValue $_ 'intent' $null)
        } | Select-Object -First 1)
    $alreadyResolved = $resolved.Count -eq 1
    if ($alreadyResolved -and $null -eq $TerminalReceipt) {
        return 'already_resolved'
    }
    if (-not $alreadyResolved -and $null -eq $active) {
        return 'missing'
    }
    if (-not $alreadyResolved -and -not (Test-MobileActivationIntentIdentity $Intent $active)) {
        Stop-Workflow 'authoritative mobile activation registry contains a different active intent'
    }
    $intentPath = [IO.Path]::GetTempFileName()
    $auditPath = [IO.Path]::GetTempFileName()
    try {
        [IO.File]::WriteAllText(
            $intentPath,
            ($Intent | ConvertTo-Json -Depth 10) + [Environment]::NewLine,
            [Text.UTF8Encoding]::new($false))
        $arguments = @('resolve-activation-intent', '--remote', $registryRemote, '--intent-file', $intentPath)
        if ($null -ne $TerminalReceipt) {
            $originalIntentJson = $Intent | ConvertTo-Json -Depth 10 -Compress
            $serverReceipt = [ordered]@{}
            foreach ($field in @('operation_id', 'requested_target_sha', 'target_sha', 'result',
                    'active_public_sha', 'active_game_sha', 'mutation_evidence_complete',
                    'activation_started', 'activation_completed', 'migration_started',
                    'migration_completed', 'migration_outcome_uncertain', 'rollback_result',
                    'prepared_remote_receipt_sha256', 'activation_intent_id', 'prepared_env_sha256')) {
                $value = Get-StateValue $TerminalReceipt $field $null
                if ($null -ne $value) { $serverReceipt[$field] = $value }
            }
            $audit = [ordered]@{
                schemaVersion = 1
                version = 'terminal-reconciliation-v1'
                actor = [Environment]::UserName
                toolSha256 = Get-FileSha256 $script:ReleaseControllerPath
                originalIntentJson = $originalIntentJson
                originalIntentSha256 = Get-TextSha256 $originalIntentJson
                normalizedIntent = $Intent
                registrySha256 = [string](Get-StateValue $status 'registrySha256' '')
                serverProof = [ordered]@{
                    provenance = 'authoritative-deployment-controller'
                    receipt = $serverReceipt
                    liveIdentity = [ordered]@{
                        publicSha = [string](Get-StateValue $TerminalReceipt 'active_public_sha' '')
                        gameSha = [string](Get-StateValue $TerminalReceipt 'active_game_sha' '')
                    }
                }
            }
            [IO.File]::WriteAllText($auditPath, ($audit | ConvertTo-Json -Depth 14), [Text.UTF8Encoding]::new($false))
            $arguments += @('--terminal-audit-file', $auditPath)
        }
        # Windows PowerShell turns native stderr into terminating errors under Stop.
        # Capture the exit code so the authoritative follow-up read can prove response loss.
        $previousErrorActionPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            $output = @(& node (Get-TrustedMobileReleaseToolPath 'registry-remote.mjs') @arguments 2>&1)
            $exitCode = $LASTEXITCODE
        } finally { $ErrorActionPreference = $previousErrorActionPreference }
        $after = Get-MobileActivationRegistryStatus $CandidateWorktree -State $State
        $afterActive = Get-StateValue $after 'activationIntent' $null
        $afterResolvedRecords = @(Get-StateValue $after 'resolvedIntents' @())
        if ($afterResolvedRecords.Count -eq 0) {
            $legacyAfterResolved = Get-StateValue $after 'resolvedIntent' $null
            if ($null -ne $legacyAfterResolved) { $afterResolvedRecords = @($legacyAfterResolved) }
        }
        $afterResolved = @($afterResolvedRecords | Where-Object {
                Test-MobileActivationIntentIdentity $Intent (Get-StateValue $_ 'intent' $null)
            } | Select-Object -First 1)
        if ($afterResolved.Count -eq 1) {
            if ($null -ne $TerminalReceipt) {
                $recordedAudit = Get-StateValue $afterResolved[0] 'terminalAudit' $null
                $recordedProof = if ($null -ne $recordedAudit) {
                    Get-StateValue $recordedAudit 'serverProof' $null
                } else { $null }
                $attemptedProof = $audit.serverProof | ConvertTo-Json -Depth 10 | ConvertFrom-Json
                $proofMatches = $null -ne $recordedProof -and
                    ((@($recordedProof.PSObject.Properties.Name | Sort-Object) -join ',') -ceq
                        (@($attemptedProof.PSObject.Properties.Name | Sort-Object) -join ',')) -and
                    [string](Get-StateValue $recordedProof 'provenance' '') -ceq [string]$attemptedProof.provenance
                foreach ($section in @('receipt', 'liveIdentity')) {
                    $recorded = if ($null -ne $recordedProof) { Get-StateValue $recordedProof $section $null } else { $null }
                    $attempted = Get-StateValue $attemptedProof $section $null
                    if ($null -eq $recorded -or
                        ((@($recorded.PSObject.Properties.Name | Sort-Object) -join ',') -cne
                            (@($attempted.PSObject.Properties.Name | Sort-Object) -join ','))) {
                        $proofMatches = $false
                        continue
                    }
                    foreach ($field in $attempted.PSObject.Properties.Name) {
                        if ((ConvertTo-Json -InputObject (Get-StateValue $recorded $field $null) -Compress) -cne
                            (ConvertTo-Json -InputObject (Get-StateValue $attempted $field $null) -Compress)) {
                            $proofMatches = $false
                        }
                    }
                }
                if (-not $proofMatches) {
                    Stop-Workflow 'authoritative terminal activation receipt lacks the exact immutable server proof'
                }
            }
            if ($exitCode -eq 0) {
                if ($alreadyResolved) { return 'already_resolved' }
                return 'resolved'
            }
            if ($alreadyResolved) {
                Stop-Workflow "mobile terminal activation retry was refused: $($output -join [Environment]::NewLine)"
            }
            return 'resolved_after_response_loss'
        }
        if ($exitCode -ne 0) {
            Stop-Workflow "mobile activation intent resolution failed and remains unresolved: $($output -join [Environment]::NewLine)"
        }
        if ($null -ne $afterActive -and -not (Test-MobileActivationIntentIdentity $Intent $afterActive)) {
            Stop-Workflow 'mobile activation registry changed to a different active intent during resolution'
        }
        Stop-Workflow 'mobile activation intent resolution returned without an authoritative terminal receipt'
    } finally {
        Remove-Item -LiteralPath $intentPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $auditPath -Force -ErrorAction SilentlyContinue
    }
}

function Test-ReceiptMutationEvidence {
    param([Parameter(Mandatory = $true)]$Receipt)
    $required = @(
        'mutation_evidence_complete', 'migration_started', 'migration_completed',
        'migration_outcome_uncertain', 'activation_started', 'activation_completed',
        'rollback_result'
    )
    foreach ($field in $required) {
        if ($null -eq $Receipt.PSObject.Properties[$field]) { return $false }
    }
    if ($Receipt.PSObject.Properties['mutation_evidence_complete'].Value -isnot [bool] -or
        -not [bool]$Receipt.PSObject.Properties['mutation_evidence_complete'].Value) {
        return $false
    }
    foreach ($field in @('migration_started', 'migration_completed',
            'migration_outcome_uncertain', 'activation_started', 'activation_completed')) {
        if ($Receipt.PSObject.Properties[$field].Value -isnot [bool]) { return $false }
    }
    return [string]$Receipt.PSObject.Properties['rollback_result'].Value -in @(
        'not_required', 'prepared', 'running', 'completed', 'failed',
        'blocked_migration_compatibility_uncertain')
}

function Test-ReceiptNoMutation {
    param([Parameter(Mandatory = $true)]$Receipt)
    if (-not (Test-ReceiptMutationEvidence $Receipt)) { return $false }
    return -not [bool]$Receipt.PSObject.Properties['activation_started'].Value -and
        -not [bool]$Receipt.PSObject.Properties['activation_completed'].Value -and
        -not [bool]$Receipt.PSObject.Properties['migration_started'].Value -and
        -not [bool]$Receipt.PSObject.Properties['migration_outcome_uncertain'].Value -and
        [string](Get-StateValue $Receipt 'activation_result' 'pending') -in @('pending', 'failed') -and
        [string](Get-StateValue $Receipt 'migration_result' 'pending') -in @('pending', 'not_required', 'failed') -and
        [string]$Receipt.PSObject.Properties['rollback_result'].Value -eq 'not_required'
}

function Resolve-MobileActivationIntent {
    param(
        [Parameter(Mandatory = $true)][string]$CandidateWorktree,
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)]$Receipt
    )
    if ([bool](Get-StateValue $State 'activation_intent_resolved' $false)) { return }
    $intent = Get-StateValue $State 'activation_intent' $null
    $intentId = [string](Get-StateValue $State 'activation_intent_id' '')
    if ($null -eq $intent -or $intentId -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$') {
        Stop-Workflow 'cannot resolve activation intent without its exact durable identity'
    }
    if (-not (Test-ReceiptMutationEvidence $Receipt)) {
        Stop-Workflow 'activation intent cannot be resolved without complete authoritative mutation evidence'
    }
    $target = [string](Get-StateValue $Receipt 'requested_target_sha' '')
    if (-not $target) { $target = [string](Get-StateValue $Receipt 'target_sha' '') }
    $receiptResult = [string](Get-StateValue $Receipt 'result' '')
    $activePublic = [string](Get-StateValue $Receipt 'active_public_sha' '')
    $activeGame = [string](Get-StateValue $Receipt 'active_game_sha' '')
    $expectedGame = if ([string](Get-StateValue $State 'release_class' '') -eq 'client_only') {
        [string](Get-StateValue $State 'prepared_server_component_sha' '')
    } else { $target }
    $rollback = [string]$Receipt.PSObject.Properties['rollback_result'].Value
    $exactLive = $receiptResult -eq 'completed' -and $activePublic -eq $target -and $activeGame -eq $expectedGame
    $provenRollback = $receiptResult -eq 'failed' -and $rollback -eq 'completed' -and
        $activePublic -eq [string](Get-StateValue $State 'prepared_live_public_release_sha' '') -and
        $activeGame -eq [string](Get-StateValue $State 'prepared_live_game_link_sha' '')
    $preparedGame = [string](Get-StateValue $State 'prepared_live_game_link_sha' '')
    $preparedPublic = [string](Get-StateValue $State 'prepared_live_public_release_sha' '')
    $preparationGame = [string](Get-StateValue $Receipt 'preparation_live_game_sha' '')
    $preparationPublic = [string](Get-StateValue $Receipt 'preparation_live_public_sha' '')
    $truth = Get-StateValue $State 'reconciled_remote_truth' $null
    if (-not $activeGame) { $activeGame = $preparationGame }
    if (-not $activePublic) { $activePublic = $preparationPublic }
    if (-not $activeGame -and $null -ne $truth) {
        $activeGame = [string](Get-StateValue $truth 'deployed_sha' '')
    }
    if (-not $activePublic -and $null -ne $truth) {
        $activePublic = [string](Get-StateValue $truth 'public_release_sha' '')
    }
    $noMutation = (Test-ReceiptNoMutation $Receipt) -and
        (($receiptResult -eq 'prepared') -or
            ($receiptResult -eq 'failed' -and $rollback -eq 'not_required')) -and
        $preparedGame -match '^[0-9a-f]{40}$' -and
        $preparedPublic -match '^[0-9a-f]{40}$' -and
        $activeGame -eq $preparedGame -and $activePublic -eq $preparedPublic
    $resolutionKind = if ($exactLive) { 'completed' } elseif ($provenRollback) {
        'rolled_back'
    } elseif ($noMutation) { 'canceled_no_mutation' } else { '' }
    if (-not $resolutionKind) {
        Stop-Workflow 'activation intent cannot be resolved before exact live completion, proven rollback, or proven no-mutation cancellation'
    }
    $terminalReceipt = if ($exactLive) { $Receipt } else { $null }
    $remoteResolution = Resolve-MobileActivationIntentRemote $CandidateWorktree $intent -State $State -TerminalReceipt $terminalReceipt
    if ($remoteResolution -notin @('resolved', 'resolved_after_response_loss', 'already_resolved')) {
        Stop-Workflow 'mobile activation registry has no exact active or resolved intent for terminal reconciliation'
    }
    $State.activation_intent_terminal_result = $resolutionKind
    $State.activation_registry_resolved_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    $State.activation_intent_resolved = $true
    Write-State $State
}

function Assert-BatchAuthorization {
    param([Parameter(Mandatory = $true)]$State)
    if (-not [bool]$State.batch_release_authorized) {
        Stop-Workflow ('batch IntegrateAndPublish requires -ConfirmCombinedRelease or all granular ' +
            'integration, generation, atomic publication, and deployment confirmations')
    }
}

function Assert-MasterPublicationAuthorization {
    if (-not $ApprovedIntegrationTest) { Stop-Workflow 'publication requires -ApprovedIntegrationTest' }
    if (-not $ConfirmPublish) { Stop-Workflow 'publication requires -ConfirmPublish' }
}

function Assert-DeploymentAuthorization {
    Assert-MasterPublicationAuthorization
    if (-not $ConfirmDeploy) { Stop-Workflow 'deployment requires -ConfirmDeploy' }
}

function Invoke-IntegrationWorkflow {
    param([Parameter(Mandatory = $true)]$State)
    Assert-IntegrationAuthorization $State

    Invoke-Phase $State 'initial_remote_snapshot' {
        $snapshot = Get-GenerationStatus
        $baselineGeneration = if ($snapshot.generation) {
            [string]$snapshot.generation
        } elseif ([bool]$snapshot.infrastructure_head_accepted) {
            [string]$snapshot.latest_generation
        } else {
            Stop-Workflow "untagged protected head is not admitted: $($snapshot.infrastructure_head_reason)"
        }
        if ($State.effective_base_test_generation) {
            $baseTag = @($snapshot.generation_refs | Where-Object name -eq "test/$($State.effective_base_test_generation)")
            if ($baseTag.Count -ne 1 -or [string]$baseTag[0].commit_sha -ne [string]$State.effective_base_test_sha) {
                Stop-Workflow "remote test/$($State.effective_base_test_generation) does not equal recorded effective base $($State.effective_base_test_sha)"
            }
            $nextGenerationNumber = [int]$baselineGeneration.Substring(1) + 1
            if ([int]$State.effective_base_test_generation.Substring(1) -ge $nextGenerationNumber) {
                Stop-Workflow 'effective-base generation must be older than the resulting merged generation'
            }
        }
        if (-not $State.original_integration_sha) {
            $State.original_integration_sha = [string]$snapshot.integration_test_sha
            $State.original_master_sha = [string]$snapshot.master_sha
            $State.previous_generation = $baselineGeneration
            $State.original_integration_generation = $baselineGeneration
            $State.expected_remote_tag_namespace_snapshot = [string]$snapshot.snapshot_id
            Write-State $State
        } elseif ($State.original_integration_sha -ne [string]$snapshot.integration_test_sha -and
            $State.candidate_integration_sha -ne [string]$snapshot.integration_test_sha) {
            Stop-Workflow "remote integration tip differs from both recorded original and candidate"
        }
        if (-not $State.original_master_sha) {
            Stop-Workflow 'operation does not record the original master lease SHA'
        }
        if ([string]$snapshot.master_sha -ne [string]$State.original_master_sha -and
            [string]$snapshot.master_sha -ne [string]$State.candidate_integration_sha) {
            Stop-Workflow 'remote master differs from both recorded original and candidate'
        }
        Invoke-Git $IntegrationWorktree @('merge-base', '--is-ancestor',
            [string]$State.original_master_sha, [string]$State.original_integration_sha)
        "$baselineGeneration@$($snapshot.integration_test_sha) infrastructure_head=$($snapshot.infrastructure_head_accepted)"
    } | Out-Null

    if ([string]$State.requested_mode -eq 'IntegrateAndPublish') {
        Invoke-Phase $State 'live_production_integrity_preflight' {
            Assert-LiveProductionIntegrity $State
        } | Out-Null
    }

    Invoke-Phase $State 'feature_and_worktree_validation' {
        if (-not $State.feature_worktree) { Stop-Workflow '-FeatureWorktree is required for integration' }
        $featureRoot = Get-AshAtlasCanonicalPath ([string]$State.feature_worktree)
        $featureGitRoot = Get-GitText $featureRoot @('rev-parse', '--show-toplevel')
        if (-not (Test-AshAtlasSamePath $featureGitRoot $featureRoot)) { Stop-Workflow 'feature worktree identity differs' }
        if (-not (Test-FeatureAdmissionStatus (
                    Get-GitText $featureRoot @('status', '--porcelain')))) {
            Stop-Workflow 'feature worktree is dirty'
        }
        $branch = Get-GitText $featureRoot @('branch', '--show-current')
        if ($branch -notmatch '^(feature|fix|chore|audit)/') { Stop-Workflow "feature branch is not eligible: $branch" }
        $historicalGeneration = if ($branch -match '--from-(t\d{3,4})$') { $Matches[1] } else { '' }
        $tip = Get-GitCommitId $featureRoot 'HEAD'
        if ((Get-RemoteFeatureSha $branch) -ne $tip) { Stop-Workflow "origin/$branch does not equal exact feature tip $tip" }
        if (-not $State.effective_base_test_generation) {
            $mergeBase = Get-GitText $featureRoot @(
                'merge-base', $tip, [string]$State.original_integration_sha)
            $baseGeneration = $historicalGeneration
            if (-not $baseGeneration) {
                $pointingTags = @(Get-GitFields $featureRoot @(
                        'tag', '--points-at', $mergeBase, '--list', 'test/t*') |
                    Where-Object { $_ -match '^test/t\d{3,4}$' })
                if ($pointingTags.Count -eq 1) { $baseGeneration = $pointingTags[0].Substring(5) }
            }
            if ($baseGeneration) {
                $baseSha = Get-GitText $featureRoot @('rev-list', '-n', '1', "test/$baseGeneration")
                if ($baseSha -eq $mergeBase) {
                    $State.effective_base_test_generation = $baseGeneration
                    $State.effective_base_test_sha = $baseSha
                }
            }
        }
        if ($State.effective_base_test_generation) {
            $baseSha = [string]$State.effective_base_test_sha
            Invoke-Git $featureRoot @('merge-base', '--is-ancestor', $baseSha, $tip)
            if ($tip -eq $baseSha) { Stop-Workflow "feature tip is not newer than effective base $baseSha" }
            $mergeBase = Get-GitText $featureRoot @('merge-base', $tip, [string]$State.original_integration_sha)
            if ($mergeBase -ne $baseSha) {
                Stop-Workflow "feature merge base with original integration target is $mergeBase, not effective base $baseSha"
            }
        }
        Assert-CleanWorktree $IntegrationWorktree 'integration/test' 'dedicated integration worktree'
        $localIntegration = Get-GitCommitId $IntegrationWorktree 'HEAD'
        if ($localIntegration -ne $State.original_integration_sha -and $localIntegration -ne $State.candidate_integration_sha) {
            Stop-Workflow "local integration worktree is at unexpected SHA $localIntegration"
        }
        $State.feature_worktree = $featureRoot
        $State.feature_branch = $branch
        $State.feature_tip = $tip
        $State.historical_name_base_generation = $historicalGeneration
        Write-State $State
        "$branch@$tip historical=$historicalGeneration effective=$($State.effective_base_test_generation)"
    } | Out-Null

    Invoke-Phase $State 'local_merge' {
        $head = Get-GitCommitId $IntegrationWorktree 'HEAD'
        $mergePhase = $State.phases.PSObject.Properties['local_merge']
        $mergeWasInterrupted = $null -ne $mergePhase -and @(
            $mergePhase.Value.attempts | Where-Object { [string]$_.status -eq 'interrupted' }
        ).Count -gt 0
        if ($State.candidate_integration_sha -and $head -eq $State.candidate_integration_sha) {
            if ($mergeWasInterrupted) {
                Require-CandidateAdmission $State 'local merge phase was interrupted after the candidate was created'
            }
            return "reconciled candidate $head"
        }
        if (-not $State.candidate_integration_sha -and $head -ne $State.original_integration_sha) {
            $parents = Get-GitFields $IntegrationWorktree @('show', '-s', '--format=%P', $head)
            if (Test-ExactMergeParents $parents $State.original_integration_sha $State.feature_tip) {
                Assert-CommitPlayerPatchNote $IntegrationWorktree $head `
                    ([string]$State.player_patch_note)
                $State.candidate_integration_sha = $head
                Require-CandidateAdmission $State 'candidate merge was recovered from an interrupted local merge'
                Write-State $State
                return "reconciled interrupted local merge $head"
            }
            Stop-Workflow "cannot reconcile unexpected local integration SHA $head"
        }
        if ($head -ne $State.original_integration_sha) { Stop-Workflow "cannot merge from unexpected local integration SHA $head" }
        Invoke-Git $IntegrationWorktree @(
            'merge', '--no-ff',
            '-m', (Get-IntegrationMergeMessage `
                "Merge $($State.feature_branch) into integration/test" `
                ([string]$State.player_patch_note)),
            [string]$State.feature_tip
        )
        $candidate = Get-GitCommitId $IntegrationWorktree 'HEAD'
        $parents = Get-GitFields $IntegrationWorktree @('show', '-s', '--format=%P', $candidate)
        if (-not (Test-ExactMergeParents $parents $State.original_integration_sha $State.feature_tip)) {
            Stop-Workflow 'candidate merge parents do not equal exact original integration and feature tip'
        }
        Assert-CommitPlayerPatchNote $IntegrationWorktree $candidate ([string]$State.player_patch_note)
        $State.candidate_integration_sha = $candidate
        Write-State $State
        "candidate $candidate"
    } | Out-Null

    Invoke-Phase $State 'focused_admission' {
        if ([bool](Get-StateValue $State 'candidate_admission_required' $false) -and
            [string]$State.admission_mode -ne 'Command') {
            Stop-Workflow 'conflict-resolved or interrupted candidate requires Command admission on the merged checkout'
        }
        if ([string]$State.admission_mode -eq 'Command') {
            Invoke-FocusedCandidateAdmission $State
        } else {
            $candidate = [string]$State.candidate_integration_sha
            $candidateRoot = Get-GitText $IntegrationWorktree @('rev-parse', '--show-toplevel')
            Assert-CleanWorktree $IntegrationWorktree 'integration/test' 'preserved admission candidate worktree'
            if ((Get-GitCommitId $IntegrationWorktree 'HEAD') -ne $candidate) {
                Stop-Workflow 'preserved admission candidate SHA is no longer checked out'
            }
            $State.admission_candidate_sha = $candidate
            $State.admission_before_sha = $candidate
            $State.admission_after_sha = $candidate
            $State.admission_working_directory = $candidateRoot
            $State.admission_result = "preserved exact-feature verification; conflict-free merge at $candidate in cwd $candidateRoot"
            Write-State $State
        }
        $State.admission_result
    } | Out-Null

    if ([string]$State.requested_mode -eq 'IntegrateAndPublish') {
        Invoke-Phase $State 'installed_deployment_identity_preflight' {
            Assert-InstalledDeploymentIdentity $State
        } | Out-Null
        Invoke-Phase $State 'prepare_candidate_on_vps' {
            $expectedNumber = [int]$State.previous_generation.Substring(1) + 1
            $expectedGeneration = "t$($expectedNumber.ToString('D3'))"
            Invoke-PrepareCandidate $State ([string]$State.candidate_integration_sha) $expectedGeneration
        } | Out-Null
        Invoke-MobileBackwardCompatibilityGate $State $IntegrationWorktree `
            ([string]$State.candidate_integration_sha) | Out-Null
    }

    Invoke-Phase $State 'atomic_branch_and_generation_publication' {
        Require-ReleaseSideEffectReconciliation $State 'protected remote publication must be reconciled into local checkouts'
        if ((Get-RemoteFeatureSha ([string]$State.feature_branch)) -ne [string]$State.feature_tip) {
            Stop-Workflow "origin/$($State.feature_branch) changed before protected publication"
        }
        $candidateParents = Get-GitFields $IntegrationWorktree @(
            'show', '-s', '--format=%P', [string]$State.candidate_integration_sha)
        if (-not (Test-ExactMergeParents $candidateParents `
                ([string]$State.original_integration_sha) ([string]$State.feature_tip))) {
            Stop-Workflow 'candidate no longer has the exact original integration and feature-tip parents'
        }
        Assert-CommitPlayerPatchNote $IntegrationWorktree `
            ([string]$State.candidate_integration_sha) ([string]$State.player_patch_note)
        Invoke-Git $IntegrationWorktree @(
            'merge-base', '--is-ancestor', [string]$State.original_integration_sha,
            [string]$State.candidate_integration_sha)
        Invoke-Git $IntegrationWorktree @(
            'merge-base', '--is-ancestor', [string]$State.feature_tip,
            [string]$State.candidate_integration_sha)
        $prePublication = Get-GenerationStatus
        $expectedGenerationNumber = [int]$State.previous_generation.Substring(1) + 1
        $expectedGeneration = "t$($expectedGenerationNumber.ToString('D3'))"
        $completedTag = @($prePublication.generation_refs | Where-Object {
                [string]$_.name -eq "test/$expectedGeneration"
            })
        $completedPublication = [string]$prePublication.integration_test_sha -eq
                [string]$State.candidate_integration_sha -and
            (-not [bool]$State.atomic_master_publication -or
                [string]$prePublication.master_sha -eq [string]$State.candidate_integration_sha) -and
            $completedTag.Count -eq 1 -and
            [string]$completedTag[0].commit_sha -eq [string]$State.candidate_integration_sha -and
            [string]$prePublication.latest_generation -eq $expectedGeneration
        if ($completedPublication) {
            $State.new_generation = $expectedGeneration
            $State.atomic_push_result = 'reconciled completed atomic push'
            $State.remote_publication_succeeded = $true
            Write-State $State
            return "$expectedGeneration@$($State.candidate_integration_sha) already exact"
        }
        if ([string]$prePublication.integration_test_sha -ne [string]$State.original_integration_sha -or
            ([bool]$State.atomic_master_publication -and
                [string]$prePublication.master_sha -ne [string]$State.original_master_sha) -or
            [string]$prePublication.snapshot_id -ne [string]$State.expected_remote_tag_namespace_snapshot) {
            Stop-Workflow 'authoritative protected branch or generation namespace changed before protected publication'
        }
        if (@($prePublication.generation_refs | Where-Object name -eq "test/$expectedGeneration").Count -ne 0) {
            Stop-Workflow "expected next generation $expectedGeneration already exists before protected publication"
        }
        $output = @(& powershell -NoProfile -ExecutionPolicy Bypass `
            -File (Join-Path $RepositoryRoot 'tools\dev\test-generation.ps1') advance `
            -RepositoryPath $IntegrationWorktree `
            -IntegrationTestSha $State.candidate_integration_sha `
            -ExpectedIntegrationTestSha $State.original_integration_sha `
            $(if ([bool]$State.atomic_master_publication) { '-ExpectedMasterSha'; $State.original_master_sha }) `
            $(if ([bool]$State.atomic_master_publication) { '-PublishMaster' }) `
            -ConfirmGenerationCheckpoint -Json 2>&1)
        if ($LASTEXITCODE -ne 0) { Stop-Workflow "atomic generation publication failed: $($output -join [Environment]::NewLine)" }
        $published = ($output -join "`n") | ConvertFrom-Json
        # advance verifies the complete remote generation snapshot after its atomic push.
        $script:PublishedGenerationProof = $published
        $State.new_generation = [string]$published.new_generation
        $State.atomic_push_result = if ($published.already_completed) { 'reconciled completed atomic push' } else { 'atomic push completed' }
        $State.remote_publication_succeeded = $true
        Write-State $State
        "$($State.new_generation)@$($State.candidate_integration_sha)"
    } | Out-Null

    Invoke-Phase $State 'remote_verification' {
        $proof = $script:PublishedGenerationProof
        if ($null -ne $proof) {
            if ([string]$proof.integration_test_sha -cne [string]$State.candidate_integration_sha -or
                [string]$proof.new_generation -cne [string]$State.new_generation -or
                [string]$proof.snapshot_id -notmatch '^[0-9a-f]{64}$') {
                Stop-Workflow 'atomic generation result does not verify the candidate SHA and generation'
            }
        } else {
            # Resume has no in-process proof, so read the remote refs again.
            $snapshot = Get-GenerationStatus
            $tag = @($snapshot.generation_refs | Where-Object name -eq "test/$($State.new_generation)")
            if ($snapshot.integration_test_sha -ne $State.candidate_integration_sha -or
                $tag.Count -ne 1 -or [string]$tag[0].commit_sha -ne $State.candidate_integration_sha) {
                Stop-Workflow 'remote branch and immutable generation do not both equal candidate SHA'
            }
            if ([bool]$State.atomic_master_publication -and
                [string]$snapshot.master_sha -ne [string]$State.candidate_integration_sha) {
                Stop-Workflow 'remote master does not equal the atomically published candidate SHA'
            }
        }
        $State.remote_publication_succeeded = $true
        Write-State $State
        "verified $($State.new_generation)@$($State.candidate_integration_sha)"
    } | Out-Null

    Invoke-Phase $State 'local_checkout_reconciliation' {
        Invoke-LocalPublishedCheckoutReconciliation $State `
            ([string]$State.candidate_integration_sha) `
            -RequireMaster:([bool]$State.atomic_master_publication)
    } | Out-Null

    Invoke-Phase $State 'merged_receipt' {
        $arguments = @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass',
            '-File', (Join-Path $RepositoryRoot 'tools\dev\feature-runtime.ps1'),
            'mark-merged',
            '-WorktreePath', [string]$State.feature_worktree,
            '-MergedTestGeneration', [string]$State.new_generation,
            '-MergedTestSha', [string]$State.candidate_integration_sha,
            '-ConfirmAcceptedIntegration'
        )
        if ($DisplayName) { $arguments += @('-DisplayName', $DisplayName) }
        elseif ($State.display_name) { $arguments += @('-DisplayName', [string]$State.display_name) }
        if ($State.effective_base_test_generation) {
            $arguments += @(
                '-EffectiveBaseTestGeneration', [string]$State.effective_base_test_generation,
                '-EffectiveBaseTestSha', [string]$State.effective_base_test_sha
            )
        }
        $output = @(& powershell @arguments 2>&1)
        if ($LASTEXITCODE -ne 0) { Stop-Workflow "merged receipt failed: $($output -join [Environment]::NewLine)" }
        $State.merged_receipt_result = 'completed or already exact'
        Write-State $State
        $State.merged_receipt_result
    } | Out-Null
}

function Invoke-BatchMergedReceipts {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][string]$PhaseName
    )
    Invoke-Phase $State $PhaseName {
        foreach ($feature in @($State.batch_manifest)) {
            if ($feature.receipt_result) { continue }
            $arguments = @(
                '-NoProfile', '-ExecutionPolicy', 'Bypass',
                '-File', (Join-Path $RepositoryRoot 'tools\dev\feature-runtime.ps1'),
                'mark-merged',
                '-WorktreePath', [string]$feature.worktree,
                '-DisplayName', [string]$feature.display_name,
                '-MergedTestGeneration', [string]$State.new_generation,
                '-MergedTestSha', [string]$State.final_candidate_sha,
                '-EffectiveBaseTestGeneration', [string]$feature.effective_base_generation,
                '-EffectiveBaseTestSha', [string]$feature.effective_base_sha,
                '-BatchOperationId', [string]$State.operation_id,
                '-ConfirmAcceptedIntegration'
            )
            $output = @(& powershell @arguments 2>&1)
            if ($LASTEXITCODE -ne 0) {
                Stop-Workflow "merged receipt failed for $($feature.branch): $($output -join [Environment]::NewLine)"
            }
            $feature.receipt_result =
                "$($State.new_generation)@$($State.final_candidate_sha) batch=$($State.operation_id)"
            Write-State $State
        }
        $State.merged_receipt_result = 'all batch features have one exact shared release receipt'
        Write-State $State
        $State.merged_receipt_result
    } | Out-Null
}

function Invoke-BatchIntegrationWorkflow {
    param(
        [Parameter(Mandatory = $true)]$State,
        [switch]$AdmissionOnly
    )
    if ($AdmissionOnly) { Assert-BatchAdmissionAuthorization $State }
    else { Assert-BatchAuthorization $State }
    if ($AdmissionOnly) {
        Invoke-Phase $State 'batch_external_validator_preflight' {
            Assert-BatchValidatorConfigured $State | Out-Null
            'external uncredentialed validator is configured; native candidate execution remains disabled'
        } | Out-Null
    }

    $admissionSnapshot = $null
    if ($AdmissionOnly) {
        if ($null -eq $batchAdmissionManifest) {
            Stop-Workflow 'IntegrateBatchAdmission requires its immutable batch admission manifest on every run and Resume'
        }
        $admissionSnapshot = Get-BatchRemoteSnapshot $State
        Assert-BatchAdmissionProtectedSnapshot $batchAdmissionManifest $admissionSnapshot $State -AdmissionOnly
    }
    $manifestWasPresent = @($State.batch_manifest).Count -gt 0
    Invoke-Phase $State 'batch_initial_git_preflight' {
        $snapshot = if ($null -ne $admissionSnapshot) {
            $admissionSnapshot
        } else {
            Get-BatchRemoteSnapshot $State
        }
        if ($AdmissionOnly) {
            Set-StateValue $State 'batch_admission_reserved_generation' `
                ([string](Get-StateValue $batchAdmissionManifest 'reserved_generation' ''))
            Set-StateValue $State 'batch_admission_original_source_sha' `
                ([string](Get-StateValue $batchAdmissionManifest 'original_source_sha' ''))
            Set-StateValue $State 'batch_admission_original_master_sha' `
                ([string](Get-StateValue $batchAdmissionManifest 'original_master_sha' ''))
        }
        $pinnedOriginalSha = [string](Get-StateValue $State 'original_integration_sha' '')
        if ($pinnedOriginalSha) {
            $pinnedMasterSha = [string](Get-StateValue $State 'original_master_sha' '')
            $pinnedGeneration = [string](Get-StateValue $State 'original_integration_generation' (
                    Get-StateValue $State 'previous_generation' ''))
            $pinnedSnapshotId = [string](Get-StateValue $State 'expected_remote_tag_namespace_snapshot' '')
            if ($pinnedOriginalSha -notmatch '^[0-9a-f]{40}$' -or
                $pinnedMasterSha -notmatch '^[0-9a-f]{40}$' -or
                $pinnedGeneration -notmatch '^t\d{3,4}$' -or
                $pinnedSnapshotId -notmatch '^[0-9a-f]{64}$') {
                Stop-Workflow 'batch Resume has an incomplete pinned protected snapshot identity'
            }
            $generationRefs = @((Get-StateValue $snapshot 'generation_refs' @()))
            if ($generationRefs.Count -eq 0) {
                $generationRefs = @((Get-StateValue $snapshot 'generations' @()))
            }
            $heldAdmission = $AdmissionOnly -and
                [bool](Get-StateValue $State 'batch_admission_accepted' $false) -and
                [string](Get-StateValue $State 'accepted_integration_sha' '') -match '^[0-9a-f]{40}$' -and
                [string](Get-StateValue $State 'accepted_generation' '') -match '^t\d{3,4}$' -and
                [string]$snapshot.integration_test_sha -ceq [string](Get-StateValue $State 'accepted_integration_sha' '') -and
                [string]$snapshot.master_sha -ceq $pinnedMasterSha -and
                [string]$snapshot.latest_generation -ceq [string](Get-StateValue $State 'accepted_generation' '') -and
                @($generationRefs | Where-Object {
                    [string]$_.name -ceq "test/$([string](Get-StateValue $State 'accepted_generation' ''))" -and
                    [string]$_.commit_sha -ceq [string](Get-StateValue $State 'accepted_integration_sha' '')
                }).Count -eq 1
            if (-not $heldAdmission -and
                ([string]$snapshot.integration_test_sha -cne $pinnedOriginalSha -or
                 [string]$snapshot.master_sha -cne $pinnedMasterSha -or
                 [string]$snapshot.latest_generation -cne $pinnedGeneration -or
                 [string]$snapshot.snapshot_id -cne $pinnedSnapshotId)) {
                Stop-Workflow 'batch Resume observed a newer or changed protected snapshot than the pinned operation identity'
            }
            if ([string]$snapshot.integration_test_sha -cne [string]$snapshot.master_sha -and -not $heldAdmission) {
                Stop-Workflow 'batch release cannot resume over unrelated integration changes while master is held'
            }
        } else {
            if ([string]$snapshot.integration_test_sha -cne [string]$snapshot.master_sha) {
                Stop-Workflow 'batch release requires master and integration/test to start at one exact protected head'
            }
            $State.original_integration_sha = [string]$snapshot.integration_test_sha
            $State.original_master_sha = [string]$snapshot.master_sha
            $State.previous_generation = [string]$snapshot.latest_generation
            $State.original_integration_generation = [string]$snapshot.latest_generation
            $State.latest_gameplay_generation = [string]$snapshot.latest_generation
            $State.latest_gameplay_generation_sha = [string]$snapshot.latest_generation_sha
            $State.expected_remote_tag_namespace_snapshot = [string]$snapshot.snapshot_id
            Write-State $State
        }
        if (@($State.batch_manifest).Count -gt 0) {
            Assert-BatchManifestUnchanged $State
            return "reused immutable manifest with $(@($State.batch_manifest).Count) features"
        }
        $State.atomic_master_publication = -not $AdmissionOnly
        $State.batch_manifest = @(Get-BatchFeatureManifest $State $snapshot)
        $State.accepted_original_integration_sha = [string]$snapshot.integration_test_sha
        $State.accepted_original_integration_generation = [string]$snapshot.latest_generation
        Write-State $State
        "one snapshot; $(@($State.batch_manifest).Count) frozen features"
    } | Out-Null

    if (@($State.batch_manifest).Count -eq 0) {
        Stop-Workflow 'batch manifest is unexpectedly empty after preflight'
    }
    if ($manifestWasPresent) { Assert-BatchManifestUnchanged $State }

    if (-not $AdmissionOnly) {
        Invoke-Phase $State 'live_production_integrity_preflight' {
            Assert-LiveProductionIntegrity $State
        } | Out-Null
    }

    if (-not $AdmissionOnly) {
        Invoke-Phase $State 'batch_exact_feature_verification' {
            Invoke-BatchFeatureVerification $State
            "$($State.validations_reused) reused; $($State.validations_executed) executed"
        } | Out-Null
    }

    Invoke-Phase $State 'batch_local_merge_chain' {
        $started = Get-Date
        $candidateItems = @(Invoke-BatchMergeChain $State)
        if ($candidateItems.Count -ne 1) {
            Stop-Workflow "batch merge chain returned $($candidateItems.Count) values; expected exactly one candidate SHA"
        }
        $candidate = [string]$candidateItems[0]
        Assert-CanonicalSha $candidate 'batch merge-chain candidate'
        $proof = Get-BatchMergeChainProof $State
        if ([string]$proof.staging_head_sha -cne $candidate) {
            Stop-Workflow 'batch merge-chain candidate does not equal independently proven staging HEAD'
        }
        if ($candidate -eq [string]$State.original_integration_sha) {
            Stop-Workflow 'every frozen feature tip is already contained; refusing a no-op gameplay tag and deployment'
        }
        $State.final_candidate_sha = $candidate
        $State.candidate_integration_sha = $candidate
        Write-State $State
        "$(@($State.merge_chain | Where-Object { -not $_.skipped }).Count) merges in $([math]::Round(((Get-Date) - $started).TotalMilliseconds)) ms"
    } | Out-Null

    Assert-BatchMergeChain $State
    $currentPlan = Get-BatchValidationPlan $State
    $currentToolchain = Get-BatchToolchainFingerprint $State
    $currentFingerprint = Get-BatchValidationPlanFingerprint $currentPlan $currentToolchain
    if ($AdmissionOnly) {
        Invoke-Phase $State 'batch_external_isolated_validation' {
            Invoke-IsolatedBatchValidation $State $currentPlan $currentToolchain | Out-Null
            'host-authenticated external uncredentialed validator receipt verified'
        } | Out-Null
    } else {
        $completedValidation = $State.phases.PSObject.Properties['batch_final_validation']
        if ($null -ne $completedValidation -and [string]$completedValidation.Value.status -eq 'completed' -and
            ([string]$State.validation_plan_fingerprint -ne $currentFingerprint -or
             [string]$State.validation_toolchain_fingerprint -ne $currentToolchain)) {
            Stop-Workflow 'completed final validation cannot be reused because its immutable fingerprint changed'
        }
        if ($null -ne $completedValidation -and [string]$completedValidation.Value.status -eq 'completed') {
            Assert-BatchValidationReceiptsComplete $State $currentPlan
        }
        Invoke-Phase $State 'batch_final_validation' {
            Invoke-BatchFinalValidation $State
            "$(@($State.validation_receipts).Count) final gates passed"
        } | Out-Null
    }

    if ($AdmissionOnly) {
        Invoke-Phase $State 'batch_admission_protected_publication' {
            Require-ReleaseSideEffectReconciliation $State `
                'batch admission protected publication must be reconciled into the integration checkout'
            Assert-BatchManifestUnchanged $State
            Assert-BatchMergeChain $State
            $prePublication = Get-GenerationStatus
            $expectedNumber = [int]$State.previous_generation.Substring(1) + 1
            $expectedGeneration = "t$($expectedNumber.ToString('D3'))"
            $completedTag = @($prePublication.generation_refs | Where-Object {
                    [string]$_.name -eq "test/$expectedGeneration"
                })
            $completedPublication = [string]$prePublication.integration_test_sha -eq
                    [string]$State.final_candidate_sha -and
                [string]$prePublication.master_sha -eq [string]$State.original_master_sha -and
                $completedTag.Count -eq 1 -and
                [string]$completedTag[0].commit_sha -eq [string]$State.final_candidate_sha -and
                [string]$prePublication.latest_generation -eq $expectedGeneration -and
                @($prePublication.generation_refs).Count -eq ($expectedNumber + 1)
            if ($completedPublication) {
                $State.new_generation = $expectedGeneration
                $State.accepted_generation = $expectedGeneration
                $State.accepted_integration_sha = [string]$State.final_candidate_sha
                $State.accepted_at_utc = (Get-Date).ToUniversalTime().ToString('o')
                $State.batch_admission_accepted = $true
                $State.atomic_push_result = 'reconciled completed atomic integration/test + tag push; master remained pinned'
                $State.remote_publication_succeeded = $true
                Write-State $State
                return "$expectedGeneration@$($State.final_candidate_sha) already exact; master remained $($State.original_master_sha)"
            }
            if ([string]$prePublication.integration_test_sha -ne [string]$State.original_integration_sha -or
                [string]$prePublication.master_sha -ne [string]$State.original_master_sha -or
                [string]$prePublication.snapshot_id -ne [string]$State.expected_remote_tag_namespace_snapshot) {
                Stop-Workflow 'protected refs or gameplay tag namespace changed after batch admission preflight'
            }
            if (@($prePublication.generation_refs | Where-Object name -eq "test/$expectedGeneration").Count -ne 0) {
                Stop-Workflow "next gameplay generation $expectedGeneration is already occupied"
            }
            $started = Get-Date
            $output = @(& powershell -NoProfile -ExecutionPolicy Bypass `
                -File (Join-Path $RepositoryRoot 'tools\dev\test-generation.ps1') advance `
                -RepositoryPath ([string]$State.staging_worktree) `
                -IntegrationTestSha ([string]$State.final_candidate_sha) `
                -ExpectedIntegrationTestSha ([string]$State.original_integration_sha) `
                -ExpectedSnapshotId ([string]$State.expected_remote_tag_namespace_snapshot) `
                -ConfirmGenerationCheckpoint -Json 2>&1)
            if ($LASTEXITCODE -ne 0) {
                Stop-Workflow "atomic batch admission publication failed: $($output -join [Environment]::NewLine)"
            }
            $published = ($output -join "`n") | ConvertFrom-Json
            $State.new_generation = [string]$published.new_generation
            $State.accepted_generation = [string]$published.new_generation
            $State.accepted_integration_sha = [string]$State.final_candidate_sha
            $State.accepted_at_utc = (Get-Date).ToUniversalTime().ToString('o')
            $State.batch_admission_accepted = $true
            $State.atomic_push_result = if ($published.already_completed) {
                'reconciled completed atomic integration/test + tag push; master remained pinned'
            } else { 'atomic integration/test + tag push completed; master remained pinned' }
            $State.remote_publication_succeeded = $true
            $State.atomic_publication_duration_ms =
                [math]::Round(((Get-Date) - $started).TotalMilliseconds)
            Write-State $State
            "$($State.new_generation)@$($State.final_candidate_sha); master remained $($State.original_master_sha)"
        } | Out-Null

        Invoke-Phase $State 'batch_admission_remote_publication_verification' {
            $snapshot = Get-GenerationStatus
            $tag = @($snapshot.generation_refs | Where-Object name -eq "test/$($State.accepted_generation)")
            if ([string]$snapshot.integration_test_sha -ne [string]$State.accepted_integration_sha -or
                [string]$snapshot.master_sha -ne [string]$State.original_master_sha -or
                $tag.Count -ne 1 -or [string]$tag[0].commit_sha -ne [string]$State.accepted_integration_sha) {
                Stop-Workflow 'batch admission publication did not leave exact integration/test + tag while preserving master'
            }
            $State.batch_admission_accepted = $true
            $State.remote_publication_succeeded = $true
            Write-State $State
            "integration/test and test/$($State.accepted_generation) verified exact; master preserved@$($State.original_master_sha)"
        } | Out-Null

        Invoke-Phase $State 'batch_admission_local_checkout_reconciliation' {
            Invoke-LocalPublishedCheckoutReconciliation $State `
                ([string]$State.accepted_integration_sha)
        } | Out-Null
        Invoke-BatchMergedReceipts $State 'batch_admission_merged_receipts'
        return
    }

    Invoke-Phase $State 'installed_deployment_identity_preflight' {
        Assert-InstalledDeploymentIdentity $State
    } | Out-Null

    Invoke-Phase $State 'prepare_candidate_on_vps' {
        $expectedNumber = [int]$State.previous_generation.Substring(1) + 1
        $expectedGeneration = "t$($expectedNumber.ToString('D3'))"
        Invoke-PrepareCandidate $State ([string]$State.final_candidate_sha) $expectedGeneration
    } | Out-Null

    Invoke-MobileBackwardCompatibilityGate $State ([string]$State.staging_worktree) `
        ([string]$State.final_candidate_sha) | Out-Null

    Invoke-Phase $State 'batch_atomic_protected_publication' {
        Require-ReleaseSideEffectReconciliation $State 'batch protected remote publication must be reconciled into local checkouts'
        Assert-BatchManifestUnchanged $State
        Assert-BatchMergeChain $State
        $prePublication = Get-GenerationStatus
        $expectedNumber = [int]$State.previous_generation.Substring(1) + 1
        $expectedGeneration = "t$($expectedNumber.ToString('D3'))"
        $completedTag = @($prePublication.generation_refs | Where-Object {
                [string]$_.name -eq "test/$expectedGeneration"
            })
        $completedPublication = [string]$prePublication.integration_test_sha -eq
                [string]$State.final_candidate_sha -and
            [string]$prePublication.master_sha -eq [string]$State.final_candidate_sha -and
            $completedTag.Count -eq 1 -and
            [string]$completedTag[0].commit_sha -eq [string]$State.final_candidate_sha -and
            [string]$prePublication.latest_generation -eq $expectedGeneration -and
            @($prePublication.generation_refs).Count -eq ($expectedNumber + 1)
        if ($completedPublication) {
            $State.new_generation = $expectedGeneration
            $State.atomic_push_result = 'reconciled completed atomic three-ref push'
            $State.remote_publication_succeeded = $true
            Write-State $State
            return "$expectedGeneration@$($State.final_candidate_sha) already exact"
        }
        if ([string]$prePublication.integration_test_sha -ne [string]$State.original_integration_sha -or
            [string]$prePublication.master_sha -ne [string]$State.original_master_sha -or
            [string]$prePublication.snapshot_id -ne [string]$State.expected_remote_tag_namespace_snapshot) {
            Stop-Workflow 'protected refs or gameplay tag namespace changed after batch preflight'
        }
        if (@($prePublication.generation_refs | Where-Object name -eq "test/$expectedGeneration").Count -ne 0) {
            Stop-Workflow "next gameplay generation $expectedGeneration is already occupied"
        }
        $started = Get-Date
        $output = @(& powershell -NoProfile -ExecutionPolicy Bypass `
            -File (Join-Path $RepositoryRoot 'tools\dev\test-generation.ps1') advance `
            -RepositoryPath ([string]$State.staging_worktree) `
            -IntegrationTestSha ([string]$State.final_candidate_sha) `
            -ExpectedIntegrationTestSha ([string]$State.original_integration_sha) `
            -ExpectedMasterSha ([string]$State.original_master_sha) `
            -ExpectedSnapshotId ([string]$State.expected_remote_tag_namespace_snapshot) `
            -PublishMaster -ConfirmGenerationCheckpoint -Json 2>&1)
        if ($LASTEXITCODE -ne 0) {
            Stop-Workflow "atomic batch publication failed: $($output -join [Environment]::NewLine)"
        }
        $published = ($output -join "`n") | ConvertFrom-Json
        $State.new_generation = [string]$published.new_generation
        $State.atomic_push_result = if ($published.already_completed) {
            'reconciled completed atomic three-ref push'
        } else { 'atomic integration/test + master + tag push completed' }
        $State.remote_publication_succeeded = $true
        $State.atomic_publication_duration_ms =
            [math]::Round(((Get-Date) - $started).TotalMilliseconds)
        Write-State $State
        "$($State.new_generation)@$($State.final_candidate_sha)"
    } | Out-Null

    Invoke-Phase $State 'batch_remote_publication_verification' {
        $snapshot = Get-GenerationStatus
        $tag = @($snapshot.generation_refs | Where-Object name -eq "test/$($State.new_generation)")
        if ([string]$snapshot.integration_test_sha -ne [string]$State.final_candidate_sha -or
            [string]$snapshot.master_sha -ne [string]$State.final_candidate_sha -or
            $tag.Count -ne 1 -or [string]$tag[0].commit_sha -ne [string]$State.final_candidate_sha) {
            Stop-Workflow 'batch atomic publication did not leave all three protected refs exact'
        }
        $State.remote_publication_succeeded = $true
        Write-State $State
        'integration/test, master, and one gameplay tag verified exact'
    } | Out-Null

    Invoke-Phase $State 'batch_local_checkout_reconciliation' {
        Invoke-LocalPublishedCheckoutReconciliation $State `
            ([string]$State.final_candidate_sha) -RequireMaster
    } | Out-Null

    Invoke-BatchMergedReceipts $State 'batch_merged_receipts'
}

function Get-BatchCandidatePipelineEvidence {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string]$ExpectedSha,
        [Parameter(Mandatory = $true)][string]$Label
    )
    if ($null -eq $Value) { Stop-Workflow "$Label is absent" }
    $rawJson = ConvertTo-Json -InputObject $Value -Depth 20 -Compress
    $items = if ($Value -is [Array]) {
        @($Value | ForEach-Object { if ($null -ne $_) { [string]$_ } })
    } else {
        @([string]$Value)
    }
    $lines = @()
    foreach ($item in $items) {
        $lines += @($item -split '\r?\n' | ForEach-Object { $_.Trim() } |
            Where-Object { $_ })
    }
    if ($lines.Count -lt 2 -or [string]$lines[-1] -cne $ExpectedSha) {
        Stop-Workflow "$Label is not the known success-stream pipeline-output form"
    }
    $priorCanonicalLine = @($lines | Where-Object { $_ -match '^[0-9a-f]{40}$' })
    if ($priorCanonicalLine.Count -ne 1 -or [string]$priorCanonicalLine[0] -cne $ExpectedSha) {
        Stop-Workflow "$Label contains an unexpected candidate identity before its final pipeline item"
    }
    return [pscustomobject][ordered]@{
        pipeline_output_class = 'success-stream-with-final-canonical-sha'
        raw_value = $Value
        raw_json_sha256 = Get-TextSha256 $rawJson
        flattened_item_count = $lines.Count
        final_item = [string]$lines[-1]
    }
}

function Get-BatchCandidateDeploymentProbe {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][string]$Candidate
    )
    $response = Invoke-DeploymentController $State status @()
    if ([int]$response.exit_code -ne 0 -or $null -eq $response.payload) {
        Stop-Workflow 'batch candidate identity reconciliation requires an available deployment status probe'
    }
    $payload = $response.payload
    if ([string](Get-StateValue $payload 'operation_id' '') -cne [string]$State.operation_id -or
        [string](Get-StateValue $payload 'operation_state' '') -cne 'genuinely_unknown' -or
        [string](Get-StateValue $payload 'result' '') -cne 'absent' -or
        [string](Get-StateValue $payload 'current_phase' '') -cne 'genuinely_unknown' -or
        [string](Get-StateValue $payload 'controller_state' '') -cne 'consistent' -or
        [string](Get-StateValue $payload 'unit_state' '') -ne 'inactive') {
        Stop-Workflow 'deployment status probe does not prove this candidate was never submitted or activated'
    }
    foreach ($field in @('active_game_sha', 'active_public_sha', 'target_sha', 'requested_target_sha')) {
        $value = [string](Get-StateValue $payload $field '')
        if ($value -and $value -notmatch '^[0-9a-f]{40}$') {
            Stop-Workflow "deployment status probe returned an unsafe $field"
        }
        if ($value -ceq $Candidate) {
            Stop-Workflow "deployment status probe shows the candidate in $field"
        }
    }
    return [pscustomobject][ordered]@{
        available = $true
        operation_id = [string]$State.operation_id
        operation_state = [string](Get-StateValue $payload 'operation_state' '')
        result = [string](Get-StateValue $payload 'result' '')
        current_phase = [string](Get-StateValue $payload 'current_phase' '')
        unit_state = [string](Get-StateValue $payload 'unit_state' '')
        controller_state = [string](Get-StateValue $payload 'controller_state' '')
        payload_json_sha256 = Get-TextSha256 (ConvertTo-Json -InputObject $payload -Depth 20 -Compress)
    }
}

function Get-BatchCandidatePublicProbe {
    param([Parameter(Mandatory = $true)][string]$Candidate)
    try {
        $release = Invoke-RestMethod -Uri 'https://playashatlas.com/play/release.json' -TimeoutSec 10
    } catch {
        Stop-Workflow "batch candidate identity reconciliation requires an available public release probe: $($_.Exception.Message)"
    }
    $publicSha = [string](Get-StateValue $release 'game_sha' '')
    Assert-CanonicalSha $publicSha 'public release SHA'
    if ($publicSha -ceq $Candidate) {
        Stop-Workflow 'public release probe shows the candidate is already public'
    }
    return [pscustomobject][ordered]@{
        available = $true
        uri = 'https://playashatlas.com/play/release.json'
        public_release_sha = $publicSha
        release_json_sha256 = Get-TextSha256 (ConvertTo-Json -InputObject $release -Depth 20 -Compress)
    }
}

function Assert-BatchCandidateIdentityRecoveryState {
    param([Parameter(Mandatory = $true)]$State)
    if (-not [bool](Get-StateValue $State 'is_batch' $false) -or
        [string](Get-StateValue $State 'requested_mode' '') -ne 'IntegrateAndPublish' -or
        -not [bool](Get-StateValue $State 'batch_release_authorized' $false)) {
        Stop-Workflow 'batch candidate identity reconciliation requires an authorized batch IntegrateAndPublish operation'
    }
    $existingIdentityAudit = Get-StateValue $State 'batch_candidate_identity_reconciliation' $null
    $allowedFailurePhases = @('', 'batch_local_merge_chain')
    if ($null -ne $existingIdentityAudit -and
        [string](Get-StateValue $existingIdentityAudit 'status' '') -eq 'completed') {
        $allowedFailurePhases += 'batch_final_validation'
    }
    if ([string](Get-StateValue $State 'status' '') -notin @('failed', 'running:batch_local_merge_chain') -or
        [string](Get-StateValue $State 'failure_phase' '') -notin $allowedFailurePhases) {
        Stop-Workflow 'batch candidate identity reconciliation requires the failed local merge-chain state'
    }
    $mergePhase = $State.phases.PSObject.Properties['batch_local_merge_chain']
    if ($null -eq $mergePhase -or [string]$mergePhase.Value.status -ne 'completed') {
        Stop-Workflow 'batch candidate identity reconciliation requires a completed batch merge-chain phase'
    }
    foreach ($phaseName in @(
            'batch_final_validation', 'installed_deployment_identity_preflight',
            'prepare_candidate_on_vps', 'batch_atomic_protected_publication',
            'batch_remote_publication_verification', 'batch_local_checkout_reconciliation',
            'batch_merged_receipts',
            'master_fast_forward_and_push', 'deployment',
            'host_readiness_and_public_world_verification')) {
        if ($null -ne $State.phases.PSObject.Properties[$phaseName]) {
            Stop-Workflow "batch candidate identity reconciliation refuses a started later phase: $phaseName"
        }
    }
    if ($null -ne (Get-StateValue $State 'final_validation_plan' $null) -or
        @((Get-StateValue $State 'validation_receipts' @())).Count -ne 0 -or
        @((Get-StateValue $State 'baseline_validation_receipts' @())).Count -ne 0 -or
        [string](Get-StateValue $State 'validation_plan_fingerprint' '') -or
        [string](Get-StateValue $State 'validation_toolchain_fingerprint' '') -or
        [string](Get-StateValue $State 'active_validation_gate' '')) {
        Stop-Workflow 'batch candidate identity reconciliation refuses evidence that combined validation started'
    }
    Assert-CanonicalSha ([string](Get-StateValue $State 'original_integration_sha' '')) `
        'recorded original integration SHA'
    Assert-CanonicalSha ([string](Get-StateValue $State 'original_master_sha' '')) `
        'recorded original master SHA'
    Assert-CanonicalSha ([string](Get-StateValue $State 'latest_gameplay_generation_sha' '')) `
        'recorded latest gameplay generation SHA'
    $expectedSnapshot = [string](Get-StateValue $State 'expected_remote_tag_namespace_snapshot' '')
    if ($expectedSnapshot -cnotmatch '^[0-9a-f]{64}$') {
        Stop-Workflow 'recorded gameplay generation namespace snapshot is not canonical'
    }
    if ([string](Get-StateValue $State 'previous_generation' '') -notmatch '^t\d{3,4}$' -or
        [string](Get-StateValue $State 'latest_gameplay_generation' '') -ne
            [string](Get-StateValue $State 'previous_generation' '')) {
        Stop-Workflow 'recorded batch base generation identity is incomplete or inconsistent'
    }
    if ([string](Get-StateValue $State 'staging_worktree' '') -eq '' -or
        [string](Get-StateValue $State 'staging_branch' '') -notmatch '^integration/batch-release-[0-9a-f]{10}--from-t\d{3,4}$') {
        Stop-Workflow 'recorded batch staging identity is incomplete or unsafe'
    }
    foreach ($field in @(
            'new_generation', 'release_candidate_ref', 'atomic_push_result',
            'master_publication_result', 'exact_deployed_sha', 'exact_public_release_sha',
            'deployment_target_sha', 'deployment_status_token', 'deployment_request_parent',
            'deployment_request_commit', 'deployment_request_manifest_sha256',
            'deployment_submission_target_sha', 'deployment_submission_updater_hash',
            'deployment_submission_first_attempt_at_utc', 'deployment_admission_discovered_at_utc',
            'deployment_completion_discovered_at_utc', 'prepared_receipt_sha256',
            'prepared_descriptor_sha256', 'release_protocol', 'deployment_failure_message',
            'admission_result', 'merged_receipt_result', 'deployment_verification_result')) {
        if ([string](Get-StateValue $State $field '')) {
            Stop-Workflow "batch candidate identity reconciliation found publication or deployment evidence in $field"
        }
    }
    foreach ($field in @(
            'prepared_descriptor_version', 'release_classification_version',
            'prepared_game_main_pid', 'prepared_game_start_timestamp_monotonic')) {
        if ([int](Get-StateValue $State $field 0) -ne 0) {
            Stop-Workflow "batch candidate identity reconciliation found preparation evidence in $field"
        }
    }
    foreach ($field in @(
            'release_class', 'release_classification_evidence_sha256', 'release_changed_paths_sha256',
            'prepared_server_component_sha', 'prepared_server_artifact_sha256',
            'prepared_client_component_sha', 'prepared_client_artifact_sha256',
            'prepared_static_artifact_fence_sha256', 'prepared_release_metadata_fence_sha256',
            'prepared_live_game_link_sha', 'prepared_live_public_link_sha',
            'prepared_live_public_release_sha')) {
        if ([string](Get-StateValue $State $field '')) {
            Stop-Workflow "batch candidate identity reconciliation found preparation evidence in $field"
        }
    }
    $pendingIntent = Get-StateValue $State 'remote_side_effect_intent' $null
    if ($null -ne $pendingIntent -and
        [string](Get-StateValue $pendingIntent 'status' '') -eq 'pending') {
        Stop-Workflow 'batch candidate identity reconciliation found an unresolved remote side-effect intent'
    }
    if ($null -ne (Get-StateValue $State 'remote_deployment_receipt' $null) -or
        [bool](Get-StateValue $State 'deployment_start_attempted' $false) -or
        [bool](Get-StateValue $State 'deployment_automatic_reconciliation_required' $false) -or
        [int](Get-StateValue $State 'deployment_submission_attempt_count' 0) -ne 0 -or
        [int](Get-StateValue $State 'deployment_submission_retry_count' 0) -ne 0 -or
        [int](Get-StateValue $State 'deployment_start_connection_count' 0) -ne 0 -or
        [int](Get-StateValue $State 'deployment_prepare_connection_count' 0) -ne 0 -or
        [int](Get-StateValue $State 'deployment_activate_connection_count' 0) -ne 0 -or
        [int](Get-StateValue $State 'deployment_result_connection_count' 0) -ne 0) {
        Stop-Workflow 'batch candidate identity reconciliation found deployment submission evidence'
    }
    $submissionState = [string](Get-StateValue $State 'deployment_submission_state' 'pending_submission')
    if ($submissionState -ne 'pending_submission') {
        Stop-Workflow 'batch candidate identity reconciliation found a non-pending deployment submission state'
    }
}

function Invoke-BatchCandidateIdentityReconciliation {
    param([Parameter(Mandatory = $true)]$State)
    if (-not $ConfirmBatchCandidateIdentityReconciliation) {
        Stop-Workflow 'batch candidate identity reconciliation requires -ConfirmBatchCandidateIdentityReconciliation'
    }
    Assert-BatchCandidateIdentityRecoveryState $State
    $chainProof = Get-BatchMergeChainProof $State
    $candidate = [string]$chainProof.staging_head_sha
    $candidateRef = "refs/heads/integration/release-candidates/$($State.operation_id)"
    $candidateRefRemote = @(Get-GitFields (Get-GameRepositoryRoot) @(
            'ls-remote', '--heads', 'origin', $candidateRef
        ))
    if ($candidateRefRemote.Count -ne 0) {
        Stop-Workflow 'batch candidate identity reconciliation found a remote release-candidate ref'
    }
    $snapshot = Get-GenerationStatus
    if ([string]$snapshot.integration_test_sha -cne [string]$State.original_integration_sha -or
        [string]$snapshot.master_sha -cne [string]$State.original_master_sha -or
        [string]$snapshot.snapshot_id -cne [string]$State.expected_remote_tag_namespace_snapshot -or
        [string]$snapshot.latest_generation -cne [string]$State.previous_generation -or
        [string]$snapshot.latest_generation_sha -cne [string]$State.latest_gameplay_generation_sha) {
        Stop-Workflow 'protected refs or gameplay generation namespace changed since batch preflight'
    }
    $candidateGenerationMatches = @($snapshot.generation_refs | Where-Object {
            [string]$_.commit_sha -ceq $candidate
        })
    if ($candidateGenerationMatches.Count -ne 0) {
        Stop-Workflow 'batch candidate already appears in an immutable gameplay generation'
    }
    $deploymentProof = Get-BatchCandidateDeploymentProbe $State $candidate
    $publicProof = Get-BatchCandidatePublicProbe $candidate
    $priorFinal = Get-StateValue $State 'final_candidate_sha' $null
    $priorIntegration = Get-StateValue $State 'candidate_integration_sha' $null
    $audit = Get-StateValue $State 'batch_candidate_identity_reconciliation' $null
    $existingAuditCompleted = $null -ne $audit -and
        [string](Get-StateValue $audit 'status' '') -eq 'completed'
    $alreadyReconciled = $existingAuditCompleted -and
        [string]$State.final_candidate_sha -ceq $candidate -and
        [string]$State.candidate_integration_sha -ceq $candidate
    if ($existingAuditCompleted -and -not $alreadyReconciled) {
        Stop-Workflow 'existing batch candidate identity reconciliation audit does not match the current candidate fields'
    }
    if (-not $alreadyReconciled) {
        $finalEvidence = Get-BatchCandidatePipelineEvidence $priorFinal $candidate `
            'recorded final candidate SHA'
        $integrationEvidence = Get-BatchCandidatePipelineEvidence $priorIntegration $candidate `
            'recorded integration candidate SHA'
        $toolCommit = Get-GitCommitId $RepositoryRoot 'HEAD'
        $audit = [pscustomobject][ordered]@{
            schema_version = 1
            status = 'completed'
            operation_id = [string]$State.operation_id
            prior_final_candidate_sha = $priorFinal
            prior_candidate_integration_sha = $priorIntegration
            prior_final_candidate_sha_json_sha256 = [string]$finalEvidence.raw_json_sha256
            prior_candidate_integration_sha_json_sha256 = [string]$integrationEvidence.raw_json_sha256
            repaired_sha = $candidate
            chain_proof = $chainProof
            staging_proof = [pscustomobject][ordered]@{
                path = [string]$State.staging_worktree
                branch = [string]$State.staging_branch
                head_sha = $candidate
                clean = $true
            }
            protected_proof = [pscustomobject][ordered]@{
                original_integration_sha = [string]$State.original_integration_sha
                original_master_sha = [string]$State.original_master_sha
                integration_test_sha = [string]$snapshot.integration_test_sha
                master_sha = [string]$snapshot.master_sha
                generation = [string]$snapshot.latest_generation
                generation_sha = [string]$snapshot.latest_generation_sha
                snapshot_id = [string]$snapshot.snapshot_id
                generation_ref_candidate_matches = $candidateGenerationMatches.Count
            }
            candidate_ref_proof = [pscustomobject][ordered]@{
                ref = $candidateRef
                absent = $true
            }
            deployment_probe = $deploymentProof
            public_probe = $publicProof
            repair_tool_commit_sha = $toolCommit
            reconciled_at_utc = (Get-Date).ToUniversalTime().ToString('o')
        }
        $State.final_candidate_sha = $candidate
        $State.candidate_integration_sha = $candidate
        $State.status = 'failed'
        $State.failure_phase = 'batch_final_validation'
        $State.completed_at_utc = ''
        Set-StateValue $State 'batch_candidate_identity_reconciliation' $audit
        Write-State $State
    } else {
        if ([string](Get-StateValue $audit 'repaired_sha' '') -cne $candidate -or
            [string](Get-StateValue $audit 'operation_id' '') -cne [string]$State.operation_id) {
            Stop-Workflow 'existing batch candidate identity reconciliation audit does not match the proven candidate'
        }
    }
    return [pscustomobject][ordered]@{
        operation_id = [string]$State.operation_id
        status = 'completed'
        repaired_sha = $candidate
        resumable_phase = 'batch_final_validation'
        idempotent = $alreadyReconciled
    }
}

function Assert-FinalDeploymentEvidence {
    param(
        [Parameter(Mandatory = $true)]$Status,
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][string]$Target,
        [Parameter(Mandatory = $true)]$Release,
        [Parameter(Mandatory = $true)]$Session,
        [Parameter(Mandatory = $true)]$World
    )
    Assert-DeploymentStatusPayload $Status $State $Target
    if ([string]$Status.result -ne 'completed') {
        Stop-Workflow 'public visibility cannot replace a completed authoritative deployment status'
    }
    if ([string]$Release.game_sha -ne $Target) {
        Stop-Workflow "public release identity does not equal $Target"
    }
    if ([string]$Release.release_class -ne [string]$State.release_class -or
        [string]$Release.server_component_sha -ne [string]$Status.active_game_sha -or
        [string]$Release.client_component_sha -ne $Target -or
        [string]$Release.server_artifact_sha256 -ne
            [string](Get-StateValue $State 'prepared_server_artifact_sha256' '')) {
        Stop-Workflow 'public composite component identity differs from the prepared descriptor'
    }
    $expectedGeneration = "test/$([string]$State.new_generation)"
    if ([string]$Release.game_generation -ne $expectedGeneration) {
        Stop-Workflow "public release generation does not equal $expectedGeneration"
    }
    if ($Session.authenticated -ne $false) {
        Stop-Workflow 'anonymous public game reachability is unsafe'
    }
    if ($World.ok -ne $true -or $World.covered -ne $true -or
        [double]$World.profile.latitude -ne 35.0844 -or
        [double]$World.profile.longitude -ne -106.6504 -or
        [string]$World.release.release_id -ne 'world-packages-v1') {
        Stop-Workflow 'final public World verification failed'
    }
}

function Start-PublicVerification {
    Add-Type -AssemblyName System.Net.Http
    $playUri = [Uri]'https://playashatlas.com/play/'
    $releaseUri = [Uri]::new($playUri, 'release.json')
    $manifestUri = [Uri]::new($playUri, 'site.webmanifest')
    $sessionUri = [Uri]'https://playashatlas.com/api/auth/session'
    $worldUri = [Uri]'https://playashatlas.com/api/lookup?lat=35.0844&lon=-106.6504'
    $waterVisualUri = [Uri]'https://playashatlas.com/world-data/water-visual-tiles-v1/water-visual-7e4a0ddc7821bfb554d34896bb83d2e35a3304a3e7d75ace73c57f73adfa974a.pmtiles'
    $client = [Net.Http.HttpClient]::new()
    $client.Timeout = [TimeSpan]::FromSeconds(4)
    try {
        $waterVisualRequest = [Net.Http.HttpRequestMessage]::new(
            [Net.Http.HttpMethod]::Get, $waterVisualUri)
        $waterVisualRequest.Headers.Range = [Net.Http.Headers.RangeHeaderValue]::new(0, 126)
        return [pscustomobject]@{
            Client = $client
            PlayUri = $playUri
            HtmlTask = $client.GetAsync($playUri)
            ReleaseTask = $client.GetAsync($releaseUri)
            ManifestTask = $client.GetAsync($manifestUri)
            SessionTask = $client.GetAsync($sessionUri)
            WorldTask = $client.GetAsync($worldUri)
            WaterVisualRequest = $waterVisualRequest
            WaterVisualTask = $client.SendAsync($waterVisualRequest)
            HtmlResponse = $null
            ReleaseResponse = $null
            ManifestResponse = $null
            SessionResponse = $null
            WorldResponse = $null
            JsResponse = $null
            CssResponse = $null
            WaterVisualResponse = $null
        }
    } catch {
        $client.Dispose()
        throw
    }
}

function Complete-PublicVerification {
    param(
        [Parameter(Mandatory = $true)]$Probe,
        [Parameter(Mandatory = $true)][string]$Sha,
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)]$Status
    )
    $Probe.HtmlResponse = $Probe.HtmlTask.GetAwaiter().GetResult()
    $Probe.ReleaseResponse = $Probe.ReleaseTask.GetAwaiter().GetResult()
    $Probe.ManifestResponse = $Probe.ManifestTask.GetAwaiter().GetResult()
    $Probe.SessionResponse = $Probe.SessionTask.GetAwaiter().GetResult()
    $Probe.WorldResponse = $Probe.WorldTask.GetAwaiter().GetResult()
    $Probe.WaterVisualResponse = $Probe.WaterVisualTask.GetAwaiter().GetResult()
    if ([int]$Probe.HtmlResponse.StatusCode -ne 200) {
        Stop-Workflow "public /play/ returned HTTP $([int]$Probe.HtmlResponse.StatusCode)"
    }
    if ([int]$Probe.ReleaseResponse.StatusCode -ne 200) {
        Stop-Workflow "public release.json returned HTTP $([int]$Probe.ReleaseResponse.StatusCode)"
    }
    if ([int]$Probe.ManifestResponse.StatusCode -ne 200) {
        Stop-Workflow "public site.webmanifest returned HTTP $([int]$Probe.ManifestResponse.StatusCode)"
    }
    if ([int]$Probe.SessionResponse.StatusCode -ne 200) {
        Stop-Workflow "public game reachability returned HTTP $([int]$Probe.SessionResponse.StatusCode)"
    }
    if ([int]$Probe.WorldResponse.StatusCode -ne 200) {
        Stop-Workflow "public World lookup returned HTTP $([int]$Probe.WorldResponse.StatusCode)"
    }
    if ([int]$Probe.WaterVisualResponse.StatusCode -ne 206) {
        Stop-Workflow "public water visual range returned HTTP $([int]$Probe.WaterVisualResponse.StatusCode)"
    }
    $html = $Probe.HtmlResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    $releaseText = $Probe.ReleaseResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    $sessionText = $Probe.SessionResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    $worldText = $Probe.WorldResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    if ($html -notmatch '/play/assets/') { Stop-Workflow 'public /play/ does not reference /play/assets/' }
    $js = [regex]::Match($html, '/play/assets/[^"''\s<>]+[.]js(?:[?#][^"''\s<>]*)?')
    $css = [regex]::Match($html, '/play/assets/[^"''\s<>]+[.]css(?:[?#][^"''\s<>]*)?')
    if (-not $js.Success) { Stop-Workflow 'public HTML references no JavaScript asset' }
    if (-not $css.Success) { Stop-Workflow 'public HTML references no CSS asset' }
    $jsTask = $Probe.Client.GetAsync([Uri]::new($Probe.PlayUri, $js.Value))
    $cssTask = $Probe.Client.GetAsync([Uri]::new($Probe.PlayUri, $css.Value))
    $Probe.JsResponse = $jsTask.GetAwaiter().GetResult()
    $Probe.CssResponse = $cssTask.GetAwaiter().GetResult()
    if ([int]$Probe.JsResponse.StatusCode -ne 200 -or [int]$Probe.CssResponse.StatusCode -ne 200) {
        Stop-Workflow 'a referenced public JavaScript or CSS asset did not return HTTP 200'
    }
    $htmlCache = [string]::Join(', ', $Probe.HtmlResponse.Headers.GetValues('Cache-Control'))
    $releaseCache = [string]::Join(', ', $Probe.ReleaseResponse.Headers.GetValues('Cache-Control'))
    $manifestCache = [string]::Join(', ', $Probe.ManifestResponse.Headers.GetValues('Cache-Control'))
    $jsCache = [string]::Join(', ', $Probe.JsResponse.Headers.GetValues('Cache-Control'))
    $cssCache = [string]::Join(', ', $Probe.CssResponse.Headers.GetValues('Cache-Control'))
    $waterVisualCache = [string]::Join(', ', $Probe.WaterVisualResponse.Headers.GetValues('Cache-Control'))
    if ($htmlCache -notmatch '(^|,\s*)no-store($|,)') {
        Stop-Workflow 'public app shell is not protected by Cache-Control: no-store'
    }
    if ($releaseCache -notmatch 'no-store' -or $releaseCache -notmatch 'max-age=0') {
        Stop-Workflow 'public release identity is not protected by no-store and max-age=0'
    }
    if ($manifestCache -notmatch 'no-cache' -or $manifestCache -notmatch 'must-revalidate') {
        Stop-Workflow 'public web manifest does not require revalidation'
    }
    if ($jsCache -notmatch 'max-age=31536000' -or $jsCache -notmatch 'immutable' -or
        $cssCache -notmatch 'max-age=31536000' -or $cssCache -notmatch 'immutable') {
        Stop-Workflow 'public content-addressed assets are not immutable for one year'
    }
    $waterVisualBytes = $Probe.WaterVisualResponse.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
    $waterVisualRange = [string]$Probe.WaterVisualResponse.Content.Headers.ContentRange
    if ($waterVisualBytes.Length -ne 127 -or
        $waterVisualRange -ne 'bytes 0-126/1639576487' -or
        $waterVisualCache -notmatch 'max-age=31536000' -or
        $waterVisualCache -notmatch 'immutable') {
        Stop-Workflow 'public water visual range, length, or immutable cache identity differs'
    }
    $release = $releaseText | ConvertFrom-Json
    $session = $sessionText | ConvertFrom-Json
    $world = $worldText | ConvertFrom-Json
    Assert-FinalDeploymentEvidence $Status $State $Sha $release $session $world
}

function Close-PublicVerification {
    param([Parameter(Mandatory = $true)]$Probe)
    foreach ($response in @(
        $Probe.HtmlResponse, $Probe.ReleaseResponse, $Probe.SessionResponse,
        $Probe.ManifestResponse, $Probe.WorldResponse, $Probe.JsResponse, $Probe.CssResponse,
        $Probe.WaterVisualResponse, $Probe.WaterVisualRequest
    )) {
        if ($null -ne $response) { $response.Dispose() }
    }
    $Probe.Client.Dispose()
}

function Invoke-ClassAwarePublicBrowserSmoke {
    param([Parameter(Mandatory = $true)]$State)
    if (-not [bool]$State.is_batch -and
        [string](Get-StateValue $State 'release_class' '') -ne 'client_only') { return }
    $script = @'
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
  const response = await page.goto("https://playashatlas.com/play/", {
    waitUntil: "networkidle",
    timeout: 30000
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
} finally {
  await browser.close();
}
'@
    $browserRoot = [string](Get-StateValue $State 'staging_worktree' (Get-GameRepositoryRoot))
    if (-not $browserRoot) { $browserRoot = Get-GameRepositoryRoot }
    $browserPackage = Join-Path $browserRoot 'apps\client'
    if (-not (Test-Path -LiteralPath (Join-Path $browserPackage 'node_modules\@playwright\test\package.json'))) {
        & pnpm.cmd --dir $browserRoot --filter '@ash-atlas/client...' install --frozen-lockfile
        if ($LASTEXITCODE -ne 0) { Stop-Workflow 'public browser smoke dependency installation failed' }
    }
    & pnpm.cmd --dir $browserRoot --filter '@ash-atlas/client' exec playwright install chromium --only-shell
    if ($LASTEXITCODE -ne 0) { Stop-Workflow 'public browser smoke Chromium installation failed' }
    $smokePath = Join-Path $browserPackage ('.release-browser-smoke-{0}.mjs' -f [guid]::NewGuid().ToString('n'))
    try {
        [IO.File]::WriteAllText($smokePath, $script, [Text.UTF8Encoding]::new($false))
        & pnpm.cmd --dir $browserRoot --filter '@ash-atlas/client' exec node $smokePath
        if ($LASTEXITCODE -ne 0) {
            Stop-Workflow 'final anonymous production browser smoke reported a page or console error'
        }
    } finally {
        if (Test-Path -LiteralPath $smokePath -PathType Leaf) {
            Remove-Item -LiteralPath $smokePath -Force
        }
    }
}

function Require-FreshResumeVerification {
    param([Parameter(Mandatory = $true)]$State)
    if ($Mode -ne 'Resume') { return }
    if ([bool](Get-StateValue $State 'is_batch' $false)) { return }
    $phase = $State.phases.PSObject.Properties['host_readiness_and_public_world_verification']
    if ($null -ne $phase -and [string]$phase.Value.status -eq 'completed') {
        $phase.Value.status = 'pending'
        $phase.Value.result = ''
        $State.exact_deployed_sha = ''
        Set-StateValue $State 'exact_public_release_sha' ''
        $State.deployment_verification_result = ''
        Write-State $State
    }
}

function Publish-ReleaseCandidateRef {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$Target
    )
    $candidateRef = "refs/heads/integration/release-candidates/$($State.operation_id)"
    $repository = if ([string](Get-StateValue $State 'staging_worktree' '')) {
        [string]$State.staging_worktree
    } else { $IntegrationWorktree }
    Set-RemoteSideEffectIntent $State 'git_candidate_ref' $Target `
        'operation-scoped release-candidate publication requires remote reconciliation'
    $remote = @(Get-GitFields $repository @('ls-remote', '--heads', 'origin', $candidateRef))
    if ($remote.Count -notin @(0, 2) -or
        ($remote.Count -eq 2 -and [string]$remote[1] -ne $candidateRef)) {
        Stop-Workflow 'release candidate ref resolved with an unsafe identity'
    }
    if ($remote.Count -eq 2 -and [string]$remote[0] -ne $Target) {
        Stop-Workflow 'release candidate ref already belongs to a different immutable target'
    }
    if ($remote.Count -eq 0) {
        Invoke-Git $repository @('push', 'origin', "$Target`:$candidateRef")
        $remote = @(Get-GitFields $repository @('ls-remote', '--heads', 'origin', $candidateRef))
    }
    if ($remote.Count -ne 2 -or [string]$remote[0] -ne $Target -or
        [string]$remote[1] -ne $candidateRef) {
        Stop-Workflow 'remote release candidate ref did not become the exact target'
    }
    Complete-RemoteSideEffectIntent $State 'git_candidate_ref' $Target 'completed'
    $State.release_candidate_ref = $candidateRef
    $State.release_protocol = 'prepare_activate_v1'
    Write-State $State
    return $candidateRef
}

function Assert-ExactPreparedReceipt {
    param(
        [Parameter(Mandatory = $true)]$Receipt,
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][string]$Target,
        [Parameter(Mandatory = $true)][string]$UpdaterHash,
        [Parameter(Mandatory = $true)][string]$Generation
    )
    $classificationVersion = [int](Get-StateValue $Receipt 'release_classification_version' 0)
    $releaseClass = [string](Get-StateValue $Receipt 'release_class' '')
    $descriptorVersion = [int](Get-StateValue $Receipt 'prepared_descriptor_version' 0)
    $descriptorHash = [string](Get-StateValue $Receipt 'prepared_descriptor_sha256' '')
    $legacyPrepareHash = [string](Get-StateValue $Receipt 'prepare_receipt_sha256' '')
    $preparedRemoteReceiptHash = [string](Get-StateValue $Receipt 'prepared_remote_receipt_sha256' '')
    $preparedEnvHash = [string](Get-StateValue $Receipt 'prepared_env_sha256' '')
    $preparedNativeJson = [string](Get-StateValue $Receipt 'prepared_native_compatibility_json' '')
    $preparedNativeHash = [string](Get-StateValue $Receipt 'prepared_native_compatibility_sha256' '')
    $preparedNativeHashMatches = $false
    try {
        $preparedNativeJson | ConvertFrom-Json -ErrorAction Stop | Out-Null
        $preparedNativeHashMatches = $preparedNativeHash -match '^[0-9a-f]{64}$' -and
            (Get-TextSha256 $preparedNativeJson) -ceq $preparedNativeHash
    } catch { $preparedNativeHashMatches = $false }
    $serverComponentSha = [string](Get-StateValue $Receipt 'prepared_server_component_sha' '')
    $serverArtifactHash = [string](Get-StateValue $Receipt 'prepared_server_artifact_sha256' '')
    $clientComponentSha = [string](Get-StateValue $Receipt 'prepared_client_component_sha' '')
    $clientArtifactHash = [string](Get-StateValue $Receipt 'prepared_client_artifact_sha256' '')
    $staticArtifactFence = [string](Get-StateValue $Receipt 'prepared_static_artifact_fence_sha256' '')
    $releaseMetadataFence = [string](Get-StateValue $Receipt 'prepared_release_metadata_fence_sha256' '')
    $gameReleaseHash = [string](Get-StateValue $Receipt 'prepared_game_release_sha256' '')
    $preparedGamePid = [long](Get-StateValue $Receipt 'prepared_game_main_pid' 0)
    $preparedGameStart = [long](Get-StateValue $Receipt 'prepared_game_start_timestamp_monotonic' 0)
    $componentIdentityInvalid = $serverComponentSha -notmatch '^[0-9a-f]{40}$' -or
        $serverArtifactHash -notmatch '^[0-9a-f]{64}$' -or
        $clientComponentSha -ne $Target -or $clientArtifactHash -notmatch '^[0-9a-f]{64}$' -or
        ($releaseClass -eq 'client_only' -and (
            $gameReleaseHash -or $serverComponentSha -ne
                [string](Get-StateValue $Receipt 'prepared_previous_game_sha' ''))) -or
        ($releaseClass -ne 'client_only' -and (
            $serverComponentSha -ne $Target -or $gameReleaseHash -notmatch '^[0-9a-f]{64}$'))
    if ([string](Get-StateValue $Receipt 'operation_id' '') -ne [string]$State.operation_id -or
        [string](Get-StateValue $Receipt 'requested_target_sha' '') -ne $Target -or
        [string](Get-StateValue $Receipt 'updater_hash' '') -ne $UpdaterHash -or
        [string](Get-StateValue $Receipt 'requested_generation' '') -ne "test/$Generation" -or
        [string](Get-StateValue $Receipt 'candidate_ref' '') -ne [string]$State.release_candidate_ref -or
        [string](Get-StateValue $Receipt 'result' '') -ne 'prepared' -or
        [string](Get-StateValue $Receipt 'prepare_result' '') -ne 'completed' -or
        [string](Get-StateValue $Receipt 'prepared_generation' '') -ne "test/$Generation" -or
        $classificationVersion -ne 1 -or
        $releaseClass -notin @('client_only', 'server_no_migration', 'database_migration', 'release_tooling') -or
        [string](Get-StateValue $Receipt 'release_classification_evidence_sha256' '') -notmatch '^[0-9a-f]{64}$' -or
        [string](Get-StateValue $Receipt 'release_changed_paths_sha256' '') -notmatch '^[0-9a-f]{64}$' -or
        $descriptorVersion -ne 4 -or $descriptorHash -notmatch '^[0-9a-f]{64}$' -or
        $legacyPrepareHash -ne $descriptorHash -or
        $preparedRemoteReceiptHash -notmatch '^[0-9a-f]{64}$' -or
        $preparedEnvHash -notmatch '^[0-9a-f]{64}$' -or
        -not $preparedNativeHashMatches -or
        $staticArtifactFence -notmatch '^[0-9a-f]{64}$' -or
        $releaseMetadataFence -notmatch '^[0-9a-f]{64}$' -or
        $componentIdentityInvalid -or
        $preparedGamePid -le 0 -or $preparedGameStart -le 0 -or
        [string](Get-StateValue $Receipt 'prepared_live_game_link_sha' '') -ne
            [string](Get-StateValue $Receipt 'prepared_previous_game_sha' '') -or
        [string](Get-StateValue $Receipt 'prepared_live_public_link_sha' '') -ne
            [string](Get-StateValue $Receipt 'prepared_live_public_release_sha' '') -or
        [string](Get-StateValue $Receipt 'prepared_public_release_sha256' '') -notmatch '^[0-9a-f]{64}$' -or
        [string](Get-StateValue $Receipt 'activation_result' '') -ne 'pending' -or
        (Get-StateValue $Receipt 'activation_started' $true) -ne $false) {
        Stop-Workflow 'controller did not return the exact inactive PREPARED receipt'
    }
}

function Invoke-PrepareCandidate {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][string]$Target,
        [Parameter(Mandatory = $true)][string]$Generation
    )
    if ($Generation -notmatch '^t[0-9]{3,4}$') { Stop-Workflow 'PREPARE generation is unsafe' }
    $candidateRef = Publish-ReleaseCandidateRef $State $Target
    $updater = Join-Path $RepositoryRoot 'tools\release\vps\deploy-test-update.sh'
    $updaterHash = Get-FileSha256 $updater
    $cachePolicy = Join-Path $RepositoryRoot 'tools\release\vps\game-cache-policy.caddy'
    $cachePolicyHash = Get-FileSha256 $cachePolicy
    $token = [string](Get-StateValue $State 'deployment_status_token' '')
    if (-not $token) {
        $token = New-DeploymentStatusToken
        $State.deployment_status_token = $token
        Write-State $State
    }
    if ($token -notmatch '^[0-9a-f]{64}$') { Stop-Workflow 'PREPARE status token is unsafe' }
    $State.deployment_submission_target_sha = $Target
    $State.deployment_submission_updater_hash = $updaterHash
    Write-State $State
    $response = Invoke-DeploymentController $State prepare @(
        $Target, $updaterHash, "test/$Generation", [string]$State.release_mode,
        $cachePolicyHash, [string](Get-StateValue $State 'release_patch_notes_hex' 'none')) `
        -StandardInput "$token`n"
    Assert-ConsistentControllerPayload $response
    $status = ConvertFrom-ControllerReceipt $response.payload $State
    Assert-DeploymentStatusPayload $status $State $Target
    if ([string]$status.result -in @('accepted', 'running')) {
        $status = Wait-RemoteDeployment $State $status $Target
    }
    if ([string]$status.result -eq 'failed') { Stop-RemoteDeploymentFailure $State $Target $status }
    if ([string]$status.result -ne 'prepared') {
        Stop-Workflow "PREPARE did not reach a durable prepared state: $($status.result)"
    }
    $exact = Invoke-DeploymentController $State status @()
    Assert-ConsistentControllerPayload $exact
    Assert-ExactPreparedReceipt $exact.payload $State $Target $updaterHash $Generation
    $State.prepared_receipt_sha256 = [string]$exact.payload.prepare_receipt_sha256
    $State.prepared_remote_receipt_sha256 =
        [string]$exact.payload.prepared_remote_receipt_sha256
    $State.prepared_env_sha256 = [string]$exact.payload.prepared_env_sha256
    $State.prepared_native_compatibility_json =
        [string]$exact.payload.prepared_native_compatibility_json
    $State.prepared_native_compatibility_sha256 =
        [string]$exact.payload.prepared_native_compatibility_sha256
    $State.prepared_descriptor_version = [int]$exact.payload.prepared_descriptor_version
    $State.prepared_descriptor_sha256 = [string]$exact.payload.prepared_descriptor_sha256
    $State.release_classification_version = [int]$exact.payload.release_classification_version
    $State.release_class = [string]$exact.payload.release_class
    $State.release_classification_evidence_sha256 =
        [string]$exact.payload.release_classification_evidence_sha256
    $State.release_changed_paths_sha256 = [string]$exact.payload.release_changed_paths_sha256
    $State.prepared_server_component_sha = [string]$exact.payload.prepared_server_component_sha
    $State.prepared_server_artifact_sha256 = [string]$exact.payload.prepared_server_artifact_sha256
    $State.prepared_client_component_sha = [string]$exact.payload.prepared_client_component_sha
    $State.prepared_client_artifact_sha256 = [string]$exact.payload.prepared_client_artifact_sha256
    $State.prepared_static_artifact_fence_sha256 =
        [string]$exact.payload.prepared_static_artifact_fence_sha256
    $State.prepared_release_metadata_fence_sha256 =
        [string]$exact.payload.prepared_release_metadata_fence_sha256
    $State.prepared_game_main_pid = [long]$exact.payload.prepared_game_main_pid
    $State.prepared_game_start_timestamp_monotonic =
        [long]$exact.payload.prepared_game_start_timestamp_monotonic
    $State.prepared_live_game_link_sha = [string]$exact.payload.prepared_live_game_link_sha
    $State.prepared_live_public_link_sha = [string]$exact.payload.prepared_live_public_link_sha
    $State.prepared_live_public_release_sha = [string]$exact.payload.prepared_live_public_release_sha
    Set-RemoteReceipt $State $exact.payload
    return "$candidateRef prepared=$($State.prepared_receipt_sha256)"
}

function Invoke-PreparedActivation {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][string]$Target,
        [Parameter(Mandatory = $true)][string]$UpdaterHash
    )
    $mobileReleasePaused = Test-MobileReleasePaused $State
    if ([string]$State.release_protocol -ne 'prepare_activate_v1' -or
        [string]$State.prepared_receipt_sha256 -notmatch '^[0-9a-f]{64}$' -or
        [string](Get-StateValue $State 'prepared_remote_receipt_sha256' '') -notmatch '^[0-9a-f]{64}$' -or
        [string](Get-StateValue $State 'prepared_env_sha256' '') -notmatch '^[0-9a-f]{64}$' -or
        (-not $mobileReleasePaused -and (
            [string](Get-StateValue $State 'activation_intent_id' '') -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$' -or
            [string](Get-StateValue $State 'activation_registry_commit_sha' '') -notmatch '^[0-9a-f]{40}$')) -or
        [string]$State.new_generation -notmatch '^t[0-9]{3,4}$') {
        Stop-Workflow 'ACTIVATE requires a recorded exact PREPARED candidate identity'
    }
    $token = [string](Get-StateValue $State 'deployment_status_token' '')
    if ($token -notmatch '^[0-9a-f]{64}$') { Stop-Workflow 'ACTIVATE status token is unsafe' }
    Set-RemoteSideEffectIntent $State 'vps_activation' $Target `
        'prepared ACTIVATE requires terminal remote reconciliation after response loss'
    $arguments = @($Target, $UpdaterHash, "test/$($State.new_generation)")
    if (-not $mobileReleasePaused) {
        $arguments += [string](Get-StateValue $State 'activation_intent_id' '')
        $arguments += [string](Get-StateValue $State 'activation_registry_commit_sha' '')
    }
    $response = Invoke-DeploymentController $State activate $arguments -StandardInput "$token`n"
    Assert-ConsistentControllerPayload $response
    $receipt = ConvertFrom-ControllerReceipt $response.payload $State
    Assert-DeploymentStatusPayload $receipt $State $Target
    if ([string]$receipt.result -in @('accepted', 'running')) {
        $receipt = Wait-RemoteDeployment $State $receipt $Target
    }
    if ([string]$receipt.result -eq 'failed') { Stop-RemoteDeploymentFailure $State $Target $receipt }
    if ([string]$receipt.result -ne 'completed') {
        Stop-Workflow "ACTIVATE did not reach a completed receipt: $($receipt.result)"
    }
    Set-RemoteReceipt $State $receipt
    return $receipt
}

function Invoke-PublishGitWorkflow {
    param([Parameter(Mandatory = $true)]$State)
    Assert-DeploymentAuthorization

    Invoke-Phase $State 'master_fast_forward_and_push' {
        Require-ReleaseSideEffectReconciliation $State 'master publication must be reconciled into local checkouts' `
            -Kind 'git_master_publication'
        Assert-CleanWorktree $PermanentCheckout 'master' 'permanent master checkout' -AllowUntracked
        Assert-CleanWorktree $IntegrationWorktree 'integration/test' 'dedicated integration worktree'
        $proof = $script:PublishedGenerationProof
        if ($null -ne $proof -and
            [string]$proof.integration_test_sha -ceq [string]$State.candidate_integration_sha -and
            [string]$proof.new_generation -ceq [string]$State.new_generation -and
            [string]$proof.snapshot_id -match '^[0-9a-f]{64}$') {
            $target = [string]$proof.integration_test_sha
            $generation = [string]$proof.new_generation
        } else {
            $snapshot = Get-GenerationStatus
            if (-not $snapshot.generation) { Stop-Workflow 'publication requires an exact integration generation' }
            $target = [string]$snapshot.integration_test_sha
            $generation = [string]$snapshot.generation
        }
        if ($State.candidate_integration_sha -and $State.candidate_integration_sha -ne $target) {
            Stop-Workflow "publication target $target differs from integrated candidate $($State.candidate_integration_sha)"
        }
        $State.candidate_integration_sha = $target
        $State.new_generation = $generation
        Set-RemoteSideEffectIntent $State 'git_master_publication' $target `
            'master publication requires exact remote and permanent-checkout reconciliation'
        Invoke-Git $PermanentCheckout @('fetch', 'origin', '--prune', '--no-tags',
            'refs/heads/master:refs/remotes/origin/master',
            'refs/heads/integration/test:refs/remotes/origin/integration/test',
            "refs/tags/test/$generation`:refs/tags/test/$generation")
        $remoteMaster = Get-GitCommitId $PermanentCheckout 'origin/master'
        $remoteIntegration = Get-GitCommitId $PermanentCheckout 'origin/integration/test'
        if ($remoteIntegration -ne $target) { Stop-Workflow 'fetched integration target changed' }
        if ((Get-GitCommitId $PermanentCheckout "refs/tags/test/$generation") -ne $target) {
            Stop-Workflow 'fetched generation target changed'
        }
        & git -C $PermanentCheckout merge-base --is-ancestor $remoteMaster $target
        if ($LASTEXITCODE -ne 0) { Stop-Workflow 'origin/master has unique history absent from integration/test' }
        $localMaster = Get-GitCommitId $PermanentCheckout 'HEAD'
        if ($localMaster -ne $target) { Invoke-Git $PermanentCheckout @('merge', '--ff-only', $target) }
        $publishedMaster = $remoteMaster
        if ($publishedMaster -ne $target) {
            Invoke-Git $PermanentCheckout @('push', 'origin', "refs/heads/master:refs/heads/master")
            $publishedMaster = (Get-GitFields $PermanentCheckout @(
                'ls-remote', '--heads', 'origin', 'refs/heads/master'))[0]
        }
        if ($publishedMaster -ne $target) { Stop-Workflow "origin/master did not become exact target $target" }
        $State.remote_publication_succeeded = $true
        $State.master_publication_result = "origin/master@$target"
        Write-State $State
        $State.master_publication_result
    } | Out-Null

    Invoke-Phase $State 'publish_local_checkout_reconciliation' {
        Invoke-LocalPublishedCheckoutReconciliation $State `
            ([string]$State.candidate_integration_sha) -RequireMaster
    } | Out-Null
}

function Assert-BatchAdmissionAuthorization {
    param([Parameter(Mandatory = $true)]$State)
    if (-not [bool](Get-StateValue $State 'batch_admission_authorized' $false)) {
        Stop-Workflow ('batch IntegrateBatchAdmission requires explicit -ConfirmBatchAdmission, ' +
            '-ConfirmIntegration, -ConfirmGenerationCheckpoint, and -ApprovedIntegrationTest')
    }
    $worktrees = @($State.feature_worktrees)
    $branches = @($State.feature_branches)
    $tips = @($State.feature_tip_shas)
    $notes = @($State.player_patch_notes)
    if ($worktrees.Count -lt 2) {
        Stop-Workflow 'IntegrateBatchAdmission requires at least two ordered feature worktrees'
    }
    if ($branches.Count -ne $worktrees.Count -or $tips.Count -ne $worktrees.Count -or
        $notes.Count -ne $worktrees.Count) {
        Stop-Workflow 'IntegrateBatchAdmission requires aligned ordered feature refs, SHAs, worktrees, and patch notes'
    }
    if (@($tips | Where-Object { [string]$_ -notmatch '^[0-9a-fA-F]{40}$' }).Count -gt 0) {
        Stop-Workflow 'IntegrateBatchAdmission expected feature SHAs must be canonical 40-character SHAs'
    }
}

function Get-BatchValidatorKey {
    $encoded = [Environment]::GetEnvironmentVariable('ASH_ATLAS_BATCH_VALIDATOR_HMAC_KEY')
    $keyId = [Environment]::GetEnvironmentVariable('ASH_ATLAS_BATCH_VALIDATOR_HMAC_KEY_ID')
    if (-not $encoded -or -not $keyId) {
        Stop-Workflow ('IntegrateBatchAdmission requires the isolated validator supervisor and its ' +
            'host-only HMAC key configuration')
    }
    try { $key = [Convert]::FromBase64String($encoded) }
    catch { Stop-Workflow 'isolated validator HMAC key is not valid base64' }
    if ($key.Length -lt 32 -or $keyId -notmatch '^[A-Za-z0-9._:-]{1,96}$') {
        Stop-Workflow 'isolated validator HMAC key or key ID is invalid'
    }
    return [pscustomobject][ordered]@{ bytes = $key; id = $keyId }
}

function Write-BatchValidatorJson {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)]$Value)
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

function Test-BatchValidatorHexEqual {
    param([Parameter(Mandatory = $true)][string]$Expected, [Parameter(Mandatory = $true)][string]$Actual)
    if ($Expected -notmatch '^[0-9a-f]{64}$' -or $Actual -notmatch '^[0-9a-f]{64}$') { return $false }
    # Keep this compatible with the Windows PowerShell 5.1 trusted runner;
    # [Convert]::FromHexString is only available in newer .NET runtimes.
    $expectedBytes = [byte[]]::new(32)
    $actualBytes = [byte[]]::new(32)
    for ($index = 0; $index -lt 32; $index++) {
        $expectedBytes[$index] = [Convert]::ToByte($Expected.Substring($index * 2, 2), 16)
        $actualBytes[$index] = [Convert]::ToByte($Actual.Substring($index * 2, 2), 16)
    }
    $difference = 0
    for ($index = 0; $index -lt $expectedBytes.Length; $index++) {
        $difference = $difference -bor ($expectedBytes[$index] -bxor $actualBytes[$index])
    }
    return $difference -eq 0
}

function Get-BatchValidatorReceiptPayload {
    param([Parameter(Mandatory = $true)]$Receipt)
    $payload = [ordered]@{}
    foreach ($property in @($Receipt.PSObject.Properties | Where-Object {
                $_.Name -notin @('receipt_sha256', 'signature')
            })) {
        $payload[$property.Name] = $property.Value
    }
    return $payload
}

function Get-BatchValidatorAdapterPath {
    param([Parameter(Mandatory = $true)]$State)
    $path = [string](Get-StateValue $State 'batch_validator_adapter_path' '')
    if (-not $path) {
        $input = Get-Variable BatchValidatorAdapterPath -ErrorAction SilentlyContinue
        if ($null -ne $input) { $path = [string]$input.Value }
    }
    if (-not $path) {
        Stop-Workflow ('IntegrateBatchAdmission requires a configured isolated uncredentialed validator ' +
            'adapter; status flags cannot authorize native validation under the release controller')
    }
    $path = [IO.Path]::GetFullPath($path)
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Stop-Workflow "isolated validator adapter is not installed: $path"
    }
    $candidateRoot = [string](Get-StateValue $State 'staging_worktree' '')
    $candidatePrefix = if ($candidateRoot) { ([IO.Path]::GetFullPath($candidateRoot).TrimEnd('\') + '\') } else { '' }
    if ($candidateRoot -and (
            (Test-AshAtlasSamePath $path $candidateRoot) -or
            $path.StartsWith($candidatePrefix, [StringComparison]::OrdinalIgnoreCase))) {
        Stop-Workflow 'isolated validator adapter must be outside the candidate checkout'
    }
    $State.batch_validator_adapter_path = $path
    return $path
}

function Assert-BatchValidatorConfigured {
    param([Parameter(Mandatory = $true)]$State)
    $null = Get-BatchValidatorAdapterPath $State
    $null = Get-BatchValidatorKey
    return $true
}

function Invoke-IsolatedBatchValidation {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)]$Plan,
        [Parameter(Mandatory = $true)][string]$ToolchainFingerprint
    )
    $adapter = Get-BatchValidatorAdapterPath $State
    $key = Get-BatchValidatorKey
    $stateRootPath = [IO.Path]::GetFullPath($StateRoot).TrimEnd('\')
    $bundleRoot = Join-Path $stateRootPath "$($State.operation_id).isolated-batch-validation"
    $requestPath = Join-Path $bundleRoot 'request.json'
    $receiptPath = [string](Get-StateValue $State 'batch_validator_receipt_path' '')
    if (-not $receiptPath) { $receiptPath = Join-Path $bundleRoot 'receipt.json' }
    $receiptPath = [IO.Path]::GetFullPath($receiptPath)
    New-Item -ItemType Directory -Path $bundleRoot -Force | Out-Null
    $candidateRoot = [IO.Path]::GetFullPath([string]$State.staging_worktree)
    $baselineSha = [string]$State.original_integration_sha
    $candidateSha = [string]$State.final_candidate_sha
    Assert-CanonicalSha $baselineSha 'isolated validator baseline SHA'
    Assert-CanonicalSha $candidateSha 'isolated validator candidate SHA'
    $baselineBundle = Join-Path $bundleRoot 'baseline.bundle'
    $candidateBundle = Join-Path $bundleRoot 'candidate.bundle'
    $validationRefRoot = "refs/ash-atlas/isolated-validation/$($State.operation_id)"
    $baselineRef = "$validationRefRoot/baseline"
    $candidateRef = "$validationRefRoot/candidate"
    try {
        # A raw SHA is not a valid positive bundle revision on every Git version.  Pin
        # temporary named refs first, then bundle those refs and remove them in all
        # exit paths.  The bundles remain durable; the refs are only build plumbing.
        Invoke-Git $candidateRoot @('update-ref', $baselineRef, $baselineSha)
        Invoke-Git $candidateRoot @('update-ref', $candidateRef, $candidateSha)
        foreach ($bundle in @($baselineBundle, $candidateBundle)) {
            if (Test-Path -LiteralPath $bundle -PathType Leaf) {
                Remove-Item -LiteralPath $bundle -Force
            }
        }
        Invoke-Git $candidateRoot @('bundle', 'create', $baselineBundle, $baselineRef)
        Invoke-Git $candidateRoot @('bundle', 'create', $candidateBundle, $candidateRef)
        Invoke-Git $candidateRoot @('bundle', 'verify', $baselineBundle)
        Invoke-Git $candidateRoot @('bundle', 'verify', $candidateBundle)
    } finally {
        & git -C $candidateRoot update-ref -d $baselineRef 2>$null | Out-Null
        & git -C $candidateRoot update-ref -d $candidateRef 2>$null | Out-Null
    }
    $manifestSha = Get-TextSha256 (ConvertTo-CoordinatedCanonicalJson @($State.batch_manifest))
    $planSha = Get-TextSha256 (ConvertTo-CoordinatedCanonicalJson $Plan)
    $toolingSha = Get-GitCommitId $RepositoryRoot 'HEAD'
    $request = [ordered]@{
        schema_version = 1
        kind = 'ash-atlas-isolated-batch-validation-request'
        operation_id = [string]$State.operation_id
        candidate_sha = $candidateSha
        baseline_sha = $baselineSha
        manifest_sha256 = $manifestSha
        tooling_sha = $toolingSha
        validation_plan_sha256 = $planSha
        validation_toolchain_fingerprint = $ToolchainFingerprint
        validator_contract = 'ash-atlas-isolated-uncredentialed-vm/v1'
        bundles = [ordered]@{
            baseline = [ordered]@{ path = $baselineBundle; sha = $baselineSha; sha256 = Get-FileSha256 $baselineBundle }
            candidate = [ordered]@{ path = $candidateBundle; sha = $candidateSha; sha256 = Get-FileSha256 $candidateBundle }
        }
        plan = $Plan
        issued_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    }
    Write-BatchValidatorJson $requestPath $request
    $adapterArguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $adapter,
        '-RequestPath', $requestPath, '-ReceiptPath', $receiptPath)
    # The supervisor returns a receipt file only. Its stdout/stderr are discarded so
    # a validator cannot accidentally persist the host HMAC key or store credentials.
    & powershell @adapterArguments *> $null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) {
        Stop-Workflow ('isolated validator supervisor did not return its signed receipt; ' +
            'provision the external uncredentialed VM and its host supervisor')
    }
    $rawReceipt = [IO.File]::ReadAllText($receiptPath, [Text.UTF8Encoding]::new($false))
    if ($rawReceipt.Length -gt 0 -and [int]$rawReceipt[0] -eq 0xfeff) {
        Stop-Workflow 'isolated validator receipt contains a UTF-8 BOM'
    }
    try { $receipt = $rawReceipt | ConvertFrom-Json -ErrorAction Stop }
    catch { Stop-Workflow 'isolated validator receipt is not valid UTF-8 JSON' }
    $required = @('schema_version', 'kind', 'operation_id', 'candidate_sha', 'baseline_sha',
        'manifest_sha256', 'tooling_sha', 'validation_plan_sha256', 'validation_toolchain_fingerprint',
        'validator', 'gates', 'issued_at_utc', 'receipt_sha256', 'signature')
    $properties = @($receipt.PSObject.Properties.Name)
    if (@($required | Where-Object { $_ -notin $properties }).Count -gt 0) {
        Stop-Workflow 'isolated validator receipt is missing required identity fields'
    }
    if ([int]$receipt.schema_version -ne 1 -or
        [string]$receipt.kind -cne 'ash-atlas-isolated-batch-validation-receipt' -or
        [string]$receipt.operation_id -cne [string]$State.operation_id -or
        [string]$receipt.candidate_sha -cne $candidateSha -or
        [string]$receipt.baseline_sha -cne $baselineSha -or
        [string]$receipt.manifest_sha256 -cne $manifestSha -or
        [string]$receipt.tooling_sha -cne $toolingSha -or
        [string]$receipt.validation_plan_sha256 -cne $planSha -or
        [string]$receipt.validation_toolchain_fingerprint -cne $ToolchainFingerprint) {
        Stop-Workflow 'isolated validator receipt is not bound to the exact candidate, plan, or tooling'
    }
    $validator = $receipt.validator
    if ([string]$validator.mode -cne 'uncredentialed-vm' -or
        [string]$validator.supervisor -cne 'host' -or
        [string]$validator.id -notmatch '^[A-Za-z0-9._:-]{1,96}$' -or
        [string]$validator.image_digest -notmatch '^sha256:[0-9a-f]{64}$') {
        Stop-Workflow 'isolated validator receipt does not identify a host-supervised uncredentialed VM'
    }
    $expectedGates = @($Plan.gates | ForEach-Object { [string]$_.name })
    $actualGates = @($receipt.gates)
    if ($actualGates.Count -ne $expectedGates.Count -or
        @($actualGates | Where-Object {
            [string]$_.name -notin $expectedGates -or [int]$_.exit_code -ne 0 -or
            [string]$_.candidate_sha -cne $candidateSha -or
            [string]$_.stdout_sha256 -notmatch '^[0-9a-f]{64}$' -or
            [string]$_.stderr_sha256 -notmatch '^[0-9a-f]{64}$' -or
            [string]$_.log_sha256 -notmatch '^[0-9a-f]{64}$'
        }).Count -ne 0 -or
        @($actualGates.name | Select-Object -Unique).Count -ne $actualGates.Count) {
        Stop-Workflow 'isolated validator receipt does not contain one successful hash-bound result per gate'
    }
    $signature = $receipt.signature
    if ([string]$signature.algorithm -cne 'HMAC-SHA256' -or
        [string]$signature.key_id -cne [string]$key.id -or
        [string]$signature.hmac_sha256 -notmatch '^[0-9a-f]{64}$') {
        Stop-Workflow 'isolated validator receipt signature metadata is invalid'
    }
    $payloadJson = ConvertTo-CoordinatedCanonicalJson (Get-BatchValidatorReceiptPayload $receipt)
    $receiptHash = Get-CoordinatedSha256Text $payloadJson
    $expectedHmac = Get-CoordinatedHmacSha256Text $payloadJson $key.bytes
    if (-not (Test-BatchValidatorHexEqual $receiptHash ([string]$receipt.receipt_sha256)) -or
        -not (Test-BatchValidatorHexEqual $expectedHmac ([string]$signature.hmac_sha256))) {
        Stop-Workflow 'isolated validator receipt hash or HMAC is invalid'
    }
    $State.batch_validator_receipt_path = $receiptPath
    $State.batch_validator_receipt_sha256 = $receiptHash
    $State.batch_validator_validator_id = [string]$validator.id
    $State.batch_validator_validator_image_digest = [string]$validator.image_digest
    $State.batch_validator_gate_hashes = @($actualGates | ForEach-Object {
            [pscustomobject][ordered]@{
                name = [string]$_.name
                stdout_sha256 = [string]$_.stdout_sha256
                stderr_sha256 = [string]$_.stderr_sha256
                log_sha256 = [string]$_.log_sha256
            }
        })
    $State.batch_admission_isolation_status = 'external_uncredentialed_validator_verified'
    $State.validation_plan_fingerprint = Get-BatchValidationPlanFingerprint $Plan $ToolchainFingerprint
    $State.validation_toolchain_fingerprint = $ToolchainFingerprint
    $State.final_validation_plan = $Plan
    $State.validations_executed = $actualGates.Count
    Write-State $State
    return $receipt
}

function Test-PreparedActivationCompletionReconciled {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)]$Receipt,
        [Parameter(Mandatory = $true)][string]$Target
    )
    $receiptTarget = [string](Get-StateValue $Receipt 'requested_target_sha' '')
    if (-not $receiptTarget) { $receiptTarget = [string](Get-StateValue $Receipt 'target_sha' '') }
    return [string](Get-StateValue $State 'release_protocol' '') -eq 'prepare_activate_v1' -and
        [string](Get-StateValue $Receipt 'result' '') -eq 'completed' -and
        $receiptTarget -eq $Target -and
        ((Test-MobileReleasePaused $State) -or
            [bool](Get-StateValue $State 'activation_intent_resolved' $false))
}

function Test-CoordinatedReleaseNeedsFreshActivationReadiness {
    param([Parameter(Mandatory = $true)]$State)
    $receipt = Get-StateValue $State 'remote_deployment_receipt' $null
    $receiptResult = if ($null -ne $receipt) {
        [string](Get-StateValue $receipt 'result' '')
    } else { '' }
    if ($receiptResult -eq 'prepared') {
        $activationStartedProperty = $receipt.PSObject.Properties['activation_started']
        $activationCompletedProperty = $receipt.PSObject.Properties['activation_completed']
        $activationStarted = $null -ne $activationStartedProperty -and
            [bool](Get-StateValue $receipt 'activation_started' $false)
        $activationCompleted = $null -ne $activationCompletedProperty -and
            [bool](Get-StateValue $receipt 'activation_completed' $false)
        if (-not $activationStarted -and -not $activationCompleted) {
            return $true
        }
        return $false
    }
    if ($receiptResult -eq 'failed' -and
        (Test-ReceiptNoMutation $receipt) -and
        $null -ne (Get-StateValue $State 'activation_intent' $null) -and
        -not [bool](Get-StateValue $State 'activation_intent_resolved' $false)) {
        # A complete no-mutation failure proves that a retry is safe to attempt,
        # but it does not prove that the app approvals remain ready for activation.
        return $true
    }
    $remoteIntent = Get-StateValue $State 'remote_side_effect_intent' $null
    if ($null -ne $remoteIntent -and
        [string](Get-StateValue $remoteIntent 'kind' '') -eq 'vps_activation') {
        return $false
    }
    if ($null -ne (Get-StateValue $State 'activation_intent' $null)) {
        return $false
    }
    return $receiptResult -notin @('accepted', 'running', 'prepared', 'completed')
}

function Invoke-DeploymentWorkflow {
    param([Parameter(Mandatory = $true)]$State)
    Assert-DeploymentAuthorization
    Require-FreshResumeVerification $State

    Invoke-Phase $State 'deployment' {
        $submissionStarted = Get-Date
        $target = [string]$State.candidate_integration_sha
        $remoteIntent = Get-StateValue $State 'remote_side_effect_intent' $null
        $remoteIntentPending = $null -ne $remoteIntent -and
            [string](Get-StateValue $remoteIntent 'status' '') -eq 'pending' -and
            [string](Get-StateValue $remoteIntent 'kind' '') -eq 'vps_activation'
        $remoteReceiptResult = if ($null -ne $State.remote_deployment_receipt) {
            [string](Get-StateValue $State.remote_deployment_receipt 'result' '')
        } else { '' }
        if ($Mode -eq 'Resume' -or $remoteIntentPending -or
            $remoteReceiptResult -in @('accepted', 'running', 'completed', 'failed')) {
            Reconcile-RemoteTruth $State | Out-Null
            $remoteIntent = Get-StateValue $State 'remote_side_effect_intent' $null
            $remoteIntentPending = $null -ne $remoteIntent -and
                [string](Get-StateValue $remoteIntent 'status' '') -eq 'pending' -and
                [string](Get-StateValue $remoteIntent 'kind' '') -eq 'vps_activation'
            $resumeReceipt = Get-StateValue $State 'remote_deployment_receipt' $null
            if ($null -ne $resumeReceipt -and
                [string](Get-StateValue $resumeReceipt 'result' '') -in @('completed', 'failed') -and
                [string](Get-StateValue $State 'release_protocol' '') -eq 'prepare_activate_v1') {
                $reconcileCandidateRoot = if ([string]$State.staging_worktree) {
                    [string]$State.staging_worktree
                } else { $IntegrationWorktree }
                Assert-DeploymentStatusPayload $resumeReceipt $State $target
                $resumableFailedActivation = [string](Get-StateValue $resumeReceipt 'result' '') -eq 'failed' -and
                    (Test-ReceiptNoMutation $resumeReceipt) -and
                    $null -ne (Get-StateValue $State 'activation_intent' $null) -and
                    -not [bool](Get-StateValue $State 'activation_intent_resolved' $false)
                if (-not $resumableFailedActivation -and -not (Test-MobileReleasePaused $State)) {
                    Resolve-MobileActivationIntent $reconcileCandidateRoot $State $resumeReceipt
                }
                Set-RemoteReceipt $State $resumeReceipt
                if (Test-PreparedActivationCompletionReconciled $State $resumeReceipt $target) {
                    $State.deployment_verification_result =
                        'authoritative completed activation reconciled without reactivation'
                    $State.deployment_operation_id = [string]$State.operation_id
                    $State.deployment_target_sha = $target
                    Write-State $State
                    return $State.deployment_verification_result
                }
                $remoteIntent = Get-StateValue $State 'remote_side_effect_intent' $null
                $remoteIntentPending = $null -ne $remoteIntent -and
                    [string](Get-StateValue $remoteIntent 'status' '') -eq 'pending' -and
                    [string](Get-StateValue $remoteIntent 'kind' '') -eq 'vps_activation'
            }
            if ($null -ne $resumeReceipt -and
                [string](Get-StateValue $resumeReceipt 'result' '') -eq 'prepared' -and
                [string](Get-StateValue $State 'release_protocol' '') -eq 'prepare_activate_v1' -and
                -not [bool](Get-StateValue $State 'activation_intent_resolved' $false)) {
                $reconcileCandidateRoot = if ([string]$State.staging_worktree) {
                    [string]$State.staging_worktree
                } else { $IntegrationWorktree }
                Assert-DeploymentStatusPayload $resumeReceipt $State $target
                Set-RemoteReceipt $State $resumeReceipt
            }
            if ($remoteIntentPending -and
                [bool](Get-StateValue $State 'deployment_automatic_reconciliation_required' $false) -and
                (Test-PreparedActivationProvablyNotStarted $State $resumeReceipt $target)) {
                # The lost ACTIVATE never ran: resolve it as failed so Resume may activate again.
                Complete-RemoteSideEffectIntent $State 'vps_activation' $target 'failed'
                $remoteIntentPending = $false
            }
            if ($remoteIntentPending -and
                [bool](Get-StateValue $State 'deployment_automatic_reconciliation_required' $false)) {
                Stop-Workflow 'remote ACTIVATE is not authoritatively reconciled before compatibility admission'
            }
        }
        $mobileCandidateRoot = if ([string]$State.staging_worktree) {
            [string]$State.staging_worktree
        } else { $IntegrationWorktree }
        $retryExistingActivationIntent = $null -ne (Get-StateValue $State 'remote_deployment_receipt' $null) -and
            [string](Get-StateValue $State.remote_deployment_receipt 'result' '') -eq 'failed' -and
            (Test-ReceiptNoMutation $State.remote_deployment_receipt) -and
            $null -ne (Get-StateValue $State 'activation_intent' $null) -and
            -not [bool](Get-StateValue $State 'activation_intent_resolved' $false)
        $coordinatedManifest = Get-StateValue $State 'coordinated_manifest' $null
        if (-not (Test-MobileReleasePaused $State) -and
            $null -ne $coordinatedManifest -and
            (Test-CoordinatedReleaseNeedsFreshActivationReadiness $State)) {
            # Reconcile an existing accepted/running/completed remote operation first.
            # A proven no-mutation retry is still a new activation attempt and must
            # recheck the exact app approvals before it can reach the server.
            Assert-CoordinatedReleaseActivationReadiness $coordinatedManifest | Out-Null
        }
        if (-not $retryExistingActivationIntent) {
            Invoke-MobileBackwardCompatibilityGate $State $mobileCandidateRoot $target | Out-Null
        }
        if ([string](Get-StateValue $State 'release_protocol' '') -eq 'prepare_activate_v1' -and
            -not (Test-MobileReleasePaused $State)) {
            Set-MobileActivationIntent $mobileCandidateRoot $target $State | Out-Null
        }
        $State.deployment_operation_id = [string]$State.operation_id
        $State.deployment_target_sha = $target
        $updater = Join-Path $RepositoryRoot 'tools\release\vps\deploy-test-update.sh'
        $localHash = Get-FileSha256 $updater
        $receipt = if ([string](Get-StateValue $State 'release_protocol' '') -eq 'prepare_activate_v1') {
            # ACTIVATE must present the updater hash PREPARE ran with. Publication fast-forwards this
            # checkout first, so a release that ships a new updater would otherwise send the new file's
            # hash, which neither the PREPARED receipt nor the still-installed updater can match.
            # PREPARE submits deployment_submission_updater_hash and requires the controller's PREPARED
            # receipt to echo it; remote_deployment_receipt is later replaced by the deployment status
            # receipt, which does not carry updater_hash.
            $preparedHash = [string](Get-StateValue $State 'deployment_submission_updater_hash' '')
            $preparedReceipt = Get-StateValue $State 'remote_deployment_receipt' $null
            $receiptHash = if ($null -ne $preparedReceipt) {
                [string](Get-StateValue $preparedReceipt 'updater_hash' '')
            } else { '' }
            if ($preparedHash -notmatch '^[0-9a-f]{64}$') {
                Stop-Workflow 'state does not record the updater hash used for PREPARE'
            }
            if ($receiptHash -and $receiptHash -ne $preparedHash) {
                Stop-Workflow 'PREPARED receipt updater hash differs from the hash submitted for PREPARE'
            }
            if ($preparedHash -ne $localHash) {
                Write-Warning ('This release changes the VPS updater: activating with the prepared updater; ' +
                    'install the new updater with install-vps-updater.ps1 -ConfirmUpdaterInstall after it completes.')
            }
            Invoke-PreparedActivation $State $target $preparedHash
        } else {
            Invoke-DurableDeployment $State $target $localHash
        }
        $State.deployment_verification_result = 'remote operation reached a completed authoritative status'
        $State.deployment_submission_duration_ms =
            [math]::Round(((Get-Date) - $submissionStarted).TotalMilliseconds)
        Write-State $State
        $State.deployment_verification_result
    } | Out-Null

    Invoke-Phase $State 'host_readiness_and_public_world_verification' {
        $target = [string]$State.candidate_integration_sha
        $receipt = $State.remote_deployment_receipt
        Assert-DeploymentStatusPayload $receipt $State $target
        if ([string]$receipt.result -ne 'completed') {
            Stop-Workflow 'final verification requires a completed authoritative deployment status'
        }
        $publicProbe = Start-PublicVerification
        try {
            Complete-PublicVerification $publicProbe $target $State $receipt
        } finally {
            Close-PublicVerification $publicProbe
        }
        Invoke-ClassAwarePublicBrowserSmoke $State
        if ([string](Get-StateValue $State 'release_protocol' '') -eq 'prepare_activate_v1' -and
            -not (Test-MobileReleasePaused $State)) {
            $activationCandidateRoot = if ([string]$State.staging_worktree) {
                [string]$State.staging_worktree
            } else { $IntegrationWorktree }
            Resolve-MobileActivationIntent $activationCandidateRoot $State $receipt
        }
        Set-RemoteReceipt $State $receipt
        $State.exact_deployed_sha = [string]$receipt.active_game_sha
        $State.exact_public_release_sha = [string]$receipt.active_public_sha
        $State.deployment_verification_result =
            'host, World, HTML, assets, release identity, and anonymous browser error checks passed'
        Write-State $State
        $State.deployment_verification_result
    } | Out-Null
}

function Get-CoordinatedManifestSourcePath {
    param([Parameter(Mandatory = $true)]$State)
    $path = [string](Get-StateValue $State 'coordinated_manifest_path' '')
    if (-not $path) {
        $path = Get-CoordinatedReleaseManifestPath $StateRoot ([string]$State.operation_id)
    }
    return [IO.Path]::GetFullPath($path)
}

function Write-CoordinatedReleaseState {
    param([Parameter(Mandatory = $true)]$State)
    $manifest = Get-StateValue $State 'coordinated_manifest' $null
    if ($null -eq $manifest) { Stop-Workflow 'coordinated release state has no durable manifest' }
    Assert-CoordinatedReleaseManifest $manifest | Out-Null
    $State.coordinated_manifest = $manifest
    $State.coordinated_phase = [string]$manifest.current_phase
    $State.coordinated_journal = @($State.coordinated_journal)
    $State.coordinated_journal_path = Get-CoordinatedReleaseJournalPath $StateRoot ([string]$State.operation_id)
    Write-CoordinatedReleaseManifest $manifest $StateRoot | Out-Null
    Write-CoordinatedReleaseJournal $StateRoot ([string]$State.operation_id) $State.coordinated_journal | Out-Null
    Write-State $State
}

function Initialize-CoordinatedReleaseState {
    param([Parameter(Mandatory = $true)]$State)
    $manifest = Get-StateValue $State 'coordinated_manifest' $null
    $manifestPath = [string](Get-StateValue $State 'coordinated_manifest_path' '')
    if (-not $manifestPath -and $CoordinatedManifestPath) { $manifestPath = [string]$CoordinatedManifestPath }
    $seedPath = [string](Get-StateValue $State 'coordinated_seed_path' '')
    if (-not $seedPath -and $CoordinatedSeedPath) { $seedPath = [string]$CoordinatedSeedPath }
    if ($null -eq $manifest) {
        if ($manifestPath -and (Test-Path -LiteralPath ([IO.Path]::GetFullPath($manifestPath)) -PathType Leaf)) {
            $manifest = Read-CoordinatedReleaseManifest ([IO.Path]::GetFullPath($manifestPath))
        } elseif ($seedPath -and (Test-Path -LiteralPath ([IO.Path]::GetFullPath($seedPath)) -PathType Leaf)) {
            $seed = Read-CoordinatedReleaseJson ([IO.Path]::GetFullPath($seedPath))
            $manifest = New-CoordinatedReleaseManifestFromSeed $seed
            $manifestPath = Get-CoordinatedReleaseManifestPath $StateRoot ([string]$State.operation_id)
        } else {
            if (-not $manifestPath) { $manifestPath = Get-CoordinatedReleaseManifestPath $StateRoot ([string]$State.operation_id) }
            Stop-Workflow ('ACTION_REQUIRED: coordinated release needs the trusted mobile bootstrap seed or durable manifest at ' +
                [IO.Path]::GetFullPath($manifestPath))
        }
    }
    if ([string]$manifest.operation_id -cne [string]$State.operation_id) {
        Stop-Workflow 'coordinated manifest operation ID does not match release operation state'
    }
    if ($CoordinatedGeneration -and [string]$manifest.pinned.generation -cne $CoordinatedGeneration) {
        Stop-Workflow 'coordinated generation input differs from the immutable manifest'
    }
    if ($CoordinatedServerSha -and [string]$manifest.pinned.server_sha -cne $CoordinatedServerSha.ToLowerInvariant()) {
        Stop-Workflow 'coordinated server SHA input differs from the immutable manifest'
    }
    if ($CoordinatedAcceptedMasterSha -and [string]$manifest.pinned.accepted_master_sha -cne $CoordinatedAcceptedMasterSha.ToLowerInvariant()) {
        Stop-Workflow 'coordinated accepted master SHA input differs from the immutable manifest'
    }
    $State.coordinated_manifest = $manifest
    $State.coordinated_manifest_path = Get-CoordinatedReleaseManifestPath $StateRoot ([string]$State.operation_id)
    $State.coordinated_seed_path = if ($seedPath) { [IO.Path]::GetFullPath($seedPath) } else { '' }
    if ($CoordinatedMobileReceiptPath) {
        $State.coordinated_mobile_receipt_path = [IO.Path]::GetFullPath($CoordinatedMobileReceiptPath)
    }
    $coordinatedEvidenceInput = if ($null -ne (Get-Variable CoordinatedServerEvidencePath -ErrorAction SilentlyContinue)) {
        [string]$CoordinatedServerEvidencePath
    } else { '' }
    if ($coordinatedEvidenceInput) {
        $State.coordinated_server_evidence_path = [IO.Path]::GetFullPath($coordinatedEvidenceInput)
    } elseif (-not [string](Get-StateValue $State 'coordinated_server_evidence_path' '')) {
        $State.coordinated_server_evidence_path = Join-Path $StateRoot "$($State.operation_id).coordinated-server-evidence.json"
    }
    $evidencePath = [string](Get-StateValue $State 'coordinated_server_evidence_path' '')
    if ($evidencePath -and (Test-Path -LiteralPath $evidencePath -PathType Leaf)) {
        $State.coordinated_server_evidence = Read-CoordinatedReleaseJson $evidencePath
        $State.coordinated_server_evidence_sha256 = Get-CoordinatedSha256Text `
            (ConvertTo-CoordinatedCanonicalJson $State.coordinated_server_evidence)
        $State.coordinated_server_evidence_nonce = [string](Get-CoordinatedProperty `
            $State.coordinated_server_evidence 'nonce' '')
    }
    $journalPath = Get-CoordinatedReleaseJournalPath $StateRoot ([string]$State.operation_id)
    $journal = @(Read-CoordinatedReleaseJournal $StateRoot ([string]$State.operation_id))
    if ($journal.Count -eq 0) {
        $journal = @(Add-CoordinatedReleaseJournalEntry $manifest 'manifest_created' `
            'pinned generation and exact mobile candidate identities recorded' @())
    }
    $State.coordinated_journal_path = $journalPath
    $State.coordinated_journal = @($journal)
    $State.coordinated_phase = [string]$manifest.current_phase
    $State.coordinated_pinned_generation = [string]$manifest.pinned.generation
    $State.coordinated_pinned_server_sha = [string]$manifest.pinned.server_sha
    $State.coordinated_accepted_master_sha = [string]$manifest.pinned.accepted_master_sha
    Write-CoordinatedReleaseState $State
    return $State
}

function Import-CoordinatedMobileReceipt {
    param([Parameter(Mandatory = $true)]$State)
    $path = [string](Get-StateValue $State 'coordinated_mobile_receipt_path' '')
    if (-not $path -or -not (Test-Path -LiteralPath $path -PathType Leaf)) { return $false }
    $receipt = Read-CoordinatedReleaseJson ([IO.Path]::GetFullPath($path))
    if ($null -eq $receipt) { Stop-Workflow 'coordinated mobile receipt is empty' }
    $coordinatedOperationId = [string](Get-CoordinatedProperty $receipt 'coordinated_operation_id' '')
    if ($coordinatedOperationId -and $coordinatedOperationId -cne [string]$State.coordinated_manifest.operation_id) {
        Stop-Workflow 'coordinated mobile receipt operation ID does not match the durable manifest'
    }
    $evidence = @()
    $receiptEntries = @(Get-CoordinatedProperty $receipt 'receipts' @())
    if ($receiptEntries.Count -gt 0) {
        foreach ($entry in $receiptEntries) {
            $platform = [string](Get-CoordinatedProperty $entry 'platform' '')
            if ($platform -in @(Get-CoordinatedReleaseAppPlatforms)) {
                $evidence += [pscustomobject][ordered]@{ platform = $platform; value = $entry }
            }
        }
    } else {
        foreach ($platform in @(Get-CoordinatedReleaseAppPlatforms)) {
            $entry = Get-CoordinatedProperty $receipt $platform $null
            if ($null -eq $entry) {
                $platforms = Get-CoordinatedProperty $receipt 'platforms' $null
                if ($null -ne $platforms) { $entry = Get-CoordinatedProperty $platforms $platform $null }
            }
            if ($null -ne $entry) {
                $evidence += [pscustomobject][ordered]@{ platform = $platform; value = $entry }
            }
        }
    }
    if ($evidence.Count -eq 0 -and $receipt -is [Array]) {
        foreach ($entry in @($receipt)) {
            $platform = [string](Get-CoordinatedProperty $entry 'platform' '')
            if ($platform -in @(Get-CoordinatedReleaseAppPlatforms)) {
                $evidence += [pscustomobject][ordered]@{ platform = $platform; value = $entry }
            }
        }
    }
    if ($evidence.Count -eq 0) { Stop-Workflow 'coordinated mobile receipt contains no ios or android evidence' }
    foreach ($item in $evidence) {
        $platform = [string]$item.platform
        $entry = $item.value
        $kind = [string](Get-CoordinatedProperty $entry 'kind' '')
        if ($kind -and $kind -cne 'ash-atlas-mobile-child-receipt') {
            Stop-Workflow "$platform coordinated receipt kind is unsupported"
        }
        $entryOperationId = [string](Get-CoordinatedProperty $entry 'coordinated_operation_id' '')
        if ($entryOperationId -and $entryOperationId -cne [string]$State.coordinated_manifest.operation_id) {
            Stop-Workflow "$platform coordinated receipt operation ID does not match the durable manifest"
        }
        $receiptBody = Get-CoordinatedProperty $entry 'receipt' $null
        if ($null -ne $receiptBody) {
            $candidate = Get-CoordinatedProperty $entry 'candidate' $null
            if ($null -ne $candidate -and $null -eq (Get-CoordinatedProperty $receiptBody 'candidate' $null)) {
                $receiptBody | Add-Member -NotePropertyName candidate -NotePropertyValue $candidate
            }
            $operation = Get-CoordinatedProperty $entry 'operation_id' $null
            if ($operation -and -not (Get-CoordinatedProperty $receiptBody 'operation_id' $null)) {
                $receiptBody | Add-Member -NotePropertyName operation_id -NotePropertyValue $operation
            }
            $entry = $receiptBody
        }
        $manifest = Set-CoordinatedReleaseAppEvidence $State.coordinated_manifest $platform $entry
        $State.coordinated_manifest = $manifest
        $State.coordinated_journal = @(Add-CoordinatedReleaseJournalEntry $manifest `
            'mobile_evidence_observed' `
            "child operation $($State.coordinated_manifest.apps.$platform.child_operation_id)" $State.coordinated_journal)
    }
    Write-CoordinatedReleaseState $State
    return $true
}

function Export-CoordinatedServerEvidence {
    param([Parameter(Mandatory = $true)]$State)
    $manifest = $State.coordinated_manifest
    Assert-CoordinatedReleaseManifest $manifest | Out-Null
    if (-not [bool](Get-CoordinatedProperty $manifest.server 'healthy' $false)) {
        Stop-Workflow 'coordinated server evidence cannot be exported before server health'
    }
    $existing = Get-StateValue $State 'coordinated_server_evidence' $null
    $previousFingerprint = [string](Get-StateValue $State 'coordinated_server_evidence_sha256' '')
    if ($null -eq $existing -and $previousFingerprint) {
        Stop-Workflow 'coordinated server evidence sidecar is missing after its initial export'
    }
    if ($null -ne $existing) {
        Assert-CoordinatedServerEvidencePayload $existing $manifest | Out-Null
        $evidence = $existing
    } else {
        $evidence = New-CoordinatedServerEvidencePayload $State
        Assert-CoordinatedServerEvidencePayload $evidence $manifest | Out-Null
        $State.coordinated_server_evidence = $evidence
    }
    $path = [string](Get-StateValue $State 'coordinated_server_evidence_path' '')
    if (-not $path) {
        $coordinatedEvidenceInput = if ($null -ne (Get-Variable CoordinatedServerEvidencePath -ErrorAction SilentlyContinue)) {
            [string]$CoordinatedServerEvidencePath
        } else { '' }
        if ($coordinatedEvidenceInput) { $path = $coordinatedEvidenceInput }
    }
    if (-not $path) {
        $path = Join-Path $StateRoot "$($State.operation_id).coordinated-server-evidence.json"
    }
    $path = [IO.Path]::GetFullPath($path)
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        $onDisk = Read-CoordinatedReleaseJson $path
        Assert-CoordinatedServerEvidencePayload $onDisk $manifest | Out-Null
        if ((ConvertTo-CoordinatedCanonicalJson $onDisk) -cne
            (ConvertTo-CoordinatedCanonicalJson $evidence)) {
            Stop-Workflow 'coordinated server evidence changed after its initial export'
        }
    } else {
        Write-CoordinatedReleaseJson $path $evidence | Out-Null
    }
    $fingerprint = Get-CoordinatedSha256Text (ConvertTo-CoordinatedCanonicalJson $evidence)
    $State.coordinated_server_evidence_path = $path
    $State.coordinated_server_evidence_nonce = [string](Get-CoordinatedProperty $evidence 'nonce' '')
    $State.coordinated_server_evidence_sha256 = $fingerprint
    if ($previousFingerprint -ne $fingerprint) {
        $State.coordinated_journal = @(Add-CoordinatedReleaseJournalEntry $manifest `
            'server_health_evidence_exported' `
            "controller evidence $fingerprint nonce $($State.coordinated_server_evidence_nonce)" `
            $State.coordinated_journal)
    }
    Write-CoordinatedReleaseState $State
    return $evidence
}

function Assert-CoordinatedPinnedServerIdentity {
    param([Parameter(Mandatory = $true)]$State)
    $manifest = $State.coordinated_manifest
    Assert-CoordinatedReleaseManifest $manifest | Out-Null
    $generation = [string]$manifest.pinned.generation
    $target = [string]$manifest.pinned.server_sha
    $snapshot = Get-GenerationStatus
    Invoke-Git $PermanentCheckout @(
        'fetch', 'origin', '--prune', '--no-tags',
        'refs/heads/master:refs/remotes/origin/master',
        'refs/heads/integration/test:refs/remotes/origin/integration/test',
        "refs/tags/test/${generation}:refs/tags/test/$generation"
    )
    $tag = @($snapshot.generation_refs | Where-Object { [string]$_.name -eq "test/$generation" })
    if ($tag.Count -ne 1 -or [string]$tag[0].commit_sha -cne $target) {
        Stop-Workflow 'coordinated pinned generation tag does not resolve to the immutable server SHA'
    }
    $integrationSha = [string]$snapshot.integration_test_sha
    if ($integrationSha -notmatch '^[0-9a-f]{40}$') { Stop-Workflow 'coordinated integration/test identity is not canonical' }
    & git -C $PermanentCheckout merge-base --is-ancestor $target $integrationSha 2>$null
    if ($LASTEXITCODE -ne 0) { Stop-Workflow 'coordinated pinned generation is no longer an ancestor of integration/test' }
    $masterSha = [string]$snapshot.master_sha
    if ($masterSha -notmatch '^[0-9a-f]{40}$') { Stop-Workflow 'coordinated origin/master identity is not canonical' }
    & git -C $PermanentCheckout merge-base --is-ancestor $masterSha $target 2>$null
    if ($LASTEXITCODE -ne 0 -and $masterSha -cne $target) {
        Stop-Workflow 'coordinated origin/master has unique history absent from the pinned generation'
    }
    return $snapshot
}

function Get-CoordinatedPinnedWorktreePath {
    param([Parameter(Mandatory = $true)]$State)
    $manifest = $State.coordinated_manifest
    $operation = [string]$manifest.operation_id
    $generation = [string]$manifest.pinned.generation
    if ($operation -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$' -or
        $generation -notmatch '^t[0-9]{3,4}$') {
        Stop-Workflow 'coordinated pinned worktree identity is unsafe'
    }
    $slug = "coordinated-release-$((Get-TextSha256 $operation).Substring(0, 12))"
    $worktreeRoot = [IO.Path]::GetFullPath((Split-Path -Parent $IntegrationWorktree)).TrimEnd('\')
    return [IO.Path]::GetFullPath((Join-Path $worktreeRoot "$slug`__$generation")).TrimEnd('\')
}

function Initialize-CoordinatedPinnedWorktree {
    param([Parameter(Mandatory = $true)]$State)
    $manifest = $State.coordinated_manifest
    $target = [string]$manifest.pinned.server_sha
    Assert-CanonicalSha $target 'coordinated pinned server SHA'
    $expectedPath = Get-CoordinatedPinnedWorktreePath $State
    $recordedPath = [string](Get-StateValue $State 'staging_worktree' '')
    if ($recordedPath) {
        $recordedPath = [IO.Path]::GetFullPath($recordedPath).TrimEnd('\')
        if (-not (Test-AshAtlasSamePath $recordedPath $expectedPath)) {
            Stop-Workflow 'coordinated pinned worktree path changed after manifest creation'
        }
    } else {
        $State.staging_worktree = $expectedPath
        $State.staging_branch = ''
        $State.coordinated_pinned_worktree_sha = $target
        Write-State $State
    }
    if (-not (Test-Path -LiteralPath $expectedPath -PathType Container)) {
        New-Item -ItemType Directory -Path (Split-Path -Parent $expectedPath) -Force | Out-Null
        Invoke-Git $PermanentCheckout @('worktree', 'add', '--detach', $expectedPath, $target) | Out-Null
    }
    $gitRoot = Get-GitText $expectedPath @('rev-parse', '--show-toplevel')
    if (-not (Test-AshAtlasSamePath $gitRoot $expectedPath)) {
        Stop-Workflow 'coordinated pinned worktree resolves to a different checkout path'
    }
    $head = Get-GitCommitId $expectedPath 'HEAD'
    if ($head -cne $target) {
        Stop-Workflow 'coordinated pinned worktree does not resolve to the immutable server SHA'
    }
    if ((Get-GitText $expectedPath @('branch', '--show-current')) -ne '') {
        Stop-Workflow 'coordinated pinned worktree must remain detached'
    }
    if ((Get-GitText $expectedPath @('status', '--porcelain')) -ne '') {
        Stop-Workflow 'coordinated pinned worktree is unexpectedly dirty'
    }
    $State.coordinated_pinned_worktree_sha = $target
    $State.staging_worktree = $expectedPath
    $State.staging_branch = ''
    Write-State $State
    return $expectedPath
}

function Invoke-CoordinatedMasterPublication {
    param([Parameter(Mandatory = $true)]$State)
    Assert-MasterPublicationAuthorization
    $target = [string]$State.coordinated_manifest.pinned.server_sha
    $generation = [string]$State.coordinated_manifest.pinned.generation
    $snapshot = Assert-CoordinatedPinnedServerIdentity $State
    Assert-CleanWorktree $PermanentCheckout 'master' 'permanent master checkout' -AllowUntracked
    $remoteMaster = Get-GitCommitId $PermanentCheckout 'origin/master'
    if ($remoteMaster -ne $target) {
        & git -C $PermanentCheckout merge-base --is-ancestor $remoteMaster $target 2>$null
        if ($LASTEXITCODE -ne 0) { Stop-Workflow 'coordinated master publication would discard a unique protected commit' }
        Invoke-Git $PermanentCheckout @('merge', '--ff-only', $target)
        Invoke-Git $PermanentCheckout @('push', 'origin', 'HEAD:refs/heads/master')
    }
    $published = Get-GitCommitId $PermanentCheckout 'origin/master'
    $publishedRemote = @(
        Get-GitFields $PermanentCheckout @('ls-remote', '--heads', 'origin', 'refs/heads/master')
    )
    if ($publishedRemote.Count -ne 2 -or [string]$publishedRemote[0] -cne $target) {
        Stop-Workflow 'coordinated origin/master did not become the pinned server SHA'
    }
    if ($published -cne $target) { Stop-Workflow 'coordinated local origin/master did not become the pinned server SHA' }
    $State.coordinated_manifest.server.published = $true
    $State.coordinated_manifest.server.candidate_sha = $target
    $State.master_publication_result = "origin/master@$target"
    $State.coordinated_journal = @(Add-CoordinatedReleaseJournalEntry $State.coordinated_manifest `
        'server_published' "origin/master@$target test/$generation" $State.coordinated_journal)
    Advance-CoordinatedReleasePhase $State.coordinated_manifest 'server_published' | Out-Null
    Write-CoordinatedReleaseState $State
    return $target
}

function Complete-CoordinatedReleaseStatus {
    param([Parameter(Mandatory = $true)]$State)
    $gate = Get-CoordinatedReleaseGate $State.coordinated_manifest
    $State.coordinated_phase = [string]$State.coordinated_manifest.current_phase
    $State.coordinated_wait_reason = [string]$gate.reason
    if ([string]$State.coordinated_manifest.current_phase -eq 'completed') {
        $State.coordinated_status = 'completed'
        $State.status = 'completed'
        $State.coordinated_wait_reason = ''
    } else {
        $State.coordinated_status = 'waiting'
        $State.status = 'waiting_for_coordinated_gate'
    }
    $State.coordinated_manifest.completion.waiting_reason = [string]$State.coordinated_wait_reason
    Write-CoordinatedReleaseState $State
    return $gate
}

function Sync-CoordinatedReleaseServerPhases {
    param([Parameter(Mandatory = $true)]$State)
    $manifest = $State.coordinated_manifest
    $changed = $false
    if ([bool](Get-CoordinatedProperty $manifest.server 'published' $false) -and
        [string]$manifest.current_phase -eq 'apps_ready') {
        Advance-CoordinatedReleasePhase $manifest 'server_published' | Out-Null
        $State.coordinated_journal = @(Add-CoordinatedReleaseJournalEntry $manifest `
            'server_published_reconciled' 'durable server publication evidence reconciled after an interrupted write' $State.coordinated_journal)
        $changed = $true
    }
    if ([bool](Get-CoordinatedProperty $manifest.server 'activated' $false) -and
        [string]$manifest.current_phase -eq 'server_published') {
        Advance-CoordinatedReleasePhase $manifest 'server_activated' | Out-Null
        $State.coordinated_journal = @(Add-CoordinatedReleaseJournalEntry $manifest `
            'server_activated_reconciled' 'durable server activation evidence reconciled after an interrupted write' $State.coordinated_journal)
        $changed = $true
    }
    if ([bool](Get-CoordinatedProperty $manifest.server 'healthy' $false) -and
        [string]$manifest.current_phase -eq 'server_activated') {
        Advance-CoordinatedReleasePhase $manifest 'server_healthy' | Out-Null
        $State.coordinated_journal = @(Add-CoordinatedReleaseJournalEntry $manifest `
            'server_healthy_reconciled' 'durable server health evidence reconciled after an interrupted write' $State.coordinated_journal)
        $changed = $true
    }
    $releaseRequested = @(@('ios', 'android') | Where-Object {
            [bool](Get-CoordinatedProperty (Get-CoordinatedProperty $manifest.apps $_ $null) 'release_requested' $false)
        }).Count -eq 2
    if ($releaseRequested -and [string]$manifest.current_phase -eq 'server_healthy') {
        Advance-CoordinatedReleasePhase $manifest 'apps_release_requested' | Out-Null
        $State.coordinated_journal = @(Add-CoordinatedReleaseJournalEntry $manifest `
            'apps_release_requested_reconciled' 'durable app release requests reconciled after an interrupted write' $State.coordinated_journal)
        $changed = $true
    }
    if ((Test-CoordinatedReleaseAppsPublic $manifest) -and
        [string]$manifest.current_phase -eq 'apps_release_requested') {
        Advance-CoordinatedReleasePhase $manifest 'completed' | Out-Null
        $State.coordinated_journal = @(Add-CoordinatedReleaseJournalEntry $manifest `
            'completed_reconciled' 'durable public availability reconciled after an interrupted write' $State.coordinated_journal)
        $changed = $true
    }
    if ($changed) { Write-CoordinatedReleaseState $State }
    return $changed
}

function Invoke-CoordinatedReleaseWorkflow {
    param([Parameter(Mandatory = $true)]$State)
    $script:ActiveWorkflowDomain = 'deployment'
    Initialize-CoordinatedReleaseState $State | Out-Null
    Import-CoordinatedMobileReceipt $State | Out-Null
    Sync-CoordinatedReleaseServerPhases $State | Out-Null
    $manifest = $State.coordinated_manifest
    $gate = Get-CoordinatedReleaseGate $manifest
    $prePublication = (Get-CoordinatedReleasePhaseIndex ([string]$manifest.current_phase)) -lt
        (Get-CoordinatedReleasePhaseIndex 'server_published')
    if ($prePublication) {
        if (-not $gate.apps_submitted) { return Complete-CoordinatedReleaseStatus $State }
        if ([string]$manifest.current_phase -eq 'manifest_created') {
            Advance-CoordinatedReleasePhase $manifest 'apps_submitted' | Out-Null
            $State.coordinated_journal = @(Add-CoordinatedReleaseJournalEntry $manifest `
                'apps_submitted' 'both exact app submissions observed' $State.coordinated_journal)
            Write-CoordinatedReleaseState $State
        }
        if (-not (Test-CoordinatedReleaseAppsReady $manifest)) {
            return Complete-CoordinatedReleaseStatus $State
        }
        if ([string]$manifest.current_phase -eq 'apps_submitted') {
            Advance-CoordinatedReleasePhase $manifest 'apps_ready' | Out-Null
            $State.coordinated_journal = @(Add-CoordinatedReleaseJournalEntry $manifest `
                'apps_ready' 'both exact app approval/readiness states observed' $State.coordinated_journal)
            Write-CoordinatedReleaseState $State
        }
    }
    if (-not [bool]$manifest.server.published) {
        $State.candidate_integration_sha = [string]$manifest.pinned.server_sha
        $State.new_generation = [string]$manifest.pinned.generation
        Invoke-Phase $State 'coordinated_installed_deployment_identity_preflight' {
            Assert-LiveProductionIntegrity $State | Out-Null
            Assert-InstalledDeploymentIdentity $State | Out-Null
            $truth = Reconcile-RemoteTruth $State
            $observed = @(@(
                [string](Get-StateValue $truth 'deployed_sha' ''),
                [string](Get-StateValue $truth 'public_release_sha' '')
            ) | Where-Object { $_ -match '^[0-9a-f]{40}$' } | Select-Object -Unique)
            if ($observed.Count -eq 0) {
                Stop-Workflow 'coordinated release could not verify the currently active server identity before publication'
            }
            foreach ($observedSha in @($observed)) {
                if ([string]$observedSha -cne [string]$manifest.pinned.current_server_sha -and
                    [string]$observedSha -cne [string]$manifest.pinned.server_sha) {
                    Stop-Workflow 'currently active server identity changed after the coordinated manifest was pinned'
                }
            }
        } | Out-Null
        Invoke-Phase $State 'coordinated_prepare_pinned_server' {
            Assert-CoordinatedPinnedServerIdentity $State | Out-Null
            Initialize-CoordinatedPinnedWorktree $State | Out-Null
            Invoke-PrepareCandidate $State $State.candidate_integration_sha $State.new_generation
        } | Out-Null
        Invoke-CoordinatedMasterPublication $State | Out-Null
    }
    if (-not [bool]$manifest.server.activated -or -not [bool]$manifest.server.healthy) {
        $currentUpdaterHash = Get-FileSha256 (Join-Path $RepositoryRoot 'tools\release\vps\deploy-test-update.sh')
        $handoffPhase = $State.phases.PSObject.Properties['coordinated_retirement_tooling_handoff']
        $handoffNeedsRetry = $null -ne $handoffPhase -and [string]$handoffPhase.Value.status -cne 'completed'
        if ([string]$State.deployment_submission_updater_hash -cne $currentUpdaterHash -or $handoffNeedsRetry) {
            if ([string]$State.operation_id -cne 'coordinated-20260101T000000-00000000' -or
                [string]$manifest.pinned.server_sha -cne '4811473f91d3b209ddd3da7f47f4a41de97ca121' -or
                [string]$State.deployment_submission_updater_hash -cnotin @(
                    'a48707a2eb3ec28bd0b4281f22073fa26345570adb55ce40681d4cea23832d67',
                    '7a2bed570178b337613d9ec308230ac62e72c2ccc1341f19692902dd3ce83d62') -or
                $currentUpdaterHash -cne '7a2bed570178b337613d9ec308230ac62e72c2ccc1341f19692902dd3ce83d62') {
                Stop-Workflow 'coordinated prepared updater changed outside the reviewed retirement handoff'
            }
            Invoke-Phase $State 'coordinated_retirement_tooling_handoff' {
                Invoke-PrepareCandidate $State ([string]$manifest.pinned.server_sha) ([string]$manifest.pinned.generation)
            } | Out-Null
        }
        Invoke-DeploymentWorkflow $State
        $manifest.server.activated = $true
        $manifest.server.healthy = $true
        $manifest.server.public_release_sha = [string]$State.exact_public_release_sha
        if ([string]$manifest.current_phase -eq 'server_published') {
            Advance-CoordinatedReleasePhase $manifest 'server_activated' | Out-Null
            $State.coordinated_journal = @(Add-CoordinatedReleaseJournalEntry $manifest `
                'server_activated' 'pinned server activation completed' $State.coordinated_journal)
            Advance-CoordinatedReleasePhase $manifest 'server_healthy' | Out-Null
            $State.coordinated_journal = @(Add-CoordinatedReleaseJournalEntry $manifest `
                'server_healthy' 'host, World, public release, and browser health gates passed' $State.coordinated_journal)
        }
        Write-CoordinatedReleaseState $State
    }
    if ([bool](Get-CoordinatedProperty $manifest.server 'healthy' $false)) {
        Export-CoordinatedServerEvidence $State | Out-Null
    }
    if (-not (Test-CoordinatedReleaseAppsPublic $manifest)) {
        $releaseRequested = @(@('ios', 'android') | Where-Object {
                [bool](Get-CoordinatedProperty (Get-CoordinatedProperty $manifest.apps $_ $null) 'release_requested' $false)
            }).Count -eq 2
        if ($releaseRequested -and [string]$manifest.current_phase -eq 'server_healthy') {
            Advance-CoordinatedReleasePhase $manifest 'apps_release_requested' | Out-Null
            $State.coordinated_journal = @(Add-CoordinatedReleaseJournalEntry $manifest `
                'apps_release_requested' 'both app release requests observed after server health' $State.coordinated_journal)
            Write-CoordinatedReleaseState $State
        }
        return Complete-CoordinatedReleaseStatus $State
    }
    if ([string]$manifest.current_phase -eq 'apps_release_requested') {
        Advance-CoordinatedReleasePhase $manifest 'completed' | Out-Null
        $State.coordinated_journal = @(Add-CoordinatedReleaseJournalEntry $manifest `
            'completed' 'both exact app public availability receipts observed' $State.coordinated_journal)
    }
    return Complete-CoordinatedReleaseStatus $State
}

function Write-TimingReports {
    param([Parameter(Mandatory = $true)]$State)
    try {
    if ([string]$State.candidate_integration_sha -and
        [string]$State.candidate_integration_sha -cnotmatch '^[0-9a-f]{40}$') {
        Stop-Workflow 'timing report candidate SHA is not one canonical lowercase commit id'
    }
    $records = @($State.phases.PSObject.Properties | ForEach-Object {
        $measured = Get-ReleasePhaseTiming $_.Value $State.updated_at_utc
        [pscustomobject]@{
            phase = $_.Name
            status = [string]$_.Value.status
            started_at_utc = $measured.started_at_utc
            finished_at_utc = $measured.finished_at_utc
            duration_ms = $measured.duration_ms
            active_duration_ms = $measured.active_duration_ms
            wall_clock_duration_ms = $measured.wall_clock_duration_ms
            attempt_count = $measured.attempt_count
            attempts = $measured.attempts
        }
    })
    $remoteRecords = @()
    if ($null -ne $State.deployment_phase_timings) {
        $remoteRecords = @($State.deployment_phase_timings.phases | ForEach-Object {
            $duration = Get-ReleaseElapsedMilliseconds $_.started_at_utc $_.finished_at_utc
            [pscustomobject]@{
                phase = "vps:$($_.phase)"
                status = [string]$_.result
                started_at_utc = ConvertTo-ReleaseTimestampUtc $_.started_at_utc
                finished_at_utc = ConvertTo-ReleaseTimestampUtc $_.finished_at_utc -AllowEmpty
                duration_ms = $duration
                active_duration_ms = $duration
                wall_clock_duration_ms = $duration
                attempt_count = 1
                attempts = @()
            }
        })
    }
    $sumDuration = {
        param([object[]]$Items)
        $sum = [long]0
        foreach ($item in @($Items)) {
            if ($null -ne $item) { $sum += [long]$item.duration_ms }
        }
        return $sum
    }
    $phaseWallTotal = & $sumDuration -Items $records
    $activeTotal = [long]0
    foreach ($item in $records) { $activeTotal += [long]$item.active_duration_ms }
    $workflowStarted = ConvertTo-ReleaseTimestampUtc $State.created_at_utc
    $workflowFinished = ConvertTo-ReleaseTimestampUtc (Get-StateValue $State 'completed_at_utc' '') -AllowEmpty
    if (-not $workflowFinished) { $workflowFinished = ConvertTo-ReleaseTimestampUtc $State.updated_at_utc }
    $total = Get-ReleaseElapsedMilliseconds $workflowStarted $workflowFinished
    $integrationNames = @('initial_remote_snapshot', 'feature_and_worktree_validation', 'local_merge',
        'focused_admission', 'atomic_branch_and_generation_publication', 'remote_verification', 'merged_receipt',
        'local_checkout_reconciliation', 'publish_local_checkout_reconciliation',
        'batch_initial_git_preflight', 'batch_exact_feature_verification', 'batch_local_merge_chain',
        'batch_final_validation', 'batch_atomic_protected_publication',
        'batch_remote_publication_verification', 'batch_local_checkout_reconciliation',
        'batch_merged_receipts')
    $publicationNames = @('master_fast_forward_and_push', 'deployment', 'host_readiness_and_public_world_verification')
    $integrationDuration = & $sumDuration -Items @($records | Where-Object phase -in $integrationNames)
    $publicationDuration = & $sumDuration -Items @($records | Where-Object phase -in $publicationNames)
    $masterDuration = [long](& $sumDuration -Items @($records | Where-Object phase -eq 'master_fast_forward_and_push'))
    $publicationToLiveDuration = $null
    $operationToLiveDuration = $null
    $masterRecord = @($records | Where-Object phase -eq 'master_fast_forward_and_push' | Select-Object -First 1)
    $deploymentRecord = @($records | Where-Object phase -eq 'deployment' | Select-Object -First 1)
    if ($deploymentRecord.Count -eq 1 -and $deploymentRecord[0].status -eq 'completed' -and
        $deploymentRecord[0].finished_at_utc) {
        $operationToLiveDuration = Get-ReleaseElapsedMilliseconds $workflowStarted $deploymentRecord[0].finished_at_utc
        if ($masterRecord.Count -eq 1 -and $masterRecord[0].started_at_utc) {
            $publicationToLiveDuration = Get-ReleaseElapsedMilliseconds $masterRecord[0].started_at_utc $deploymentRecord[0].finished_at_utc
        }
    }
    $finalVerificationDuration = [long](& $sumDuration -Items @($records | Where-Object phase -eq 'host_readiness_and_public_world_verification'))
    $remoteDeploymentDuration = if ($null -ne $State.deployment_phase_timings) {
        [long](Get-StateValue $State.deployment_phase_timings 'total_duration_ms' 0)
    } else { [long]0 }
    $cacheResults = if ($null -ne $State.remote_deployment_receipt) {
        Get-StateValue $State.remote_deployment_receipt 'cache_results' $null
    } else { $null }
    $warmPath = $null -ne $cacheResults -and
        [string](Get-StateValue $cacheResults 'dependencies' '') -eq 'cache_hit' -and
        [string](Get-StateValue $cacheResults 'server' '') -ne 'build' -and
        [string](Get-StateValue $cacheResults 'client' '') -ne 'build'
    $laneBudget = switch ([string]$State.deployment_lane) {
        'client' { 45000 }
        'application' { 60000 }
        default { 0 }
    }
    $transportStartupDuration = [long]0
    foreach ($event in @($State.deployment_transport_events)) {
        $transportStartupDuration = [long][math]::Max(
            $transportStartupDuration, [long]$event.startup_duration_ms)
    }
    $budgets = [pscustomobject][ordered]@{
        integration_publication_ms = 30000
        master_publication_ms = 10000
        remote_acceptance_ms = $SshHardDeadlineSeconds * 1000
        https_status_read_ms = 2000
        client_deployment_ms = 45000
        application_deployment_ms = 60000
        final_verification_ms = 10000
        warm_approval_to_live_ms = 90000 # Legacy budget key; now evaluates the complete operation-to-live interval.
        warm_operation_start_to_live_ms = 90000
        warm_path = $warmPath
        integration_pass = Test-ReleaseTimingBudget $integrationDuration 30000 (@($records | Where-Object { $_.phase -in $integrationNames -and $_.status -eq 'completed' }).Count -gt 0)
        master_pass = Test-ReleaseTimingBudget $masterDuration 10000 ($masterRecord.Count -eq 1 -and $masterRecord[0].status -eq 'completed')
        acceptance_pass = Test-ReleaseTimingBudget ([long]$State.remote_acceptance_duration_ms) ($SshHardDeadlineSeconds * 1000) ([bool](Get-StateValue $State 'deployment_admission_discovered_at_utc' ''))
        https_status_read_pass = Test-ReleaseTimingBudget ([long]$State.deployment_https_status_longest_read_ms) 2000 ([int]$State.deployment_https_status_read_count -gt 0)
        lane_pass = Test-ReleaseTimingBudget $remoteDeploymentDuration $laneBudget ($laneBudget -gt 0 -and $warmPath -and $null -ne $operationToLiveDuration -and $null -ne $State.deployment_phase_timings)
        final_verification_pass = Test-ReleaseTimingBudget $finalVerificationDuration 10000 (@($records | Where-Object { $_.phase -eq 'host_readiness_and_public_world_verification' -and $_.status -eq 'completed' }).Count -eq 1)
        warm_total_pass = Test-ReleaseTimingBudget ([long]$operationToLiveDuration) 90000 ($warmPath -and $null -ne $operationToLiveDuration)
    }
    if (-not $Json) {
        if ($false -eq $budgets.integration_pass) {
            Write-Warning "release stage exceeded budget: integration/publication ${integrationDuration}ms > 30000ms"
        }
        if ($false -eq $budgets.master_pass) {
            Write-Warning "release stage exceeded budget: master publication ${masterDuration}ms > 10000ms"
        }
        if ($false -eq $budgets.lane_pass) {
            Write-Warning "release stage exceeded warm lane budget: remote deployment ${remoteDeploymentDuration}ms > ${laneBudget}ms"
        }
        if ($false -eq $budgets.final_verification_pass) {
            Write-Warning "release stage exceeded budget: final verification ${finalVerificationDuration}ms > 10000ms"
        }
        if ($false -eq $budgets.warm_total_pass) {
            Write-Warning "release stage exceeded budget: operation start-to-live ${operationToLiveDuration}ms > 90000ms"
        }
    }
    $report = [pscustomobject][ordered]@{
        operation_id = [string]$State.operation_id
        timing_status = 'valid'
        candidate_sha = [string]$State.candidate_integration_sha
        release_queue_requested_at_utc = ConvertTo-ReleaseTimestampUtc (Get-StateValue $State 'release_queue_requested_at_utc' '') -AllowEmpty
        release_lease_acquired_at_utc = ConvertTo-ReleaseTimestampUtc (Get-StateValue $State 'release_lease_acquired_at_utc' '') -AllowEmpty
        release_queue_wait_duration_ms =
            [long](Get-StateValue $State 'release_queue_wait_duration_ms' 0)
        phases = @($records + $remoteRecords)
        total_integration_duration_ms = $integrationDuration
        total_publication_duration_ms = $publicationDuration
        # Preserve legacy fields for consumers, explicitly identifying their narrower measurement.
        total_approval_to_live_duration_ms = $publicationToLiveDuration
        approval_to_live_measurement = 'legacy alias of publication_to_live_duration_ms; excludes preparation'
        publication_to_live_duration_ms = $publicationToLiveDuration
        operation_start_to_live_duration_ms = $operationToLiveDuration
        operation_start_to_live_measurement = 'operation created_at_utc to completed deployment phase finished_at_utc'
        total_duration_ms = $total
        total_active_duration_ms = $activeTotal
        total_phase_wall_clock_duration_ms = $phaseWallTotal
        workflow_started_at_utc = $workflowStarted
        workflow_finished_at_utc = $workflowFinished
        approval_to_live_duration_ms = $publicationToLiveDuration
        final_confirmation_duration_ms = $finalVerificationDuration
        deployment_lane = [string]$State.deployment_lane
        release_classification_version = [int]$State.release_classification_version
        release_class = [string]$State.release_class
        prepared_descriptor_version = [int]$State.prepared_descriptor_version
        prepared_descriptor_sha256 = [string]$State.prepared_descriptor_sha256
        server_component_sha = [string](Get-StateValue $State 'prepared_server_component_sha' '')
        client_component_sha = [string](Get-StateValue $State 'prepared_client_component_sha' '')
        deployment_transport = [string]$State.deployment_transport
        deployment_transport_longest_startup_ms = $transportStartupDuration
        deployment_ssh_connections = [int]$State.deployment_ssh_connection_count
        deployment_submission_attempts = [int]$State.deployment_submission_attempt_count
        deployment_submission_retries = [int]$State.deployment_submission_retry_count
        deployment_last_outcome = [string]$State.deployment_last_outcome
        deployment_https_status_reads = [int]$State.deployment_https_status_read_count
        deployment_https_status_longest_read_ms = [long]$State.deployment_https_status_longest_read_ms
        deployment_ssh_fallbacks = [int]$State.deployment_ssh_fallback_count
        deployment_status_read_failures = [int]$State.deployment_status_read_failures
        deployment_longest_receipt_outage_ms = [long]$State.deployment_longest_receipt_outage_ms
        deployment_total_receipt_outage_ms = [long]$State.deployment_total_receipt_outage_ms
        deployment_poll_wait_duration_ms = [long]$State.deployment_poll_wait_duration_ms
        deployment_transition_events = @(Get-StateValue $State 'deployment_transition_events' @())
        remote_state_transitions = if ($null -ne $State.remote_deployment_receipt) {
            @(Get-StateValue $State.remote_deployment_receipt 'state_transitions' @())
        } else { @() }
        deployment_completion_observation_lag_ms =
            [long](Get-StateValue $State 'deployment_completion_observation_lag_ms' 0)
        deployment_automatic_reconciliation_required =
            [bool]$State.deployment_automatic_reconciliation_required
        remote_acceptance_duration_ms = [long]$State.remote_acceptance_duration_ms
        admission_discovery_source = [string]$State.deployment_admission_source
        admission_discovery_duration_ms = $State.deployment_admission_duration_ms
        https_admission_discovery_duration_ms =
            $State.deployment_https_admission_duration_ms
        operation_completion_duration_ms =
            $State.deployment_operation_completion_duration_ms
        remote_deployment_duration_ms = $remoteDeploymentDuration
        initial_remote_git_fetch_count = [int](Get-StateValue $State 'initial_remote_fetch_count' 0)
        initial_remote_git_snapshot_count = [int](Get-StateValue $State 'initial_remote_snapshot_count' 0)
        batch_merge_duration_ms = [long](& $sumDuration -Items @(
                $records | Where-Object phase -eq 'batch_local_merge_chain'
            ))
        batch_final_validation_duration_ms = [long](& $sumDuration -Items @(
                $records | Where-Object phase -eq 'batch_final_validation'
            ))
        batch_validation_gates = @((Get-StateValue $State 'validation_receipts' @()) | ForEach-Object {
                [pscustomobject]@{ name = $_.name; duration_ms = $_.duration_ms; exit_code = $_.exit_code }
            })
        validations_reused = [int](Get-StateValue $State 'validations_reused' 0)
        validations_executed = [int](Get-StateValue $State 'validations_executed' 0)
        atomic_publication_duration_ms = [long](Get-StateValue $State 'atomic_publication_duration_ms' 0)
        deployment_submission_duration_ms = [long](Get-StateValue $State 'deployment_submission_duration_ms' 0)
        budgets = $budgets
    }
    $jsonPath = Join-Path $StateRoot "$($State.operation_id).timings.json"
    $textPath = Join-Path $StateRoot "$($State.operation_id).timings.txt"
    $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $jsonPath -Encoding utf8
    @(@($records + $remoteRecords) | ForEach-Object {
            "{0}: {1} -> {2}; {3} ms ({4})" -f $_.phase, $_.started_at_utc, $_.finished_at_utc, $_.duration_ms, $_.status
        }) +
        @("integration total: $integrationDuration ms", "publication total: $publicationDuration ms",
            "remote acceptance: $($State.remote_acceptance_duration_ms) ms",
            "release queue wait: $(Get-StateValue $State 'release_queue_wait_duration_ms' 0) ms",
            "deployment transport: $($State.deployment_transport)",
            "deployment submission attempts: $($State.deployment_submission_attempt_count)",
            "deployment submission retries: $($State.deployment_submission_retry_count)",
            "admission discovery source: $($State.deployment_admission_source)",
            "admission discovery: $($State.deployment_admission_duration_ms) ms",
            "HTTPS admission discovery: $($State.deployment_https_admission_duration_ms) ms",
            "operation completion: $($State.deployment_operation_completion_duration_ms) ms",
            "last deployment outcome: $($State.deployment_last_outcome)",
            "deployment SSH connections: $($State.deployment_ssh_connection_count)",
            "deployment HTTPS status reads: $($State.deployment_https_status_read_count)",
            "longest HTTPS status read: $($State.deployment_https_status_longest_read_ms) ms",
            "deployment SSH fallbacks: $($State.deployment_ssh_fallback_count)",
            "deployment status read failures: $($State.deployment_status_read_failures)",
            "longest receipt outage: $($State.deployment_longest_receipt_outage_ms) ms",
            "total receipt outage: $($State.deployment_total_receipt_outage_ms) ms",
            "deployment polling wait: $($State.deployment_poll_wait_duration_ms) ms",
            "deployment completion observation lag: $(Get-StateValue $State 'deployment_completion_observation_lag_ms' 0) ms",
            "automatic receipt reconciliation: $($State.deployment_automatic_reconciliation_required)",
            "publication-to-live: $(if ($null -eq $publicationToLiveDuration) { 'N/A' } else { "$publicationToLiveDuration ms" })",
            "operation start-to-live: $(if ($null -eq $operationToLiveDuration) { 'N/A' } else { "$operationToLiveDuration ms" })",
            "final confirmation: $finalVerificationDuration ms",
            "workflow end-to-end: $total ms",
            "workflow active attempts: $activeTotal ms",
            "workflow phase wall-clock total: $phaseWallTotal ms") +
        @($budgets.PSObject.Properties | Where-Object Name -like '*_pass' | ForEach-Object {
            "budget $($_.Name): $(if ($null -eq $_.Value) { 'N/A' } elseif ($_.Value) { 'PASS' } else { 'FAIL' })"
        }) |
        Set-Content -LiteralPath $textPath -Encoding utf8
    return $report
    } catch {
        # A diagnostic failure must not change release status or gate subsequent activation.
        $report = [pscustomobject][ordered]@{
            operation_id = [string]$State.operation_id
            timing_status = 'invalid'
            timing_error = $_.Exception.Message
            total_duration_ms = $null
            total_integration_duration_ms = $null
            total_publication_duration_ms = $null
            total_approval_to_live_duration_ms = $null
            approval_to_live_duration_ms = $null
            total_active_duration_ms = $null
            total_phase_wall_clock_duration_ms = $null
            operation_start_to_live_duration_ms = $null
            publication_to_live_duration_ms = $null
            initial_remote_git_fetch_count = Get-StateValue $State 'initial_remote_fetch_count' 0
            initial_remote_git_snapshot_count = Get-StateValue $State 'initial_remote_snapshot_count' 0
            batch_merge_duration_ms = $null
            budgets = [pscustomobject]@{
                integration_pass = $null; master_pass = $null; acceptance_pass = $null
                https_status_read_pass = $null; lane_pass = $null; final_verification_pass = $null
                warm_total_pass = $null
            }
        }
        Write-Warning "Release timing report unavailable: $($report.timing_error)"
        try {
            $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $StateRoot "$($State.operation_id).timings.json") -Encoding utf8
            "Timing N/A: $($report.timing_error)" | Set-Content -LiteralPath (Join-Path $StateRoot "$($State.operation_id).timings.txt") -Encoding utf8
        } catch { Write-Warning "Could not write timing diagnostic: $($_.Exception.Message)" }
        return $report
    }
}

$script:ActiveWorkflowDomain = 'git-only'

if ($Mode -eq 'Coordinated') { $Mode = 'CoordinatedRelease' }

# Careful lane: changes that need the owner's approval (and, for migrations, the schema-only
# database rehearsal on the VPS). Everything else is the automatic fast lane.
$CarefulLanePathPattern = '^(db/migrations/|apps/server/src/db/migrate\.ts$|tools/release/|tools/mobile-release/|' +
    '\.github/|ios/|android/|fastlane/|capacitor\.config\.ts$|config/protocol-versions\.json$|' +
    'config/release-mode\.json$|packages/shared/src/nativeCompatibility\.ts$)'

function Assert-TrustedToolingCopy {
    # Release tooling always runs from the permanent checkout, and that copy must match live master.
    if (-not (Test-AshAtlasSamePath $RepositoryRoot $SourceRepositoryRoot)) {
        Stop-Workflow "Deploy must run from the trusted tooling copy $SourceRepositoryRoot, not $RepositoryRoot"
    }
    $toolingStartSha = (& git -C $SourceRepositoryRoot rev-parse HEAD).Trim()
    $lines = @(& git -C $SourceRepositoryRoot fetch --quiet origin master integration/test 2>&1)
    if ($LASTEXITCODE -ne 0) { Stop-Workflow "could not fetch origin: $($lines -join ' ')" }
    # Check both release checkouts before anything is pushed, so a deploy never stops halfway.
    foreach ($checkout in @(
            @($SourceRepositoryRoot, 'origin/master', 'main checkout'),
            @($IntegrationWorktree, 'origin/integration/test', 'integration checkout'))) {
        $branch = (& git -C $checkout[0] branch --show-current 2>&1 | Out-String).Trim()
        if ("origin/$branch" -cne $checkout[1]) {
            Stop-Workflow "$($checkout[2]) $($checkout[0]) must be on $($checkout[1].Substring(7)), not '$branch'"
        }
        $dirty = @(& git -C $checkout[0] status --porcelain --untracked-files=no 2>&1)
        if ($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0) {
            Stop-Workflow ("{0} {1} has uncommitted changes; commit or stash them first: {2}" -f
                $checkout[2], $checkout[0], ($dirty -join '; '))
        }
        # A release made elsewhere (for example the private runner) can leave a checkout behind.
        $lines = @(& git -C $checkout[0] merge --ff-only --quiet $checkout[1] 2>&1)
        if ($LASTEXITCODE -ne 0) {
            Stop-Workflow "$($checkout[2]) cannot fast-forward to $($checkout[1]): $($lines -join ' ')"
        }
    }
    # This process already loaded the older scripts; rerun so the updated tooling does the release.
    & git -C $SourceRepositoryRoot diff --quiet $toolingStartSha -- tools/release
    if ($LASTEXITCODE -ne 0) {
        Stop-Workflow 'release tooling was just updated to live master; run the same Deploy command again'
    }
}

function Get-CarefulLanePaths([string]$Worktree) {
    $paths = @(& git -C $Worktree diff --name-only 'origin/master...HEAD' 2>&1)
    if ($LASTEXITCODE -ne 0) { Stop-Workflow "could not classify the feature diff: $($paths -join ' ')" }
    return @($paths | Where-Object { ([string]$_).Replace('\', '/') -match $CarefulLanePathPattern })
}

if ($Mode -eq 'Deploy') {
    # One command for a normal feature: integrate, publish, and deploy web + server + OTA bundles.
    if (-not $FeatureWorktree) { Stop-Workflow 'Deploy requires -FeatureWorktree' }
    Assert-TrustedToolingCopy
    $carefulPaths = @(Get-CarefulLanePaths $FeatureWorktree)
    if ($carefulPaths.Count -gt 0 -and -not $CarefulLane) {
        Stop-Workflow ("careful lane: owner approval is required for {0}. After approval rerun with -CarefulLane." -f
            ($carefulPaths -join ', '))
    }
    if (-not $Json) { Write-Host ("Deploy lane: {0}" -f $(if ($carefulPaths.Count -gt 0) { 'careful (approved)' } else { 'fast' })) }
    $Mode = 'IntegrateAndPublish'
    $ConfirmIntegration = $true
    $ConfirmGenerationCheckpoint = $true
    $ApprovedIntegrationTest = $true
    $ConfirmPublish = $true
    $ConfirmDeploy = $true
    if (-not $DisplayName) { $DisplayName = Split-Path -Leaf $FeatureWorktree }
}

$batchAdmissionManifest = $null
if ($BatchAdmissionManifestPath) {
    if ($Mode -notin @('IntegrateBatchAdmission', 'Resume', 'Inspect')) {
        Stop-Workflow '-BatchAdmissionManifestPath is valid only with IntegrateBatchAdmission, Resume, or Inspect'
    }
    $manifestOperationId = if ($OperationId) { $OperationId } else { '' }
    if ($manifestOperationId) {
        $requireProtectedTuple = $Mode -in @('IntegrateBatchAdmission', 'Resume')
        $batchAdmissionManifest = Read-BatchAdmissionManifest $BatchAdmissionManifestPath $manifestOperationId `
            -RequireProtectedTuple:$requireProtectedTuple
    }
}
if ($Mode -eq 'IntegrateBatchAdmission' -and $null -ne $batchAdmissionManifest) {
    $manifestFeatures = @($batchAdmissionManifest.features)
    $FeatureWorktrees = [string[]]@($manifestFeatures | ForEach-Object { [string]$_.worktree })
    $FeatureBranches = [string[]]@($manifestFeatures | ForEach-Object { [string]$_.branch })
    $FeatureTipShas = [string[]]@($manifestFeatures | ForEach-Object { [string]$_.sha })
    $PlayerPatchNotes = [string[]]@($manifestFeatures | ForEach-Object { [string]$_.player_patch_note })
}

function Test-GitOnlyReconciliationRequired {
    param([Parameter(Mandatory = $true)]$State)
    if ([bool](Get-StateValue $State 'side_effect_reconciliation_required' $false)) { return $true }
    $intent = Get-StateValue $State 'remote_side_effect_intent' $null
    $activationIntent = Get-StateValue $State 'activation_intent' $null
    if ($null -ne $activationIntent -and
        -not [bool](Get-StateValue $State 'activation_intent_resolved' $false)) { return $false }
    if ([bool](Get-StateValue $State 'deployment_automatic_reconciliation_required' $false)) { return $false }
    if ($null -ne $intent -and [string](Get-StateValue $intent 'status' '') -eq 'pending' -and
        [string](Get-StateValue $intent 'kind' '') -eq 'vps_activation') { return $false }
    if ($null -ne $intent -and [string](Get-StateValue $intent 'status' '') -eq 'pending' -and
        [string](Get-StateValue $intent 'kind' '') -like 'git_*') { return $true }
    $requestedMode = [string](Get-StateValue $State 'requested_mode' '')
    if ($requestedMode -eq 'Integrate') { return $true }
    if ([bool](Get-StateValue $State 'is_batch' $false)) {
        $batchPhaseName = if ($requestedMode -eq 'IntegrateBatchAdmission') {
            'batch_admission_protected_publication'
        } else { 'batch_atomic_protected_publication' }
        $batchPublication = $State.phases.PSObject.Properties[$batchPhaseName]
        return $null -eq $batchPublication -or
            [string]$batchPublication.Value.status -ne 'completed'
    }
    $masterPhase = $State.phases.PSObject.Properties['master_fast_forward_and_push']
    return $null -eq $masterPhase -or [string]$masterPhase.Value.status -ne 'completed'
}

if ($PSBoundParameters.ContainsKey('FeatureWorktrees') -and
    ($null -eq $FeatureWorktrees -or $FeatureWorktrees.Count -eq 0)) {
    Stop-Workflow '-FeatureWorktrees requires one or more ordered worktree paths'
}
if ($null -ne $FeatureWorktrees -and $FeatureWorktrees.Count -eq 1) {
    Stop-Workflow 'one feature cannot use -FeatureWorktrees; use -FeatureWorktree so the focused single-feature fast path is selected'
}
if ($FeatureWorktree -and $null -ne $FeatureWorktrees -and $FeatureWorktrees.Count -gt 0) {
    Stop-Workflow 'use either -FeatureWorktree or -FeatureWorktrees, not both'
}
if ($null -ne $FeatureWorktrees -and $FeatureWorktrees.Count -gt 0 -and
    $Mode -notin @('IntegrateAndPublish', 'IntegrateBatchAdmission')) {
    Stop-Workflow '-FeatureWorktrees is valid only with IntegrateAndPublish or IntegrateBatchAdmission'
}
if ($null -ne $FeatureBranches -and $FeatureBranches.Count -gt 0 -and
    $Mode -ne 'IntegrateBatchAdmission') {
    Stop-Workflow '-FeatureBranches is valid only with IntegrateBatchAdmission'
}
if ($null -ne $FeatureTipShas -and $FeatureTipShas.Count -gt 0 -and
    $Mode -ne 'IntegrateBatchAdmission') {
    Stop-Workflow '-FeatureTipShas is valid only with IntegrateBatchAdmission'
}
if ($Mode -eq 'IntegrateBatchAdmission') {
    if ($null -eq $FeatureWorktrees -or $FeatureWorktrees.Count -lt 2) {
        Stop-Workflow 'IntegrateBatchAdmission requires at least two ordered -FeatureWorktrees'
    }
    if ($null -eq $FeatureBranches -or $FeatureBranches.Count -ne $FeatureWorktrees.Count) {
        Stop-Workflow 'IntegrateBatchAdmission requires ordered -FeatureBranches aligned with -FeatureWorktrees'
    }
    if ($null -eq $FeatureTipShas -or $FeatureTipShas.Count -ne $FeatureWorktrees.Count) {
        Stop-Workflow 'IntegrateBatchAdmission requires ordered -FeatureTipShas aligned with -FeatureWorktrees'
    }
    if (-not $ConfirmBatchAdmission) {
        Stop-Workflow 'IntegrateBatchAdmission requires -ConfirmBatchAdmission'
    }
    if (-not $ConfirmIntegration -or -not $ConfirmGenerationCheckpoint -or -not $ApprovedIntegrationTest) {
        Stop-Workflow 'IntegrateBatchAdmission requires -ConfirmIntegration, -ConfirmGenerationCheckpoint, and -ApprovedIntegrationTest'
    }
    if ($AtomicMasterPublication -or $ConfirmPublish -or $ConfirmDeploy -or $ConfirmCombinedRelease) {
        Stop-Workflow 'IntegrateBatchAdmission cannot accept master publication, deployment, or combined-release confirmations'
    }
}
if (($null -ne $FeatureBranches -and $FeatureBranches.Count -gt 0) -and
    ($null -eq $FeatureWorktrees -or $FeatureBranches.Count -ne $FeatureWorktrees.Count)) {
    Stop-Workflow '-FeatureBranches must align exactly with -FeatureWorktrees'
}
if (($null -ne $FeatureTipShas -and $FeatureTipShas.Count -gt 0) -and
    ($null -eq $FeatureWorktrees -or $FeatureTipShas.Count -ne $FeatureWorktrees.Count)) {
    Stop-Workflow '-FeatureTipShas must align exactly with -FeatureWorktrees'
}
if ($ConfirmBatchAdmission -and $Mode -ne 'IntegrateBatchAdmission') {
    Stop-Workflow '-ConfirmBatchAdmission is valid only with IntegrateBatchAdmission'
}
if (($BatchValidatorAdapterPath -or $BatchValidatorReceiptPath -or $BatchAdmissionManifestPath) -and
    $Mode -notin @('IntegrateBatchAdmission', 'Resume', 'Inspect')) {
    Stop-Workflow 'batch validator and admission-manifest inputs are valid only with IntegrateBatchAdmission, Resume, or Inspect'
}
if ($ConfirmCombinedRelease -and $Mode -ne 'IntegrateAndPublish') {
    Stop-Workflow '-ConfirmCombinedRelease is valid only with IntegrateAndPublish'
}
if ($ConfirmCombinedRelease -and
    ($null -eq $FeatureWorktrees -or $FeatureWorktrees.Count -eq 0)) {
    Stop-Workflow '-ConfirmCombinedRelease requires -FeatureWorktrees'
}
if ($ConfirmConflictResolution -and $Mode -ne 'Resume') {
    Stop-Workflow '-ConfirmConflictResolution is valid only with Resume'
}
if ($ConfirmWorldHandoffRecovery -and $Mode -notin @('Publish', 'IntegrateAndPublish', 'Resume')) {
    Stop-Workflow '-ConfirmWorldHandoffRecovery is valid only with Publish, IntegrateAndPublish, or Resume'
}
if ($ConfirmIntegrationWorktreeRecovery -and $Mode -ne 'RecoverIntegrationWorktree') {
    Stop-Workflow '-ConfirmIntegrationWorktreeRecovery is valid only with RecoverIntegrationWorktree'
}
if ($ConfirmPlayerPatchNoteEncodingRecovery -and $Mode -ne 'RecoverIntegrationWorktree') {
    Stop-Workflow '-ConfirmPlayerPatchNoteEncodingRecovery is valid only with RecoverIntegrationWorktree'
}
if ($ConfirmBatchCandidateIdentityReconciliation -and $Mode -ne 'ReconcileBatchCandidateIdentity') {
    Stop-Workflow '-ConfirmBatchCandidateIdentityReconciliation is valid only with ReconcileBatchCandidateIdentity'
}
if (($PSBoundParameters.ContainsKey('CandidateDisposition') -or
        $PSBoundParameters.ContainsKey('CandidateDispositionReason') -or
        $ConfirmCandidateRetirement) -and $Mode -notin @('RecoverIntegrationWorktree', 'SupersedePublishedRelease')) {
    Stop-Workflow 'candidate-disposition options are valid only with RecoverIntegrationWorktree or SupersedePublishedRelease'
}
if ($ConfirmCandidateRetirement -and $CandidateDisposition -notin @('Superseded', 'Abandoned')) {
    Stop-Workflow '-ConfirmCandidateRetirement requires Superseded or Abandoned disposition'
}
if ($RelatedBlockedOperationId -and $Mode -ne 'RecoverIntegrationWorktree') {
    Stop-Workflow '-RelatedBlockedOperationId is valid only with RecoverIntegrationWorktree'
}
if ($Mode -eq 'ReconcileBatchCandidateIdentity' -and -not $OperationId) {
    Stop-Workflow 'ReconcileBatchCandidateIdentity requires -OperationId'
}
if ($Mode -eq 'ReconcileBatchCandidateIdentity' -and
    ($FeatureWorktree -or ($null -ne $FeatureWorktrees -and $FeatureWorktrees.Count -gt 0))) {
    Stop-Workflow 'ReconcileBatchCandidateIdentity does not accept feature worktrees'
}
if ($ConfirmCoordinatedRelease -and $Mode -notin @('CoordinatedRelease', 'Resume')) {
    Stop-Workflow '-ConfirmCoordinatedRelease is valid only with CoordinatedRelease or Resume'
}
if ($Mode -eq 'CoordinatedRelease') {
    if (-not $ConfirmCoordinatedRelease) {
        Stop-Workflow 'CoordinatedRelease requires -ConfirmCoordinatedRelease'
    }
}
if (($CoordinatedGeneration -or $CoordinatedServerSha -or $CoordinatedAcceptedMasterSha -or
        $CoordinatedManifestPath -or $CoordinatedSeedPath -or $CoordinatedMobileReceiptPath -or
        $CoordinatedServerEvidencePath) -and
    $Mode -notin @('CoordinatedRelease', 'Resume', 'Inspect')) {
    Stop-Workflow 'coordinated release inputs are valid only with CoordinatedRelease, Resume, or Inspect'
}
if ($PublishPatchNotes -or $PSBoundParameters.ContainsKey('ReleasePatchNotes')) {
    if ($Mode -notin @('Publish', 'IntegrateAndPublish')) {
        Stop-Workflow 'patch-note publication inputs are valid only for a new publication operation; Resume uses frozen consent and wording'
    }
    if (-not $PublishPatchNotes -or $null -eq $ReleasePatchNotes -or
        $ReleasePatchNotes.Count -lt 1 -or $ReleasePatchNotes.Count -gt 50) {
        Stop-Workflow 'patch-note publication requires both -PublishPatchNotes and 1 to 50 supplied -ReleasePatchNotes'
    }
    $ReleasePatchNotes = @($ReleasePatchNotes | ForEach-Object {
        ConvertTo-PlayerPatchNote ([string]$_)
    })
}
if ($Mode -in @('Integrate', 'IntegrateAndPublish', 'IntegrateBatchAdmission')) {
    if ($FeatureWorktree) {
        if ($PSBoundParameters.ContainsKey('PlayerPatchNotes')) {
            Stop-Workflow 'use -PlayerPatchNote with -FeatureWorktree, not -PlayerPatchNotes'
        }
        if ($PSBoundParameters.ContainsKey('PlayerPatchNote')) {
            $PlayerPatchNote = ConvertTo-PlayerPatchNote $PlayerPatchNote
        }
    } elseif ($null -ne $FeatureWorktrees -and $FeatureWorktrees.Count -gt 0) {
        if ($PSBoundParameters.ContainsKey('PlayerPatchNote')) {
            Stop-Workflow 'use -PlayerPatchNotes with -FeatureWorktrees, not -PlayerPatchNote'
        }
        if (-not $PSBoundParameters.ContainsKey('PlayerPatchNotes')) {
            $PlayerPatchNotes = @($FeatureWorktrees | ForEach-Object { '' })
        } elseif ($null -eq $PlayerPatchNotes -or $PlayerPatchNotes.Count -ne $FeatureWorktrees.Count) {
            Stop-Workflow '-PlayerPatchNotes must align exactly with -FeatureWorktrees'
        }
        $PlayerPatchNotes = @($PlayerPatchNotes | ForEach-Object {
                if ([string]$_) { ConvertTo-PlayerPatchNote ([string]$_) } else { '' }
            })
    }
} elseif ($PSBoundParameters.ContainsKey('PlayerPatchNote') -or
    $PSBoundParameters.ContainsKey('PlayerPatchNotes')) {
    Stop-Workflow 'player patch-note inputs are valid only for a new integration operation'
}
if ($Mode -eq 'RecoverIntegrationWorktree' -and -not $OperationId) {
    Stop-Workflow 'RecoverIntegrationWorktree requires -OperationId'
}
if ($Mode -eq 'SupersedePublishedRelease' -and
    (-not $OperationId -or $CandidateDisposition -ne 'Superseded' -or -not $ConfirmCandidateRetirement -or
     -not ([string]$CandidateDispositionReason).Trim())) {
    Stop-Workflow ('SupersedePublishedRelease requires -OperationId, -CandidateDisposition Superseded, ' +
        '-ConfirmCandidateRetirement, and -CandidateDispositionReason')
}
if ($ConfirmCombinedRelease) {
    $ConfirmIntegration = $true
    $ConfirmGenerationCheckpoint = $true
    $AtomicMasterPublication = $true
    $ApprovedIntegrationTest = $true
    $ConfirmPublish = $true
    $ConfirmDeploy = $true
}
if ($Mode -eq 'IntegrateAndPublish') {
    $AtomicMasterPublication = $true
}
if ($Mode -eq 'CoordinatedRelease' -and $ConfirmCoordinatedRelease) {
    $ApprovedIntegrationTest = $true
    $ConfirmPublish = $true
    $ConfirmDeploy = $true
}

function Assert-InstalledDeploymentIdentity {
    param([Parameter(Mandatory = $true)]$State)
    $response = Invoke-DeploymentController $State identity @()
    if ([int]$response.exit_code -ne 0 -or $null -eq $response.payload) {
        Stop-Workflow 'installed deployment identity could not be read before protected publication'
    }
    $identity = $response.payload
    $fields = @('schema_version', 'controller_version', 'updater_sha256', 'controller_sha256')
    $actual = @($identity.PSObject.Properties.Name)
    if (@($fields | Where-Object { $_ -notin $actual }).Count -ne 0 -or
        @($actual | Where-Object { $_ -notin $fields }).Count -ne 0 -or
        [int]$identity.schema_version -ne 1 -or [int]$identity.controller_version -ne 7) {
        Stop-Workflow 'installed deployment identity response is incompatible'
    }
    $updater = Join-Path $RepositoryRoot 'tools\release\vps\deploy-test-update.sh'
    $controller = Join-Path $RepositoryRoot 'tools\release\vps\deploy-control.sh'
    $expectedUpdater = Get-FileSha256 $updater
    $expectedController = Get-FileSha256 $controller
    foreach ($field in @('updater_sha256', 'controller_sha256')) {
        if ([string]$identity.$field -notmatch '^[0-9a-f]{64}$') {
            Stop-Workflow "installed deployment identity has an unsafe $field"
        }
    }
    if ([string]$identity.updater_sha256 -ne $expectedUpdater -or
        [string]$identity.controller_sha256 -ne $expectedController) {
        Stop-Workflow ('installed deployment controller/updater differs from this exact candidate; ' +
            'install the source-controlled release controller before protected publication')
    }
    Set-StateValue $State 'installed_deployment_identity' $identity
    Write-State $State
    return "controller v$($identity.controller_version); exact updater/controller hashes"
}

function Assert-LiveProductionIntegrity {
    param([Parameter(Mandatory = $true)]$State)
    $response = Invoke-DeploymentController $State integrity @()
    if ([int]$response.exit_code -eq 0 -and $null -ne $response.payload) {
        $integrity = $response.payload
        $fields = @('schema_version', 'result', 'authoritative')
        $actual = @($integrity.PSObject.Properties.Name)
        if (@($fields | Where-Object { $_ -notin $actual }).Count -ne 0 -or
            @($actual | Where-Object { $_ -notin $fields }).Count -ne 0 -or
            [int]$integrity.schema_version -ne 1 -or
            [string]$integrity.result -ne 'pass' -or
            [bool]$integrity.authoritative -ne $false) {
            Stop-Workflow 'live production integrity preflight returned an unsafe response'
        }
        return 'active production readiness passed; fail-only signal, PREPARE remains authoritative'
    }
    if (-not [bool](Get-StateValue $State 'world_handoff_recovery_authorized' $false)) {
        Stop-Workflow ("live production integrity preflight failed before candidate PREPARE: {0}" -f
            ([string]$response.output).Trim())
    }
    $snapshot = Get-GenerationStatus
    if (-not $snapshot.generation -or
        [string]$snapshot.integration_test_sha -notmatch '^[0-9a-f]{40}$') {
        Stop-Workflow 'World handoff recovery requires one exact tagged integration generation'
    }
    $target = [string]$snapshot.integration_test_sha
    $recovery = Invoke-DeploymentController $State 'integrity-handoff' @($target)
    if ([int]$recovery.exit_code -ne 0 -or $null -eq $recovery.payload) {
        Stop-Workflow ("World handoff recovery preflight failed before candidate PREPARE: {0}" -f
            ([string]$recovery.output).Trim())
    }
    $integrity = $recovery.payload
    $fields = @(
        'schema_version', 'result', 'authoritative', 'target_game_sha',
        'current_public_game_sha', 'current_world_sha', 'target_world_sha',
        'active_world_sha'
    )
    $actual = @($integrity.PSObject.Properties.Name)
    if (@($fields | Where-Object { $_ -notin $actual }).Count -ne 0 -or
        @($actual | Where-Object { $_ -notin $fields }).Count -ne 0 -or
        [int]$integrity.schema_version -ne 1 -or
        [string]$integrity.result -ne 'recoverable-world-handoff' -or
        [bool]$integrity.authoritative -ne $false -or
        [string]$integrity.target_game_sha -ne $target -or
        [string]$integrity.target_world_sha -ne [string]$integrity.active_world_sha -or
        [string]$integrity.current_world_sha -eq [string]$integrity.active_world_sha) {
        Stop-Workflow 'World handoff recovery preflight returned an unsafe response'
    }
    $State.world_handoff_recovery_evidence = $integrity
    Write-State $State
    return "recoverable World handoff proven for $target"
}

if ($Mode -eq 'CoordinatedRelease' -and -not $OperationId) {
    $bootstrapPath = if ($CoordinatedManifestPath) { $CoordinatedManifestPath } else { $CoordinatedSeedPath }
    if ($bootstrapPath -and (Test-Path -LiteralPath ([IO.Path]::GetFullPath($bootstrapPath)) -PathType Leaf)) {
        $coordinatedSeed = Read-CoordinatedReleaseJson ([IO.Path]::GetFullPath($bootstrapPath))
        $OperationId = [string](Get-CoordinatedProperty $coordinatedSeed 'operation_id' '')
        if (-not $OperationId) { Stop-Workflow 'coordinated bootstrap seed has no operation ID' }
        $script:OperationId = $OperationId
    }
}
if ($Mode -eq 'Publish' -and $PSBoundParameters.ContainsKey('ExpectedGeneration')) {
    $initialPublishSnapshot = Get-GenerationStatus
    Assert-ExpectedPublishCandidate $initialPublishSnapshot 'initial preflight'
}
Resolve-AutomaticReleaseResume
if (-not $OperationId -and $Mode -ne 'Inspect') {
    $OperationId = "{0}-{1}" -f (Get-Date -Format 'yyyyMMddTHHmmss'),
        ([guid]::NewGuid().ToString('n').Substring(0, 8))
}

if ($Mode -eq 'Inspect') {
    $inspection = Get-WorkflowInspection (Read-State $OperationId)
    if ($Json) {
        $inspection | ConvertTo-Json -Depth 20 -Compress
    } else {
        Write-Host "Operation: $($inspection.state.operation_id)"
        Write-Host "Status: $(Get-StateValue $inspection.state 'status' 'unknown')"
        Write-Host "Schema: $(Get-StateValue $inspection.state 'schema_version' 'legacy (unversioned)')"
        Write-Host $inspection.inspection_source
        foreach ($issue in @($inspection.inspection_errors)) { Write-Host $issue }
        Write-Host "Current Git: $($inspection.current_git.integration_test_sha)"
        Write-Host "Failure phase: $(Get-StateValue $inspection.state 'failure_phase' '')"
        Write-Host "Side-effect reconciliation required: $(Get-StateValue $inspection.state 'side_effect_reconciliation_required' $false)"
        Write-Host "Receipt reconciliation required: $(Get-StateValue $inspection.state 'deployment_automatic_reconciliation_required' $false)"
    }
    return
}

try {
    Acquire-ReleaseLease $OperationId $Mode
    Assert-NoUnfinishedReleaseConflict $OperationId
    if ($Mode -eq 'RecoverIntegrationWorktree') {
        $state = Read-State $OperationId
        Initialize-DeploymentState $state
        $recovery = Invoke-IntegrationWorktreeRecovery $state
        if ($Json) {
            [pscustomobject]@{
                operation_id = [string]$state.operation_id
                recovery = $recovery
            } | ConvertTo-Json -Depth 8 -Compress
        } else {
            Write-Host "Recovered operation: $($state.operation_id)" -ForegroundColor Green
            Write-Host "Preserved candidate: $($recovery.candidate_sha)"
            Write-Host "Disposition: $($recovery.disposition)"
            Write-Host "Restored integration worktree: $($recovery.restored_integration_sha)"
            Write-Host "Local candidate ownership: $($recovery.local_candidate_ownership)"
        }
        return
    }
    if ($Mode -eq 'SupersedePublishedRelease') {
        $state = Read-State $OperationId
        Initialize-DeploymentState $state
        $supersession = Invoke-PublishedReleaseSupersession $state
        if ($Json) {
            $supersession | ConvertTo-Json -Depth 8 -Compress
        } else {
            Write-Host "Superseded operation: $($state.operation_id)" -ForegroundColor Green
            Write-Host "Retired release: test/$($supersession.generation)@$($supersession.target_sha)"
            Write-Host "Contained in master: $($supersession.superseded_by_sha)"
        }
        return
    }
    if ($Mode -eq 'ReconcileBatchCandidateIdentity') {
        $state = Read-State $OperationId
        Initialize-DeploymentState $state
        Set-ReleaseLeaseTiming $state
        $reconciliation = Invoke-BatchCandidateIdentityReconciliation $state
        if ($Json) {
            [pscustomobject]@{
                operation_id = [string]$state.operation_id
                reconciliation = $reconciliation
            } | ConvertTo-Json -Depth 12 -Compress
        } else {
            Write-Host "Reconciled operation: $($state.operation_id)" -ForegroundColor Green
            Write-Host "Repaired candidate: $($reconciliation.repaired_sha)"
            Write-Host "Resumable phase: $($reconciliation.resumable_phase)"
        }
        return
    }
    if ($Mode -eq 'Resume') {
        $state = Read-State $OperationId
        Initialize-DeploymentState $state
        if ($Mode -eq 'Resume' -and $PSBoundParameters.ContainsKey('AdmissionMode')) {
            $state.admission_mode = $AdmissionMode
        }
        if ($Mode -eq 'Resume' -and $PSBoundParameters.ContainsKey('AdmissionCommand')) {
            $state.admission_command = [string]$AdmissionCommand
            foreach ($feature in @($state.batch_manifest)) {
                $feature.admission_command = [string]$AdmissionCommand
            }
        }
        if ($Mode -eq 'Resume' -and $ConfirmWorldHandoffRecovery) {
            Set-StateValue $state 'world_handoff_recovery_authorized' $true
        }
        Set-ReleaseLeaseTiming $state
        Write-State $state
        $coordinatedOperation = [string](Get-StateValue $state 'requested_mode' '') -eq 'CoordinatedRelease'
        if ($coordinatedOperation) {
            if ($Mode -eq 'Resume' -and -not $ConfirmCoordinatedRelease) {
                Stop-Workflow 'resuming a coordinated release requires -ConfirmCoordinatedRelease'
            }
            Initialize-CoordinatedReleaseState $state | Out-Null
            $coordinatedGate = Get-CoordinatedReleaseGate $state.coordinated_manifest
            if ($ConfirmCoordinatedRelease) {
                $ApprovedIntegrationTest = $true
                $ConfirmPublish = $true
                $ConfirmDeploy = $true
            }
            Invoke-CoordinatedReleaseWorkflow $state | Out-Null
            if ($Json) {
                [pscustomobject]@{
                    state = (Get-RedactedWorkflowState $state)
                    coordinated_manifest = $state.coordinated_manifest
                    coordinated_gate = (Get-CoordinatedReleaseGate $state.coordinated_manifest)
                    journal = @($state.coordinated_journal)
                } | ConvertTo-Json -Depth 20 -Compress
            } else {
                Write-Host "Coordinated operation: $($state.operation_id)"
                Write-Host "Status: $($state.status)"
                Write-Host "Phase: $($state.coordinated_manifest.current_phase)"
                Write-Host "Gate: $($state.coordinated_wait_reason)"
            }
            return
        }
        if ([bool]$state.is_batch -and [bool]$state.batch_release_authorized) {
            $ConfirmIntegration = $true
            $ConfirmGenerationCheckpoint = $true
            $AtomicMasterPublication = $true
            $ApprovedIntegrationTest = $true
            $ConfirmPublish = $true
            $ConfirmDeploy = $true
        }
        Resolve-EffectiveBaseIdentity $state -ExistingState
        Assert-RecordedEffectiveBase $state
        $gitOnlyReconciliation = Test-GitOnlyReconciliationRequired $state
        $script:ActiveWorkflowDomain = if ($gitOnlyReconciliation) { 'git-only' } else { 'deployment' }
        $truth = Reconcile-RemoteTruth $state -GitOnly:$gitOnlyReconciliation

    } else {
        $state = New-WorkflowState
        Initialize-DeploymentState $state
        Set-ReleaseLeaseTiming $state
        if ($Mode -eq 'CoordinatedRelease') {
            Initialize-CoordinatedReleaseState $state | Out-Null
        } else {
            Resolve-EffectiveBaseIdentity $state
            Write-State $state
        }
    }

    $effectiveMode = if ($Mode -eq 'Resume') { [string]$state.requested_mode } else { $Mode }
    $script:ActiveWorkflowDomain = 'git-only'
    $batchMode = [bool](Get-StateValue $state 'is_batch' $false)
    if ($effectiveMode -in @('CoordinatedRelease', 'Coordinated') -and
        (Test-MobileReleasePaused $state)) {
        Stop-Workflow 'coordinated and mobile releases are paused in web-only release mode'
    }
    if ($effectiveMode -eq 'CoordinatedRelease') {
        Invoke-CoordinatedReleaseWorkflow $state | Out-Null
        if ($Json) {
            [pscustomobject]@{
                state = (Get-RedactedWorkflowState $state)
                coordinated_manifest = $state.coordinated_manifest
                coordinated_gate = (Get-CoordinatedReleaseGate $state.coordinated_manifest)
                journal = @($state.coordinated_journal)
            } | ConvertTo-Json -Depth 20 -Compress
        } else {
            Write-Host "Coordinated operation: $($state.operation_id)"
            Write-Host "Status: $($state.status)"
            Write-Host "Phase: $($state.coordinated_manifest.current_phase)"
            Write-Host "Gate: $($state.coordinated_wait_reason)"
        }
        return
    }
    if ($effectiveMode -in @('Integrate', 'IntegrateBatchAdmission', 'IntegrateAndPublish')) {
        if ($batchMode) {
            Invoke-BatchIntegrationWorkflow $state `
                -AdmissionOnly:($effectiveMode -eq 'IntegrateBatchAdmission')
        }
        else { Invoke-IntegrationWorkflow $state }
    }
    if ($effectiveMode -in @('Publish', 'IntegrateAndPublish')) {
        if (-not $batchMode) {
            Assert-DeploymentAuthorization
            Invoke-Phase $state 'live_production_integrity_preflight' {
                Assert-LiveProductionIntegrity $state
            } | Out-Null
            Invoke-Phase $state 'installed_deployment_identity_preflight' {
                Assert-InstalledDeploymentIdentity $state
            } | Out-Null
            Invoke-Phase $state 'prepare_candidate_on_vps' {
                $snapshot = Get-GenerationStatus
                if (-not $snapshot.generation) {
                    Stop-Workflow 'publication PREPARE requires an exact integration generation'
                }
                Assert-ExpectedPublishCandidate $snapshot 'PREPARE'
                $state.candidate_integration_sha = [string]$snapshot.integration_test_sha
                $state.new_generation = [string]$snapshot.generation
                Write-State $state
                Invoke-PrepareCandidate $state ([string]$state.candidate_integration_sha) `
                    ([string]$state.new_generation)
            } | Out-Null
            Invoke-MobileBackwardCompatibilityGate $state $IntegrationWorktree `
                ([string]$state.candidate_integration_sha) | Out-Null
            Invoke-PublishGitWorkflow $state
        }
        $script:ActiveWorkflowDomain = 'deployment'
        Invoke-DeploymentWorkflow $state
    }
    $state.status = 'completed'
    $state.completed_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    Write-State $state
    $timing = Write-TimingReports $state
    if ($Json) {
        [pscustomobject]@{
            state = (Get-RedactedWorkflowState $state)
            timing = $timing
        } | ConvertTo-Json -Depth 15 -Compress
    }
    else {
        if ($batchMode) {
            Write-Host 'Included features:'
            foreach ($feature in @($state.batch_manifest)) {
                Write-Host "  $($feature.branch)@$($feature.local_tip_sha)"
            }
            Write-Host "Final candidate: $($state.final_candidate_sha)"
            Write-Host "Gameplay tag: $($state.new_generation)"
            Write-Host "Reused validations: $($state.validations_reused)"
            Write-Host "Executed validations: $($state.validations_executed)"
            foreach ($receipt in @($state.validation_receipts)) {
                Write-Host "  $($receipt.name): $($receipt.duration_ms) ms"
            }
            Write-Host "Remote preflight fetch/snapshot: $($timing.initial_remote_git_fetch_count)/$($timing.initial_remote_git_snapshot_count)"
            Write-Host "Local merge duration: $($timing.batch_merge_duration_ms) ms"
            Write-Host "Atomic publication: $($state.atomic_push_result)"
            Write-Host "Atomic publication duration: $($state.atomic_publication_duration_ms) ms"
            Write-Host "Deployment operation: $($state.deployment_operation_id)"
            Write-Host "Deployment submission duration: $($state.deployment_submission_duration_ms) ms"
            Write-Host "Production identity: $($state.exact_deployed_sha)"
            Write-Host "Total release duration: $($timing.total_duration_ms) ms"
            Write-Host "Remaining known issues: $(@($state.remaining_known_issues) -join ' ')"
        } else {
            Write-Host "Workflow completed: $($state.operation_id)" -ForegroundColor Green
            Write-Host "Exact SHA: $($state.candidate_integration_sha)"
            Write-Host "Timing report: $(Join-Path $StateRoot "$($state.operation_id).timings.json")"
        }
    }
} catch {
    if ($null -ne (Get-Variable state -ErrorAction SilentlyContinue) -and $null -ne $state) {
        $gitOnlyFailure = $script:ActiveWorkflowDomain -eq 'git-only'
        try { Reconcile-RemoteTruth $state -GitOnly:$gitOnlyFailure | Out-Null } catch { }
        try { Write-TimingReports $state | Out-Null } catch { }
    }
    Write-Error $_.Exception.Message
    exit 1
} finally {
    Release-ReleaseLease $OperationId
}
