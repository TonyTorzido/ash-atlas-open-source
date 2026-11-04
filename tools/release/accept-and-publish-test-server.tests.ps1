Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptPath = Join-Path $PSScriptRoot 'accept-and-publish-test-server.ps1'
$scriptText = Get-Content -Raw -LiteralPath $scriptPath
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($scriptText, [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw "canonical coordinator parse failed: $($errors -join '; ')" }

function Stop-Workflow([string]$Message) { throw "STOP: $Message" }
function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
}
function Assert-Throws([scriptblock]$Action, [string]$Message) {
    $thrown = $false
    try { & $Action | Out-Null } catch { $thrown = $true }
    Assert-True $thrown $Message
}

foreach ($name in @(
        'Get-StateValue',
        'Assert-BatchAdmissionProtectedSnapshot',
        'Set-StateValue',
        'Get-FileSha256',
        'Test-ReleaseOperationPending',
        'Close-AbandonedReleaseOperation',
        'Get-UnfinishedReleaseOperations',
        'Get-ReleaseOperationFiles',
        'Assert-ExpectedPublishCandidate',
        'Assert-ExpectedPublishResumeCandidate'
    )) {
    $definitions = @($ast.FindAll({
            param($node)
            $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
        }, $true))
    Assert-True ($definitions.Count -eq 1) "canonical coordinator defines $name once"
    Invoke-Expression $definitions[0].Extent.Text
}

$workflowDefinition = @($ast.FindAll({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -eq 'Invoke-BatchIntegrationWorkflow'
    }, $true))[0]
$workflowText = $workflowDefinition.Extent.Text
$snapshotCall = $workflowText.IndexOf('Get-BatchRemoteSnapshot $State', [StringComparison]::Ordinal)
$tupleCall = $workflowText.IndexOf('Assert-BatchAdmissionProtectedSnapshot', [StringComparison]::Ordinal)
$candidateCall = $workflowText.IndexOf('Invoke-BatchMergeChain $State', [StringComparison]::Ordinal)
Assert-True ($snapshotCall -ge 0 -and $tupleCall -gt $snapshotCall -and
    $candidateCall -gt $tupleCall) `
    'protected tuple validation runs after one remote snapshot and before candidate merge work'

$sourceSha = 'a' * 40
$masterSha = 'b' * 40
$acceptedSha = 'c' * 40
$manifest = [pscustomobject]@{
    original_source_sha = $sourceSha
    original_master_sha = $masterSha
    reserved_generation = 't1251'
}
$state = [pscustomobject]@{
    original_integration_sha = ''
    original_master_sha = ''
    batch_admission_accepted = $false
    accepted_generation = ''
    accepted_integration_sha = ''
}
$reservedSnapshot = [pscustomobject]@{
    integration_test_sha = $sourceSha
    master_sha = $masterSha
    latest_generation = 't1250'
    generations = @()
}
Assert-BatchAdmissionProtectedSnapshot $manifest $reservedSnapshot $state -AdmissionOnly

$candidateStarted = $false
$advancedSnapshot = [pscustomobject]@{
    integration_test_sha = ('d' * 40)
    master_sha = ('e' * 40)
    latest_generation = 't1251'
    generations = @()
}
Assert-Throws {
    Assert-BatchAdmissionProtectedSnapshot $manifest $advancedSnapshot $state -AdmissionOnly
    $candidateStarted = $true
} 'a protected snapshot advanced after reservation is rejected before candidate work'
Assert-True (-not $candidateStarted) 'candidate work marker remains unset after preflight rejection'

$ExpectedGeneration = 't1255'
$ExpectedCandidateSha = 'c' * 40
$approvedPublishSnapshot = [pscustomobject]@{
    generation = 't1255'
    integration_test_sha = $ExpectedCandidateSha
}
Assert-ExpectedPublishCandidate $approvedPublishSnapshot 'initial preflight'
$advancedPublishSnapshot = [pscustomobject]@{
    generation = 't1256'
    integration_test_sha = ('d' * 40)
}
Assert-Throws {
    Assert-ExpectedPublishCandidate $advancedPublishSnapshot 'PREPARE'
} 'a candidate that advances after the Mac approval is rejected before PREPARE'
$generationOnlyChangedPublishSnapshot = [pscustomobject]@{
    generation = 't1256'
    integration_test_sha = $ExpectedCandidateSha
}
Assert-Throws {
    Assert-ExpectedPublishCandidate $generationOnlyChangedPublishSnapshot 'PREPARE'
} 'a generation change is rejected even if the integration SHA is unchanged'

$unfinishedPublishState = [pscustomobject]@{
    operation_id = 'publish-t1254'
    requested_mode = 'Publish'
    feature_worktree = ''
    feature_worktrees = @()
    new_generation = 't1254'
    candidate_integration_sha = ('b' * 40)
}
Assert-Throws {
    Assert-ExpectedPublishResumeCandidate $unfinishedPublishState 't1255' ('c' * 40)
} 'an unfinished Publish frozen to an older tuple cannot auto-resume under the newer Mac-approved tuple'
$matchingUnfinishedPublishState = [pscustomobject]@{
    operation_id = 'publish-t1255'
    requested_mode = 'Publish'
    feature_worktree = ''
    feature_worktrees = @()
    new_generation = 't1255'
    candidate_integration_sha = ('c' * 40)
}
Assert-ExpectedPublishResumeCandidate $matchingUnfinishedPublishState 't1255' ('c' * 40)

$resumeResolver = @($ast.FindAll({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -eq 'Resolve-AutomaticReleaseResume'
    }, $true))[0].Extent.Text
$explicitResumeGuard = $resumeResolver.IndexOf(
    "if (`$Mode -in @('Inspect', 'Resume') -or `$OperationId) { return }",
    [StringComparison]::Ordinal)
$tupleResumeGuard = $resumeResolver.IndexOf('if ($samePublish -and $ExpectedGeneration)',
    [StringComparison]::Ordinal)
$automaticResumeMutation = $resumeResolver.IndexOf("`$script:Mode = 'Resume'", [StringComparison]::Ordinal)
Assert-True ($explicitResumeGuard -ge 0 -and $explicitResumeGuard -lt $tupleResumeGuard -and
    $tupleResumeGuard -lt $automaticResumeMutation) `
    'tuple fencing applies only to automatic Publish resume and leaves explicit Resume unchanged'
$resolverDefinition = @($ast.FindAll({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -eq 'Resolve-AutomaticReleaseResume'
    }, $true))[0]
Invoke-Expression $resolverDefinition.Extent.Text
function Invoke-AutomaticReleaseResumeFixture {
    function Get-UnfinishedReleaseOperations { return @($script:UnfinishedReleaseFixture) }
    Resolve-AutomaticReleaseResume
}
$FeatureWorktree = ''
$FeatureWorktrees = @()
$FeatureBranches = @()
$FeatureTipShas = @()
$PlayerPatchNote = ''
$PlayerPatchNotes = @()
$PublishPatchNotes = $false
$ReleasePatchNotes = @()
$Json = $true
$script:ExpectedGeneration = 't1255'
$script:ExpectedCandidateSha = 'c' * 40
$script:Mode = 'Publish'
$script:OperationId = ''
$script:UnfinishedReleaseFixture = $unfinishedPublishState
Assert-Throws { Invoke-AutomaticReleaseResumeFixture } `
    'automatic Publish resume rejects a prior unfinished operation frozen to another accepted generation'
Assert-True ($script:Mode -ceq 'Publish' -and -not $script:OperationId) `
    'a mismatched unfinished Publish is not switched to Resume'
$script:Mode = 'Publish'
$script:UnfinishedReleaseFixture = $matchingUnfinishedPublishState
Invoke-AutomaticReleaseResumeFixture
Assert-True ($script:Mode -ceq 'Resume' -and $script:OperationId -ceq 'publish-t1255') `
    'an unfinished Publish resumes automatically when its frozen tuple matches the Mac approval'
$script:Mode = 'Resume'
$script:OperationId = 'publish-t1254'
$script:UnfinishedReleaseFixture = $unfinishedPublishState
Invoke-AutomaticReleaseResumeFixture
Assert-True ($script:Mode -ceq 'Resume' -and $script:OperationId -ceq 'publish-t1254') `
    'an explicit Resume remains pinned to its supplied operation ID'

$gameUpdateControllerText = Get-Content -Raw -LiteralPath (
    Join-Path $PSScriptRoot 'game-update-controller.ps1')
$coordinatedControllerText = Get-Content -Raw -LiteralPath (
    Join-Path $PSScriptRoot 'coordinated-release-controller.ps1')
$sharedLeaseRootDefault = "Join-Path `$env:LOCALAPPDATA 'AshAtlas\Ash Atlas Release Coordination'"
Assert-True (-not $gameUpdateControllerText.Contains('-ReleaseCoordinationRoot') -and
    -not $coordinatedControllerText.Contains('-ReleaseCoordinationRoot') -and
    $scriptText.Contains($sharedLeaseRootDefault)) `
    'Game Update and coordinated mobile release use the canonical shared release lease/queue root'

$initialCandidateCheck = $scriptText.IndexOf(
    "Assert-ExpectedPublishCandidate `$initialPublishSnapshot 'initial preflight'",
    [StringComparison]::Ordinal)
$automaticResumeMatch = [regex]::Match($scriptText, '(?m)^Resolve-AutomaticReleaseResume\s*$')
$automaticResume = if ($automaticResumeMatch.Success) { $automaticResumeMatch.Index } else { -1 }
$leaseAcquisition = $scriptText.IndexOf('Acquire-ReleaseLease $OperationId $Mode', [StringComparison]::Ordinal)
Assert-True ($initialCandidateCheck -ge 0 -and $initialCandidateCheck -lt $automaticResume -and
    $initialCandidateCheck -lt $leaseAcquisition) `
    'the approved tuple is checked before release-side effects or automatic resume'
$prepareCandidateCheck = $scriptText.IndexOf("Assert-ExpectedPublishCandidate `$snapshot 'PREPARE'",
    [StringComparison]::Ordinal)
$prepareCandidateStart = $scriptText.IndexOf('Invoke-PrepareCandidate $state', $prepareCandidateCheck,
    [StringComparison]::Ordinal)
Assert-True ($prepareCandidateCheck -ge 0 -and $prepareCandidateStart -gt $prepareCandidateCheck) `
    'the approved tuple is checked again before the VPS PREPARE call'

$advancedGenerationOnly = [pscustomobject]@{
    integration_test_sha = $sourceSha
    master_sha = $masterSha
    latest_generation = 't1251'
    generations = @()
}
Assert-Throws {
    Assert-BatchAdmissionProtectedSnapshot $manifest $advancedGenerationOnly $state -AdmissionOnly
} 'a generation namespace advance is rejected even when protected branch SHAs are unchanged'

$staleState = [pscustomobject]@{
    original_integration_sha = $sourceSha
    original_master_sha = $masterSha
    previous_generation = 't1251'
    final_candidate_sha = ('d' * 40)
    batch_admission_accepted = $false
    accepted_generation = ''
    accepted_integration_sha = ''
    phases = [pscustomobject]@{
        batch_local_merge_chain = [pscustomobject]@{ status = 'completed' }
    }
}
Assert-Throws {
    Assert-BatchAdmissionProtectedSnapshot $manifest $advancedGenerationOnly $staleState -AdmissionOnly
} 'a stale t1251 state cannot reuse a t1251 reservation to derive t1252'

$crashRecoveryState = [pscustomobject]@{
    original_integration_sha = $sourceSha
    original_master_sha = $masterSha
    previous_generation = 't1250'
    final_candidate_sha = $acceptedSha
    batch_admission_accepted = $false
    accepted_generation = ''
    accepted_integration_sha = ''
    phases = [pscustomobject]@{
        batch_local_merge_chain = [pscustomobject]@{ status = 'completed' }
    }
}
$crashRecoverySnapshot = [pscustomobject]@{
    integration_test_sha = $acceptedSha
    master_sha = $masterSha
    latest_generation = 't1251'
    generations = @(
        [pscustomobject]@{ name = 'test/t1251'; commit_sha = $acceptedSha }
    )
}
Assert-BatchAdmissionProtectedSnapshot $manifest $crashRecoverySnapshot $crashRecoveryState -AdmissionOnly

$acceptedState = [pscustomobject]@{
    original_integration_sha = $sourceSha
    original_master_sha = $masterSha
    batch_admission_accepted = $true
    accepted_generation = 't1251'
    accepted_integration_sha = $acceptedSha
}
$acceptedSnapshot = [pscustomobject]@{
    integration_test_sha = $acceptedSha
    master_sha = $masterSha
    latest_generation = 't1251'
    generations = @(
        [pscustomobject]@{ name = 'test/t1251'; commit_sha = $acceptedSha }
    )
}
Assert-BatchAdmissionProtectedSnapshot $manifest $acceptedSnapshot $acceptedState -AdmissionOnly

$abandonRoot = Join-Path $env:TEMP ('ash-atlas-abandon-' + [guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Path $abandonRoot -Force | Out-Null
try {
    $StateRoot = Join-Path $abandonRoot 'state'
    $StateRootWasSpecified = $true
    $ReleaseCoordinationRoot = Join-Path $abandonRoot 'coordination'
    New-Item -ItemType Directory -Path $StateRoot -Force | Out-Null
    function Write-AbandonFixture($State) {
        $State | ConvertTo-Json -Depth 14 | Set-Content -LiteralPath (Join-Path $StateRoot "$($State.operation_id).json") -Encoding utf8
    }
    $recent = [DateTimeOffset]::UtcNow.AddHours(-1).ToString('o')
    $stale = [DateTimeOffset]::UtcNow.AddHours(-25).ToString('o')
    Write-AbandonFixture ([pscustomobject]@{ operation_id = 'recent-running'; status = 'running:deployment'; updated_at_utc = $recent })
    Write-AbandonFixture ([pscustomobject]@{ operation_id = 'recent-side-effect'; status = 'failed'; updated_at_utc = $recent; side_effect_reconciliation_required = $true })
    Write-AbandonFixture ([pscustomobject]@{ operation_id = 'stale-running'; status = 'running:batch_local_merge_chain'; updated_at_utc = $stale })
    Write-AbandonFixture ([pscustomobject]@{ operation_id = 'stale-activation'; status = 'failed'; updated_at_utc = $stale
        activation_intent = [pscustomobject]@{ intentId = 'x' }; activation_intent_resolved = $false })
    Write-AbandonFixture ([pscustomobject]@{ operation_id = 'completed'; status = 'completed'; updated_at_utc = $recent })
    Write-AbandonFixture ([pscustomobject]@{ operation_id = 'failed-clean'; status = 'failed'; updated_at_utc = $recent })
    # An old release touched recently (inspection or cleanup) is still old.
    Write-AbandonFixture ([pscustomobject]@{ operation_id = 'old-touched-today'; status = 'completed'
        created_at_utc = [DateTimeOffset]::UtcNow.AddDays(-9).ToString('o'); updated_at_utc = $recent
        deployment_automatic_reconciliation_required = $true })
    # The operation being resumed is never abandoned underneath itself.
    $OperationId = 'old-being-resumed'
    Write-AbandonFixture ([pscustomobject]@{ operation_id = 'old-being-resumed'; status = 'failed'
        created_at_utc = [DateTimeOffset]::UtcNow.AddDays(-2).ToString('o'); updated_at_utc = $recent
        deployment_automatic_reconciliation_required = $true })

    $blocking = @(Get-UnfinishedReleaseOperations | ForEach-Object { [string]$_.operation_id } | Sort-Object)
    Assert-True (($blocking -join ',') -ceq 'old-being-resumed,recent-running,recent-side-effect') `
        'only unfinished work from the last 24 hours, or the operation being resumed, remains unfinished'
    $oldTouched = Get-Content -Raw -LiteralPath (Join-Path $StateRoot 'old-touched-today.json') | ConvertFrom-Json
    Assert-True ([string]$oldTouched.abandoned_at_utc -and [string]$oldTouched.status -ceq 'completed') `
        'age counts from creation, so an old release touched today is auto-abandoned'
    $OperationId = ''
    $staleRunning = Get-Content -Raw -LiteralPath (Join-Path $StateRoot 'stale-running.json') | ConvertFrom-Json
    $staleActivation = Get-Content -Raw -LiteralPath (Join-Path $StateRoot 'stale-activation.json') | ConvertFrom-Json
    Assert-True ([string]$staleRunning.status -ceq 'abandoned' -and
        [string]$staleRunning.abandoned_previous_status -ceq 'running:batch_local_merge_chain' -and
        [string]$staleRunning.abandoned_at_utc) 'a stale running record is marked abandoned, not deleted'
    Assert-True ([string]$staleActivation.status -ceq 'failed' -and [string]$staleActivation.abandoned_at_utc -and
        $null -ne $staleActivation.activation_intent) 'a stale terminal record keeps its status and evidence'
    $audit = @(Get-Content -LiteralPath (Join-Path $ReleaseCoordinationRoot 'release-audit.jsonl') |
        ForEach-Object { $_ | ConvertFrom-Json })
    Assert-True ($audit.Count -eq 3 -and @($audit | Where-Object {
            $_.event -ceq 'release_operation_auto_abandoned' -and $_.record_sha256_before -match '^[0-9a-f]{64}$'
        }).Count -eq 3) 'each auto-abandon appends one audit entry with the prior record hash'
    $again = @(Get-UnfinishedReleaseOperations)
    Assert-True ($again.Count -eq 2 -and
        @(Get-Content -LiteralPath (Join-Path $ReleaseCoordinationRoot 'release-audit.jsonl')).Count -eq 4) `
        'abandoned records never block again; only the no-longer-resumed stale operation is newly audited'
    Assert-True (@(Get-ChildItem -LiteralPath $StateRoot -Filter '*.json').Count -eq 8) 'no release history is deleted'
} finally {
    Remove-Item -LiteralPath $abandonRoot -Recurse -Force
}

$deployBlock = $scriptText.Substring($scriptText.IndexOf("if (`$Mode -eq 'Deploy') {", [StringComparison]::Ordinal))
Assert-True ($deployBlock.IndexOf('Assert-TrustedToolingCopy', [StringComparison]::Ordinal) -lt
    $deployBlock.IndexOf("`$Mode = 'IntegrateAndPublish'", [StringComparison]::Ordinal) -and
    $deployBlock.IndexOf('-not $CarefulLane', [StringComparison]::Ordinal) -lt
    $deployBlock.IndexOf("`$Mode = 'IntegrateAndPublish'", [StringComparison]::Ordinal)) `
    'Deploy checks the trusted tooling copy and the careful lane before any release work'
$patternMatch = [regex]::Match($scriptText, "(?s)\`$CarefulLanePathPattern = (.+?)\r?\n\r?\n")
$CarefulLanePathPattern = Invoke-Expression $patternMatch.Groups[1].Value
foreach ($path in @('db/migrations/0101_x.sql', 'tools/release/vps/deploy-test-update.sh', 'ios/App/Info.plist',
        'capacitor.config.ts', 'config/protocol-versions.json', '.github/workflows/a.yml')) {
    Assert-True ($path -match $CarefulLanePathPattern) "careful lane includes $path"
}
foreach ($path in @('apps/client/src/ui/Watermark.tsx', 'apps/server/src/index.ts', 'packages/shared/src/protocol.ts',
        'apps/client/public/art/tree.png', 'docs/notes.md', 'package.json')) {
    Assert-True ($path -notmatch $CarefulLanePathPattern) "fast lane includes $path"
}

Write-Output 'accept-and-publish-test-server.tests.ps1: focused checks passed'
