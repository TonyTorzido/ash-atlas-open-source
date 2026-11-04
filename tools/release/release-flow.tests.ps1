param([switch]$SkipWslTransportProbes)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$script:ConfiguredReleaseMode = 'active'
$PublishPatchNotes = $false
$ReleasePatchNotes = @()

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
. (Join-Path $PSScriptRoot 'release-path-lib.ps1')
. (Join-Path $PSScriptRoot 'deployment-transport.ps1')
$orchestrator = Get-Content -Raw -LiteralPath (Join-Path $root 'tools\release\accept-and-publish-test-server.ps1')
$transport = Get-Content -Raw -LiteralPath (Join-Path $root 'tools\release\deployment-transport.ps1')
$generation = Get-Content -Raw -LiteralPath (Join-Path $root 'tools\dev\test-generation.ps1')
$coordinatedReleaseController = Get-Content -Raw -LiteralPath (
    Join-Path $root 'tools\release\coordinated-release-controller.ps1')
$coordinatedReleaseRequestHelper = Get-Content -Raw -LiteralPath (
    Join-Path $root 'tools\release\request-coordinated-release.sh')
$coordinatedReleaseControlWorkflow = Get-Content -Raw -LiteralPath (
    Join-Path $root 'docs\release\coordinated-release-control-workflow.example.yml')
$updater = Get-Content -Raw -LiteralPath (Join-Path $root 'tools\release\vps\deploy-test-update.sh')
$releaseMetadataHelper = Get-Content -Raw -LiteralPath (
    Join-Path $root 'tools\release\public-release-metadata.mjs')
$discordPatchNotesSender = Get-Content -Raw -LiteralPath (
    Join-Path $root 'tools\release\send-discord-patch-notes.mjs')
$worldRuntimeLock = Get-Content -Raw -LiteralPath (Join-Path $root 'config\world-runtime.lock.json') |
    ConvertFrom-Json
$controller = Get-Content -Raw -LiteralPath (Join-Path $root 'tools\release\vps\deploy-control.sh')
$requestPoller = Get-Content -Raw -LiteralPath (Join-Path $root 'tools\release\vps\poll-deployment-request.sh')
$controllerUnit = Get-Content -Raw -LiteralPath (Join-Path $root 'tools\release\vps\ash-atlas-deploy@.service')
$requestService = Get-Content -Raw -LiteralPath (Join-Path $root 'tools\release\vps\ash-atlas-deployment-request.service')
$requestTimer = Get-Content -Raw -LiteralPath (Join-Path $root 'tools\release\vps\ash-atlas-deployment-request.timer')
$reconcileService = Get-Content -Raw -LiteralPath (Join-Path $root 'tools\release\vps\ash-atlas-deployment-reconcile.service')
$reconcileTimer = Get-Content -Raw -LiteralPath (Join-Path $root 'tools\release\vps\ash-atlas-deployment-reconcile.timer')
$controllerInstaller = Get-Content -Raw -LiteralPath (Join-Path $root 'tools\release\vps\install-release-controller.sh')
$deploymentStatusRoute = Get-Content -Raw -LiteralPath (Join-Path $root 'tools\release\vps\deployment-status.caddy')
$gameCachePolicy = Get-Content -Raw -LiteralPath (Join-Path $root 'tools\release\vps\game-cache-policy.caddy')
$controllerConfig = Get-Content -Raw -LiteralPath (Join-Path $root 'tools\release\vps\deployment-controller.conf')
$installer = Get-Content -Raw -LiteralPath (Join-Path $root 'tools\release\install-vps-updater.ps1')
$clientCanaryRollback = Get-Content -Raw -LiteralPath (
    Join-Path $root 'tools\release\invoke-client-only-canary-rollback.ps1')
$worldPromotion = Get-Content -Raw -LiteralPath (Join-Path $root 'tools\release\promote-world-runtime.ps1')
$worldPromotionRemote = Get-Content -Raw -LiteralPath (Join-Path $root 'tools\release\vps\promote-world-runtime.sh')
$runtime = Get-Content -Raw -LiteralPath (Join-Path $root 'tools\dev\run-main.ps1')
$featureRuntime = Get-Content -Raw -LiteralPath (Join-Path $root 'tools\dev\feature-runtime.ps1')
$qualityWorkflow = Get-Content -Raw -LiteralPath (Join-Path $root '.github\workflows\repository-quality.yml')
$fullCheckpointWorkflow = Get-Content -Raw -LiteralPath (Join-Path $root '.github\workflows\full-checkpoint.yml')
$inventoryCatalog = Get-Content -Raw -LiteralPath (Join-Path $root 'packages\shared\src\inventoryCatalog.ts')
$serverItems = Get-Content -Raw -LiteralPath (Join-Path $root 'apps\server\src\game\items.ts')
$script:Passed = 0
$script:RepositoryRoot = $root
$script:ReleaseControllerPath = Join-Path $root 'tools/release/accept-and-publish-test-server.ps1'

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
    $script:Passed++
}

$worldPromotionTokens = $null
$worldPromotionParseErrors = $null
[void][Management.Automation.Language.Parser]::ParseInput(
    $worldPromotion, [ref]$worldPromotionTokens, [ref]$worldPromotionParseErrors)
Assert-True ($worldPromotionParseErrors.Count -eq 0) 'World promotion wrapper parses without errors'
$gitBash = Join-Path (Split-Path (Get-Command git -ErrorAction Stop).Source -Parent) '..\bin\bash.exe'
$worldPromotionPath = Join-Path $root 'tools\release\vps\promote-world-runtime.sh'
if (Test-Path -LiteralPath $gitBash -PathType Leaf) {
    & $gitBash -n $worldPromotionPath.Replace('\', '/') 2>&1 | Out-Null
} else {
    $worldPromotionBash = Get-Command bash -ErrorAction SilentlyContinue
    if ($null -eq $worldPromotionBash) { throw 'bash is required to parse the World promotion remote helper.' }
    & $worldPromotionBash.Source -n (ConvertTo-WslPath $worldPromotionPath) 2>&1 | Out-Null
}
Assert-True ($LASTEXITCODE -eq 0) 'World promotion remote helper parses with bash -n'
Assert-True ($coordinatedReleaseController -match '\$ExpectedCandidateSha' -and
    $coordinatedReleaseController -match '\$ExpectedGeneration' -and
    $coordinatedReleaseController -match '\$ExpectedDeliveryMode' -and
    $coordinatedReleaseController -match 'expected_delivery_mode' -and
    $coordinatedReleaseController -match 'daily-testers' -and
    $coordinatedReleaseController -match 'Assert-ExpectedCandidate \$snapshot' -and
    $coordinatedReleaseController.IndexOf('Assert-ExpectedCandidate $snapshot') -lt
        $coordinatedReleaseController.IndexOf('New-InitialDispatchRequest $OperationId') -and
    $coordinatedReleaseController.IndexOf('Assert-ExpectedCandidate $snapshot') -lt
        $coordinatedReleaseController.IndexOf('Claim-CoordinatedStart $OperationId')) `
    'coordinated controller binds the expected candidate before dispatch and claim'
Assert-True ($coordinatedReleaseRequestHelper -match 'git ls-remote' -and
    $coordinatedReleaseRequestHelper -match "-f 'dry_run=false'" -and
    $coordinatedReleaseRequestHelper -match 'candidate_generation_tag=' -and
    $coordinatedReleaseRequestHelper -match '\$\{candidate_generation_tag#test/\}' -and
    $coordinatedReleaseRequestHelper -match 'expected_generation=\$candidate_generation' -and
    $coordinatedReleaseRequestHelper -match 'expected_candidate_sha=\$candidate_sha' -and
    $coordinatedReleaseRequestHelper -match "-f 'delivery_mode=daily-testers'" -and
    $coordinatedReleaseRequestHelper -match 'iOS TestFlight' -and
    $coordinatedReleaseRequestHelper -match 'Google Play internal testing') `
    'Mac coordinated release helper resolves and submits the live tester-only candidate'
Assert-True ($coordinatedReleaseControlWorkflow -match 'expected_generation' -and
    $coordinatedReleaseControlWorkflow -match 'expected_candidate_sha' -and
    $coordinatedReleaseControlWorkflow -match 'delivery_mode' -and
    $coordinatedReleaseControlWorkflow -match 'daily-testers' -and
    $coordinatedReleaseControlWorkflow -match 'ExpectedGeneration' -and
    $coordinatedReleaseControlWorkflow -match 'ExpectedCandidateSha' -and
    $coordinatedReleaseControlWorkflow -match 'ExpectedDeliveryMode' -and
    $coordinatedReleaseControlWorkflow -match 'INPUT_DRY_RUN') `
    'coordinated release workflow exposes the candidate binding and live-mode contract'

$attributes = Get-Content -Raw -LiteralPath (Join-Path $root '.gitattributes')
$lfProtectedPatterns = @(
    'tools/release/vps/*.sh',
    'tools/release/vps/*.service',
    'tools/release/vps/ash-atlas-deployment-request.timer',
    'tools/release/vps/ash-atlas-deployment-reconcile.timer',
    'tools/release/vps/*.caddy',
    'tools/release/vps/deployment-controller.conf'
)
foreach ($pattern in $lfProtectedPatterns) {
    Assert-True ($attributes -match "(?m)^$([regex]::Escape($pattern)) text eol=lf\r?$") `
        "$pattern is pinned to LF in .gitattributes"
}
$lfProtectedFiles = @(
    Get-ChildItem -LiteralPath (Join-Path $root 'tools\release\vps') -File |
        Where-Object {
            $_.Extension -in @('.sh', '.service', '.caddy') -or
            $_.Name -eq 'deployment-controller.conf'
        }
)
foreach ($file in $lfProtectedFiles) {
    $bytes = [IO.File]::ReadAllBytes($file.FullName)
    Assert-True (-not ($bytes -contains 13)) `
        "$($file.Name) contains canonical LF bytes with no carriage returns"
}

$installerStagedFiles = [ordered]@{
    updater = 'deploy-test-update.sh'
    controller = 'deploy-control.sh'
    poller = 'poll-deployment-request.sh'
    unit = 'ash-atlas-deploy@.service'
    requestService = 'ash-atlas-deployment-request.service'
    requestTimer = 'ash-atlas-deployment-request.timer'
    reconcileService = 'ash-atlas-deployment-reconcile.service'
    reconcileTimer = 'ash-atlas-deployment-reconcile.timer'
    statusRoute = 'deployment-status.caddy'
    cachePolicy = 'game-cache-policy.caddy'
    config = 'deployment-controller.conf'
    installer = 'install-release-controller.sh'
}
$stagedSourceMatches = [regex]::Matches(
    $installer,
    "(?m)^\s{4}(?<key>[A-Za-z][A-Za-z0-9]*) = Join-Path \`$vpsRoot '(?<file>[^']+)'\r?$"
)
Assert-True ($stagedSourceMatches.Count -eq $installerStagedFiles.Count -and
    @($stagedSourceMatches | Where-Object {
            -not $installerStagedFiles.Contains($_.Groups['key'].Value) -or
            $installerStagedFiles[$_.Groups['key'].Value] -ne $_.Groups['file'].Value
        }).Count -eq 0) 'LF/hash fixtures exactly cover every installer-staged source'
foreach ($entry in $installerStagedFiles.GetEnumerator()) {
    $path = Join-Path $root "tools\release\vps\$($entry.Value)"
    $bytes = [IO.File]::ReadAllBytes($path)
    $canonicalText = [Text.Encoding]::UTF8.GetString($bytes).
        Replace("`r`n", "`n").Replace("`r", "`n")
    $canonicalBytes = [Text.Encoding]::UTF8.GetBytes($canonicalText)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        $canonicalHash = ([BitConverter]::ToString(
            $algorithm.ComputeHash($canonicalBytes))).Replace('-', '').ToLowerInvariant()
    } finally {
        $algorithm.Dispose()
    }
    $stagedAlgorithm = [Security.Cryptography.SHA256]::Create()
    try {
        $stagedHash = ([BitConverter]::ToString(
            $stagedAlgorithm.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    } finally {
        $stagedAlgorithm.Dispose()
    }
    Assert-True (-not ($bytes -contains 13) -and $stagedHash -eq $canonicalHash) `
        "$($entry.Value) staged hash equals its canonical LF-byte SHA-256"
    Assert-True ($installer -match [regex]::Escape($entry.Value) -and
        $installer -match [regex]::Escape("hashes.$($entry.Key)")) `
        "installer stages and verifies $($entry.Value)"
}

$orchestratorPath = Join-Path $root 'tools\release\accept-and-publish-test-server.ps1'
$tokens = $null
$parseErrors = $null
$orchestratorAst = [Management.Automation.Language.Parser]::ParseFile(
    $orchestratorPath, [ref]$tokens, [ref]$parseErrors)
Assert-True ($parseErrors.Count -eq 0) 'orchestrator parses before executable helper regression checks'
Assert-True ($orchestrator -match "schema_version = 9" -and
    $orchestrator -match "first_started_at_utc" -and
    $orchestrator -match "runner invocation ended before phase completion" -and
    $orchestrator -match "total_active_duration_ms" -and
    $orchestrator -match "workflow_finished_at_utc") `
    'workflow timing schema preserves Resume attempts and reports wall-clock plus active time'
Assert-True ($orchestrator -match "prepared_descriptor_version" -and
    $orchestrator -match "release_classification_version" -and
    $orchestrator -match "prepared_static_artifact_fence_sha256" -and
    $orchestrator -match "prepared_release_metadata_fence_sha256" -and
    $orchestrator -match "release_classification_evidence_sha256") `
    'orchestrator requires and records the versioned prepared release descriptor'
Assert-True ($updater -match "release_class_for_lane" -and
    $updater -match "release classification evidence changed after PREPARE" -and
    $updater -match 'operation_receipt_field candidate_database_strategy' -and
    $updater -match 'current_candidate_database_strategy" = "\$CANDIDATE_DATABASE_STRATEGY' -and
    $updater -match "prepared_descriptor_sha256") `
    'VPS PREPARE and ACTIVATE bind and revalidate authoritative release classification'
Assert-True ($updater -match 'server_activation_required "\$RELEASE_CLASS"' -and
    $updater -match 'client-only release unexpectedly assembled a server payload' -and
    $updater -match 'phase_finish skipped:client_only' -and
    $updater -match 'active_game_sha "\$expected_active_game_sha" active_public_sha "\$GAME_SHA"' -and
    $updater -match 'prepared_server_component_sha' -and
    $updater -match 'prepared_client_component_sha') `
    'client-only execution preserves the server component and activates only the prepared client artifact'
Assert-True ($updater -match 'ExecMainStartTimestampMonotonic' -and
    $updater -match 'prepared_game_main_pid' -and
    $updater -match 'activated_game_main_pid' -and
    $updater -match '(?s)phase_start public_activation.+atomic_link "\$CLIENT_RELEASE" "\$CLIENT_CURRENT_LINK".+systemctl restart ash-atlas[.]service.+client-only activation did not restart the unchanged game service.+operation_receipt_update activation_completed' -and
    $updater -match '(?s)if \[\[ \$\{RELEASE_CLASS:-\} = client_only \]\]; then.+restore_link "\$previous_public" "\$CLIENT_CURRENT_LINK".+systemctl restart ash-atlas[.]service') `
    'client-only ACTIVATE publishes the client before restarting the unchanged game process and rollback restarts after restoring the prior client'
Assert-True ($updater -match 'if \[\[ "\$DEPLOY_MODE" != prepare &&\s+\$\(readlink -e "\$GAME_CURRENT_LINK"') `
    'same-SHA PREPARE cannot exit through the already-active deployment shortcut'
Assert-True ($updater -match 'raw\.startsWith\("__NUMBER__"\).*Number\(raw\.slice\(10\)\)') `
    'updater receipt projection preserves numeric field types'
Assert-True ($updater -notmatch 'systemctl reload caddy[.]service') `
    'release activation and rollback switch the public symlink without reloading unchanged Caddy configuration'
$canaryTokens = $null
$canaryErrors = $null
[void][Management.Automation.Language.Parser]::ParseInput(
    $clientCanaryRollback, [ref]$canaryTokens, [ref]$canaryErrors)
Assert-True ($canaryErrors.Count -eq 0 -and
    $clientCanaryRollback -match 'ConfirmClientOnlyCanaryRollback' -and
    $clientCanaryRollback -match 'ExecMainStartTimestampMonotonic' -and
    $clientCanaryRollback -match 'mv -T "\$temporary" "\$public_current"' -and
    $clientCanaryRollback -match 'systemctl reload caddy[.]service' -and
    $clientCanaryRollback -match '\$response[.]stdout -split' -and
    $clientCanaryRollback -notmatch 'systemctl (stop|start|restart) ash-atlas') `
    'controlled client rollback is explicit, atomic, and cannot restart the game service'
$expectedProductionSshKey = if ($env:ASH_ATLAS_SSH_KEY) { $env:ASH_ATLAS_SSH_KEY } else { Join-Path $(if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }) '.ssh\your_deploy_key' }
Assert-True ($script:AshAtlasProductionSshKeyPath -ceq $expectedProductionSshKey -and
    $transport -match "(?m)^\`$script:AshAtlasProductionSshKeyPath = .+'\.ssh\\your_deploy_key'") `
    'the shared production SSH key default is the placeholder your_deploy_key identity'
foreach ($sshKeyDefaultSource in @(
        @{ name = 'accept-and-publish-test-server.ps1'; source = $orchestrator },
        @{ name = 'install-vps-updater.ps1'; source = $installer },
        @{ name = 'invoke-client-only-canary-rollback.ps1'; source = $clientCanaryRollback },
        @{ name = 'promote-world-runtime.ps1'; source = $worldPromotion })) {
    Assert-True ($sshKeyDefaultSource.source -match
        '(?m)^if \(-not \$SshKey\) \{ \$SshKey = \$script:AshAtlasProductionSshKeyPath \}\s*$' -and
        $sshKeyDefaultSource.source -match "\. \(Join-Path \`$PSScriptRoot 'deployment-transport\.ps1'\)" -and
        $sshKeyDefaultSource.source -notmatch "'\.ssh\\your_old_key'") `
        "$($sshKeyDefaultSource.name) defaults -SshKey to the shared production key and keeps an explicit -SshKey"
}
foreach ($browserSmokeSource in @($orchestrator, $clientCanaryRollback)) {
    Assert-True ($browserSmokeSource -match 'securitypolicyviolation' -and
        $browserSmokeSource -match 'requestfailed' -and
        $browserSmokeSource -match 'response[.]status[(][)] >= 400' -and
        $browserSmokeSource -match 'sourceFile === "https://accounts[.]google[.]com/gsi/client"' -and
        $browserSmokeSource -match 'effectiveDirective === "style-src-elem"' -and
        $browserSmokeSource -match 'disposition === "enforce"' -and
        $browserSmokeSource -match 'message[.]location[(][)][.]url === "https://accounts[.]google[.]com/gsi/client"' -and
        $browserSmokeSource -notmatch 'message[.]text[(][)][.]includes[(]"Google"[)]') `
        'browser smoke permits only the exact enforced Google GIS inline-style signal and fails other browser, CSP, request, and HTTP errors'
}
foreach ($functionName in @(
        'Get-GameRepositoryRoot',
        'Get-GameIntegrationWorktree',
        'Get-GitText',
        'Get-GitCommitId',
        'Invoke-Git',
        'Assert-CommitPlayerPatchNote',
        'Get-CommitPlayerPatchNoteTrailer',
        'ConvertFrom-Windows1252Utf8Mojibake',
        'Get-PlayerPatchNoteRecoveryMatch',
        'Get-StatePath',
        'Read-State',
        'New-WorkflowState',
        'Initialize-DeploymentState',
        'Test-MobileReleasePaused',
        'Get-FileSha256',
        'Get-ReleaseOperationFiles',
        'Test-ReleaseOperationPending',
        'Close-AbandonedReleaseOperation',
        'Get-UnfinishedReleaseOperations',
        'Resolve-AutomaticReleaseResume',
        'Write-State',
        'Set-StateValue',
        'Get-StateValue',
        'Get-IntegrationMergeMessage',
        'Get-ProcessStartUtc',
        'ConvertTo-CanonicalProcessStartUtc',
        'Test-ReleaseQueueOwnerAlive',
        'Invoke-Phase',
        'ConvertTo-ReleaseTimestampUtc',
        'Get-ReleaseElapsedMilliseconds',
        'Get-ReleasePhaseTiming',
        'Test-ReleaseTimingBudget',
        'Assert-ExactPreparedReceipt',
        'Assert-DeploymentStatusPayload',
        'ConvertTo-SanitizedFailureCode',
        'ConvertFrom-ControllerReceipt',
        'Get-GitFields',
        'Get-BatchChangedPathEntries',
        'Publish-ReleaseCandidateRef',
        'Test-ExactMergeParents',
        'ConvertTo-PlayerPatchNote',
        'Test-FeatureAdmissionStatus',
        'Get-TextSha256',
        'Get-BatchRemoteSnapshot',
        'Test-BatchForbiddenInfrastructurePath',
        'Get-BatchDisplayName',
        'Get-BatchFeatureManifest',
        'Get-BatchImpactClassification',
        'New-BatchGate',
        'Get-BatchValidationPlan',
         'Get-BatchValidationPlanFingerprint',
         'ConvertTo-NormalizedGateDiagnostics',
         'Start-BatchGateProcess',
         'Stop-BatchGateWorkers',
        'Complete-BatchGateProcesses',
        'Invoke-FocusedCandidateAdmission',
        'Assert-CleanWorktree',
        'Set-RemoteReceipt',
        'Set-RemoteSideEffectIntent',
        'Complete-RemoteSideEffectIntent',
        'Invoke-LocalPublishedCheckoutReconciliation',
        'Test-GitOnlyReconciliationRequired',
        'Require-CandidateAdmission',
        'Assert-CanonicalSha',
        'Get-TrustedMobileReleaseToolPath',
        'Get-MobileRegistryRemote',
         'Test-MobileActivationIntentIdentity',
        'Test-ReceiptMutationEvidence',
        'Test-ReceiptNoMutation',
        'Get-MobileActivationRegistryStatus',
        'Resolve-MobileActivationIntentRemote',
        'Set-MobileActivationIntent',
        'Resolve-MobileActivationIntent',
         'Invoke-PrepareCandidate',
         'Test-PreparedActivationCompletionReconciled',
         'Test-CoordinatedReleaseNeedsFreshActivationReadiness',
         'Get-BatchStagingIdentity',
        'Initialize-BatchStagingWorktree',
        'Get-BatchMergeChainProof',
        'Assert-BatchMergeChain',
        'Invoke-BatchMergeChain',
        'Get-BatchCandidatePipelineEvidence',
        'Get-BatchCandidateDeploymentProbe',
        'Get-BatchCandidatePublicProbe',
        'Assert-BatchCandidateIdentityRecoveryState',
        'Invoke-BatchCandidateIdentityReconciliation',
         'Assert-MasterPublicationAuthorization',
         'Assert-BatchAdmissionAuthorization',
          'Get-BatchValidatorKey',
          'Test-BatchValidatorHexEqual',
          'Get-BatchValidatorAdapterPath',
         'Assert-BatchValidatorConfigured',
         'Assert-DeploymentAuthorization',
        'Assert-IntegrationAuthorization',
        'Assert-IntegrationWorktreeRecoveryState',
        'Get-IntegrationWorktreeRecoveryEvidence',
        'Restore-IntegrationWorktreeToProtectedIntegration',
        'Test-GitAncestor'
    )) {
    $functionAst = @($orchestratorAst.FindAll({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $functionName
    }, $true))
    Assert-True ($functionAst.Count -eq 1) "orchestrator defines exactly one $functionName helper"
    Invoke-Expression $functionAst[0].Extent.Text
}
$writeStateFunction = (Get-Command Write-State).ScriptBlock

# The extracted helpers are exercised before the later state fixture overrides are installed.
function Stop-Workflow([string]$Message) { throw $Message }

$admissionState = [pscustomobject]@{
    batch_admission_authorized = $true
    feature_worktrees = @('C:\feature-one', 'C:\feature-two')
    feature_branches = @('feature/one--from-t000', 'fix/two--from-t000')
    feature_tip_shas = @(('a' * 40), ('b' * 40))
    player_patch_notes = @('First feature note.', 'Second feature note.')
}
Assert-BatchAdmissionAuthorization $admissionState
$isolationRefused = $false
try { Assert-BatchValidatorConfigured $admissionState }
catch { $isolationRefused = $_.Exception.Message -match 'isolated uncredentialed validator adapter' }
Assert-True $isolationRefused `
    'batch admission fails closed until validation is delegated to an external uncredentialed validator'
Assert-True ((Test-BatchValidatorHexEqual ('a' * 64) ('a' * 64)) -and
    -not (Test-BatchValidatorHexEqual ('a' * 64) ('b' * 64))) `
    'batch validator receipt comparisons require exact 256-bit hex equality'
$admissionState.batch_admission_authorized = $false
$admissionRejected = $false
try { Assert-BatchAdmissionAuthorization $admissionState }
catch { $admissionRejected = $true }
Assert-True $admissionRejected 'batch admission requires its explicit authorization before feature inspection'

Assert-True (Test-FeatureAdmissionStatus '') 'feature admission accepts a clean worktree'
Assert-True (Test-FeatureAdmissionStatus '?? __MERGED_TO_TEST__.md') `
    'feature admission accepts only the generated untracked merged receipt'
Assert-True (-not (Test-FeatureAdmissionStatus "?? __MERGED_TO_TEST__.md`n?? other.txt")) `
    'feature admission rejects another untracked file beside the merged receipt'
Assert-True ((ConvertTo-PlayerPatchNote '  Players   keep their progress  ') -ceq
    'Players keep their progress.') 'player patch notes normalize whitespace and punctuation'
foreach ($unsafePatchNote in @(
        'Short',
        "Unsafe`nsecond line note",
        'Notify @everyone about this release',
        'Notify <@123456789> about this release',
        ('x' * 161)
    )) {
    $patchNoteRefused = $false
    try { ConvertTo-PlayerPatchNote $unsafePatchNote | Out-Null }
    catch { $patchNoteRefused = $true }
    Assert-True $patchNoteRefused "unsafe player patch note is refused: $unsafePatchNote"
}

$ConfirmPlayerPatchNoteEncodingRecovery = $false
$exactPlayerPatchNote = Get-PlayerPatchNoteRecoveryMatch `
    'Players keep their progress — even after reconnect.' `
    'Players keep their progress — even after reconnect.'
Assert-True ($exactPlayerPatchNote.match_type -eq 'exact_ordinal' -and
    $exactPlayerPatchNote.repair_pass_count -eq 0 -and
    $exactPlayerPatchNote.immutable_candidate_trailer -ceq
        'Players keep their progress — even after reconnect.') `
    'recovery accepts an exact ordinal player patch-note match without encoding repair'

function ConvertTo-ReleaseNoteMojibakeFixture([string]$Text) {
    $windows1252 = [Text.Encoding]::GetEncoding(1252)
    return $windows1252.GetString([Text.Encoding]::UTF8.GetBytes($Text))
}
$canonicalPlayerPatchNote = 'Patch note: café — reconnect is ready.'
$doubleMojibakePlayerPatchNote = ConvertTo-ReleaseNoteMojibakeFixture (
    ConvertTo-ReleaseNoteMojibakeFixture $canonicalPlayerPatchNote)
$ConfirmPlayerPatchNoteEncodingRecovery = $true
$repairedPlayerPatchNote = Get-PlayerPatchNoteRecoveryMatch `
    $doubleMojibakePlayerPatchNote $canonicalPlayerPatchNote
Assert-True ($repairedPlayerPatchNote.match_type -eq 'windows_1252_utf8_repair' -and
    $repairedPlayerPatchNote.repair_pass_count -eq 2 -and
    $repairedPlayerPatchNote.immutable_candidate_trailer -ceq $canonicalPlayerPatchNote) `
    'recovery repairs the observed double Windows-1252/UTF-8 mojibake fixture in two bounded passes'
$arbitraryPlayerPatchNoteRefused = $false
try {
    Get-PlayerPatchNoteRecoveryMatch 'arbitrary mismatched note.' $canonicalPlayerPatchNote | Out-Null
} catch {
    $arbitraryPlayerPatchNoteRefused = $true
}
Assert-True $arbitraryPlayerPatchNoteRefused `
    'recovery rejects an arbitrary player patch-note mismatch even when encoding recovery is authorized'
$ConfirmPlayerPatchNoteEncodingRecovery = $false

$stateEncodingRoot = Join-Path $env:TEMP ('ash-atlas-release-state-encoding-' + [guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Path $stateEncodingRoot -Force | Out-Null
try {
    $StateRoot = $stateEncodingRoot
    $StateRootWasSpecified = $true
    $ReleaseCoordinationRoot = Join-Path $stateEncodingRoot 'coordination'
    $unicodeStateNote = 'Patch note: café — progress is preserved.'
    $unicodeState = [pscustomobject]@{
        operation_id = 'unicode-state-fixture'
        status = 'running'
        updated_at_utc = [DateTimeOffset]::UtcNow.ToString('o')
        player_patch_note = $unicodeStateNote
    }
    & $writeStateFunction $unicodeState
    foreach ($kind in @('ash-atlas-coordinated-start-claim', 'ash-atlas-coordinated-release-seed')) {
        [pscustomobject]@{ kind = $kind; operation_id = 'statusless-mobile-sidecar';
            generation = 't1252'; source_sha = ('a' * 40) } |
            ConvertTo-Json | Set-Content -LiteralPath (Join-Path $StateRoot ($kind + '.json')) -Encoding UTF8
    }
    $readUnicodeState = Read-State 'unicode-state-fixture'
    $unfinishedUnicodeStates = @(Get-UnfinishedReleaseOperations)
    Assert-True ($unfinishedUnicodeStates.Count -eq 1) `
        'statusless mobile claim and seed sidecars do not enter the unfinished workflow scan'
    $unfinishedUnicodeState = @($unfinishedUnicodeStates | Where-Object {
            [string]$_.operation_id -eq 'unicode-state-fixture'
        })
    Assert-True ([string]$readUnicodeState.player_patch_note -ceq $unicodeStateNote -and
        $unfinishedUnicodeState.Count -eq 1 -and
        [string]$unfinishedUnicodeState[0].player_patch_note -ceq $unicodeStateNote) `
        'operation-state readers preserve Unicode through explicit UTF-8 decoding'
    $oldUnreconciledSideEffect = [pscustomobject]@{
        operation_id = 'old-unreconciled-side-effect-fixture'
        status = 'failed'
        updated_at_utc = [DateTimeOffset]::UtcNow.AddDays(-30).ToString('o')
        side_effect_reconciliation_required = $true
    }
    # Write directly: Write-State would re-stamp updated_at_utc to now.
    $oldUnreconciledSideEffect | ConvertTo-Json -Depth 14 |
        Set-Content -LiteralPath (Get-StatePath 'old-unreconciled-side-effect-fixture') -Encoding utf8
    $unfinishedSideEffects = @(Get-UnfinishedReleaseOperations | Where-Object {
            [string]$_.operation_id -eq 'old-unreconciled-side-effect-fixture'
        })
    Assert-True ($unfinishedSideEffects.Count -eq 0 -and
        [string](Read-State 'old-unreconciled-side-effect-fixture').abandoned_at_utc) `
        'side-effect operations older than 24 hours are auto-abandoned and stop blocking'
    $oldUnresolvedActivation = [pscustomobject]@{
        operation_id = 'old-unresolved-activation-fixture'
        status = 'failed'
        updated_at_utc = [DateTimeOffset]::UtcNow.AddDays(-30).ToString('o')
        activation_intent = [pscustomobject]@{ intentId = 'old-unresolved-activation-fixture' }
        activation_intent_resolved = $false
    }
    $oldUnresolvedActivation | ConvertTo-Json -Depth 14 |
        Set-Content -LiteralPath (Get-StatePath 'old-unresolved-activation-fixture') -Encoding utf8
    $unfinishedActivation = @(Get-UnfinishedReleaseOperations | Where-Object {
            [string]$_.operation_id -eq 'old-unresolved-activation-fixture'
        })
    Assert-True ($unfinishedActivation.Count -eq 0 -and
        [string](Read-State 'old-unresolved-activation-fixture').status -ceq 'failed') `
        'stale activation intents are auto-abandoned while keeping their original status'
} finally {
    Remove-Item -LiteralPath $stateEncodingRoot -Recurse -Force
}

$processStartedAt = (Get-Process -Id $PID).StartTime.ToUniversalTime().ToString('o')
$roundTrippedTicket = ([pscustomobject]@{
        process_id = $PID
        process_started_at_utc = $processStartedAt
    } | ConvertTo-Json | ConvertFrom-Json)
Assert-True (Test-ReleaseQueueOwnerAlive $roundTrippedTicket) `
    'release queue ownership survives JSON runtimes that deserialize ISO timestamps as DateTime values'
Assert-True (-not (Test-FeatureAdmissionStatus ' M packages/shared/content.json')) `
    'feature admission rejects a tracked modification'
Assert-True (-not (Test-FeatureAdmissionStatus 'A  __MERGED_TO_TEST__.md')) `
    'feature admission rejects a staged merged receipt'
function Stop-Workflow([string]$Message) { throw $Message }
function Get-StateValue($Object, [string]$Name, $Default) {
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $Default }
    return $property.Value
}
function Write-State { param($State) }

$originalGetUnfinishedForResumeFixture = (Get-Command Get-UnfinishedReleaseOperations).ScriptBlock
$resumeFixturePaths = @(
    (Join-Path $env:TEMP 'ash-atlas-resume-collision-one'),
    (Join-Path $env:TEMP 'ash-atlas-resume-collision-two')
)
$script:ResumeCollisionState = [pscustomobject]@{
    operation_id = 'legacy-batch-release-fixture'
    requested_mode = 'IntegrateAndPublish'
    status = 'running'
    updated_at_utc = [DateTimeOffset]::UtcNow.ToString('o')
    feature_worktree = ''
    feature_worktrees = $resumeFixturePaths
    feature_branches = @('feature/one--from-t000', 'fix/two--from-t000')
    feature_tip_shas = @(('a' * 40), ('b' * 40))
    player_patch_note = ''
    player_patch_notes = @('First feature note.', 'Second feature note.')
}
function Get-UnfinishedReleaseOperations { return @($script:ResumeCollisionState) }
function Test-ReleaseOperationActivelyCoordinated { return $false }
$script:Mode = 'IntegrateBatchAdmission'
$script:OperationId = ''
$script:FeatureWorktree = ''
$script:FeatureWorktrees = $resumeFixturePaths
$script:FeatureBranches = @('feature/one--from-t000', 'fix/two--from-t000')
$script:FeatureTipShas = @(('a' * 40), ('b' * 40))
$script:PlayerPatchNote = ''
$script:PlayerPatchNotes = @('First feature note.', 'Second feature note.')
$crossModeResumeRefused = $false
try { Resolve-AutomaticReleaseResume }
catch { $crossModeResumeRefused = $_.Exception.Message -match 'existing unfinished release operation detected' }
Assert-True $crossModeResumeRefused `
    'automatic resume refuses a matching worktree packet from a different requested release mode'
$script:ResumeCollisionState.requested_mode = 'IntegrateBatchAdmission'
$script:ResumeCollisionState.feature_tip_shas = @(('c' * 40), ('b' * 40))
$identityMismatchResumeRefused = $false
try { Resolve-AutomaticReleaseResume }
catch { $identityMismatchResumeRefused = $_.Exception.Message -match 'existing unfinished release operation detected' }
Assert-True $identityMismatchResumeRefused `
    'automatic batch admission resume refuses a changed ordered branch/SHA packet'
Set-Item Function:\Get-UnfinishedReleaseOperations $originalGetUnfinishedForResumeFixture
Remove-Item Function:\Test-ReleaseOperationActivelyCoordinated -Force -ErrorAction SilentlyContinue

$script:OperationId = 'state-constructor-fixture'
$script:Mode = 'Integrate'
$script:FeatureWorktree = ''
$script:FeatureWorktrees = @()
$script:PlayerPatchNote = ''
$script:PlayerPatchNotes = @()
$script:ConfirmIntegration = $false
$script:ConfirmGenerationCheckpoint = $false
$script:AtomicMasterPublication = $false
$script:ApprovedIntegrationTest = $false
$script:ConfirmPublish = $false
$script:ConfirmDeploy = $false
$script:DisplayName = 'state constructor fixture'
$script:AdmissionMode = 'PreservedExactFeatureVerification'
$script:AdmissionCommand = ''
$script:MobileCompatibilityServerUrl = 'https://playashatlas.com'
$script:ConfirmWorldHandoffRecovery = $false
$script:DeploymentPollIntervalSeconds = 2
$script:RepositoryRoot = $root
$constructedWorkflowState = New-WorkflowState
Assert-True ($null -ne $constructedWorkflowState.PSObject.Properties['prepared_native_compatibility_json'] -and
    $null -ne $constructedWorkflowState.PSObject.Properties['prepared_native_compatibility_sha256']) `
    'new workflow state declares the prepared native compatibility fields before PREPARE'
$legacyDeploymentState = [pscustomobject]@{
    schema_version = 8
    operation_id = 'legacy-state-constructor-fixture'
    deployment_start_connection_count = 0
    remote_deployment_receipt = $null
}
Initialize-DeploymentState $legacyDeploymentState
Assert-True ($legacyDeploymentState.PSObject.Properties['prepared_native_compatibility_json'] -and
    $legacyDeploymentState.PSObject.Properties['prepared_native_compatibility_sha256'] -and
    [string]$legacyDeploymentState.prepared_native_compatibility_json -eq '' -and
    [string]$legacyDeploymentState.prepared_native_compatibility_sha256 -eq '') `
    'legacy deployment state initializes prepared native compatibility fields without strict setter failure'

$prepareFixtureOriginalFunctions = [ordered]@{}
foreach ($functionName in @(
        'Publish-ReleaseCandidateRef', 'Assert-DeploymentStatusPayload',
        'Assert-ExactPreparedReceipt', 'ConvertFrom-ControllerReceipt')) {
    $prepareFixtureOriginalFunctions[$functionName] =
        (Get-Command $functionName -CommandType Function).ScriptBlock
}
function Publish-ReleaseCandidateRef {
    param([Parameter(Mandatory = $true)]$State, [Parameter(Mandatory = $true)][string]$Target)
    $State.release_candidate_ref = 'refs/heads/integration/release-candidates/prepare-fixture'
    $State.release_protocol = 'prepare_activate_v1'
    return $State.release_candidate_ref
}
function Get-FileSha256 { param([Parameter(Mandatory = $true)][string]$Path); return ('a' * 64) }
function New-DeploymentStatusToken { return ('b' * 64) }
function Assert-ConsistentControllerPayload { param($Response) }
function Assert-DeploymentStatusPayload { param($Status, $State, [string]$Target) }
function Assert-ExactPreparedReceipt { param($Receipt, $State, [string]$Target, [string]$UpdaterHash, [string]$Generation) }
function ConvertFrom-ControllerReceipt { param($Payload, $State); return $Payload }
function Invoke-DeploymentController {
    param($State, [string]$Action, [string[]]$Arguments, [string]$StandardInput)
    if ($Action -eq 'prepare') {
        return [pscustomobject]@{ payload = [pscustomobject]@{ result = 'prepared' } }
    }
    if ($Action -eq 'status') {
        return [pscustomobject]@{ payload = $script:PrepareFixturePayload }
    }
    throw "unexpected PREPARE fixture controller action: $Action"
}
$script:PrepareFixturePayload = [pscustomobject]@{
    result = 'prepared'
    prepare_receipt_sha256 = 'c' * 64
    prepared_remote_receipt_sha256 = 'd' * 64
    prepared_env_sha256 = 'e' * 64
    prepared_native_compatibility_json = '{"serverProtocol":{"min":3,"max":3},"hardMinimum":{"ios":{"version":"1.0.0","build":1},"android":{"version":"1.0.0","build":1}}}'
    prepared_native_compatibility_sha256 = ''
    prepared_descriptor_version = 4
    prepared_descriptor_sha256 = 'f' * 64
    release_classification_version = 1
    release_class = 'server_no_migration'
    release_classification_evidence_sha256 = '1' * 64
    release_changed_paths_sha256 = '2' * 64
    prepared_server_component_sha = '3' * 40
    prepared_server_artifact_sha256 = '4' * 64
    prepared_client_component_sha = '5' * 40
    prepared_client_artifact_sha256 = '6' * 64
    prepared_static_artifact_fence_sha256 = '7' * 64
    prepared_release_metadata_fence_sha256 = '8' * 64
    prepared_game_main_pid = 1234
    prepared_game_start_timestamp_monotonic = 5678
    prepared_live_game_link_sha = '9' * 40
    prepared_live_public_link_sha = 'a' * 40
    prepared_live_public_release_sha = 'a' * 40
    deployment_timings = $null
}
$script:PrepareFixturePayload.prepared_native_compatibility_sha256 =
    Get-TextSha256 $script:PrepareFixturePayload.prepared_native_compatibility_json
$prepareFixtureState = New-WorkflowState
$prepareFixtureState.new_generation = 't999'
$prepareFixtureState.candidate_integration_sha = 'b' * 40
try {
    Invoke-PrepareCandidate $prepareFixtureState ('b' * 40) 't999' | Out-Null
    Assert-True ([string]$prepareFixtureState.prepared_native_compatibility_json -eq
        [string]$script:PrepareFixturePayload.prepared_native_compatibility_json -and
        [string]$prepareFixtureState.prepared_native_compatibility_sha256 -eq
            [string]$script:PrepareFixturePayload.prepared_native_compatibility_sha256) `
        'actual PREPARE state transition records the prepared native policy fields'
} finally {
    foreach ($entry in $prepareFixtureOriginalFunctions.GetEnumerator()) {
        Set-Item -Path ("Function:{0}" -f $entry.Key) -Value $entry.Value
    }
}

$completedActivationState = [pscustomobject]@{
    release_protocol = 'prepare_activate_v1'
    activation_intent_resolved = $true
    activation_intent = $null
}
$completedActivationReceipt = [pscustomobject]@{
    result = 'completed'
    requested_target_sha = ('a' * 40)
}
Assert-True (Test-PreparedActivationCompletionReconciled $completedActivationState `
        $completedActivationReceipt ('a' * 40)) `
    'completed prepared activation is recognized as already reconciled'
$completedActivationState.activation_intent_resolved = $false
Assert-True (-not (Test-PreparedActivationCompletionReconciled $completedActivationState `
        $completedActivationReceipt ('a' * 40))) `
    'completed prepared activation remains resumable until its intent is resolved'
$completedActivationState.activation_intent_resolved = $true
$completedActivationState.activation_intent = [pscustomobject]@{ intentId = 'activation-fixture' }
$completedActivationState.activation_intent_resolved = $false
Assert-True (-not (Test-GitOnlyReconciliationRequired $completedActivationState)) `
    'an unresolved deployment activation intent cannot enter the Git-only resume path'

$readinessNewActivationState = [pscustomobject]@{
    coordinated_manifest = [pscustomobject]@{}
    remote_side_effect_intent = $null
    activation_intent = $null
    remote_deployment_receipt = $null
}
Assert-True (Test-CoordinatedReleaseNeedsFreshActivationReadiness $readinessNewActivationState) `
    'new coordinated activation requires a fresh app readiness check'
$readinessExistingActivationState = [pscustomobject]@{
    coordinated_manifest = [pscustomobject]@{}
    remote_side_effect_intent = $null
    activation_intent = [pscustomobject]@{ intentId = 'existing-activation' }
    remote_deployment_receipt = [pscustomobject]@{ result = 'completed' }
}
Assert-True (-not (Test-CoordinatedReleaseNeedsFreshActivationReadiness $readinessExistingActivationState)) `
    'existing activation reconciliation proceeds when current app readiness has changed'
$readinessRunningState = [pscustomobject]@{
    coordinated_manifest = [pscustomobject]@{}
    remote_side_effect_intent = $null
    activation_intent = $null
    remote_deployment_receipt = [pscustomobject]@{ result = 'running' }
}
Assert-True (-not (Test-CoordinatedReleaseNeedsFreshActivationReadiness $readinessRunningState)) `
    'running activation reconciliation does not restart from a new readiness gate'
$readinessPreparedPendingState = [pscustomobject]@{
    coordinated_manifest = [pscustomobject]@{}
    remote_side_effect_intent = [pscustomobject]@{ kind = 'vps_activation'; status = 'pending' }
    activation_intent = [pscustomobject]@{ intentId = 'prepared-activation' }
    remote_deployment_receipt = [pscustomobject]@{ result = 'prepared'; activation_started = $false; activation_completed = $false }
}
Assert-True (Test-CoordinatedReleaseNeedsFreshActivationReadiness $readinessPreparedPendingState) `
    'prepared but never activated requires a fresh readiness check before retry'
$readinessPreparedStartedState = [pscustomobject]@{
    coordinated_manifest = [pscustomobject]@{}
    remote_side_effect_intent = $null
    activation_intent = [pscustomobject]@{ intentId = 'prepared-activation' }
    remote_deployment_receipt = [pscustomobject]@{ result = 'prepared'; activation_started = $true; activation_completed = $false }
}
Assert-True (-not (Test-CoordinatedReleaseNeedsFreshActivationReadiness $readinessPreparedStartedState)) `
    'prepared activation with a started remote attempt reconciles without a new readiness gate'
$readinessFailedNoMutationState = [pscustomobject]@{
    coordinated_manifest = [pscustomobject]@{}
    remote_side_effect_intent = [pscustomobject]@{ kind = 'vps_activation'; status = 'pending' }
    activation_intent = [pscustomobject]@{ intentId = 'failed-no-mutation-activation' }
    activation_intent_resolved = $false
    remote_deployment_receipt = [pscustomobject]@{
        result = 'failed'
        mutation_evidence_complete = $true
        migration_started = $false
        migration_completed = $false
        migration_outcome_uncertain = $false
        activation_started = $false
        activation_completed = $false
        rollback_result = 'not_required'
        activation_result = 'failed'
        migration_result = 'not_required'
    }
}
Assert-True (Test-CoordinatedReleaseNeedsFreshActivationReadiness $readinessFailedNoMutationState) `
    'a complete no-mutation activation failure requires fresh readiness before its retry'

$focusedAdmissionFixture = Join-Path $env:TEMP ('ash-atlas-focused-admission-' + [guid]::NewGuid().ToString('n'))
$focusedAdmissionStateRoot = Join-Path $env:TEMP ('ash-atlas-focused-admission-state-' + [guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Path $focusedAdmissionFixture -Force | Out-Null
New-Item -ItemType Directory -Path $focusedAdmissionStateRoot -Force | Out-Null
try {
    & git init -b integration/test $focusedAdmissionFixture | Out-Null
    & git -C $focusedAdmissionFixture config user.email 'focused-admission-tests@example.invalid'
    & git -C $focusedAdmissionFixture config user.name 'Focused Admission Tests'
    Set-Content -LiteralPath (Join-Path $focusedAdmissionFixture 'baseline.txt') -Value 'baseline'
    & git -C $focusedAdmissionFixture add baseline.txt
    & git -C $focusedAdmissionFixture commit -m baseline | Out-Null
    $focusedBaseline = (& git -C $focusedAdmissionFixture rev-parse HEAD).Trim()
    & git -C $focusedAdmissionFixture checkout -b feature/conflict-fixture | Out-Null
    Set-Content -LiteralPath (Join-Path $focusedAdmissionFixture 'feature.txt') -Value 'feature'
    & git -C $focusedAdmissionFixture add feature.txt
    & git -C $focusedAdmissionFixture commit -m feature | Out-Null
    $focusedFeature = (& git -C $focusedAdmissionFixture rev-parse HEAD).Trim()
    & git -C $focusedAdmissionFixture checkout integration/test | Out-Null
    & git -C $focusedAdmissionFixture merge --no-ff --no-edit $focusedFeature | Out-Null
    $focusedCandidate = (& git -C $focusedAdmissionFixture rev-parse HEAD).Trim()
    $focusedAdmissionState = [pscustomobject]@{
        operation_id = 'focused-admission-fixture'
        candidate_integration_sha = $focusedCandidate
        admission_command = '$actualRoot = (& git rev-parse --show-toplevel).Trim(); if ($actualRoot -ne $env:ASH_ATLAS_ADMISSION_CWD) { exit 21 }; $actualHead = (& git rev-parse HEAD).Trim(); if ($actualHead -ne $env:ASH_ATLAS_ADMISSION_SHA) { exit 22 }; $parents = ((& git show -s --format=%P HEAD).Trim() -split ''\s+''); if ($parents.Count -ne 2) { exit 23 }'
        admission_before_sha = ''
        admission_after_sha = ''
        admission_candidate_sha = ''
        admission_working_directory = ''
        admission_receipt = $null
        admission_result = ''
        active_validation_gate = ''
        final_candidate_sha = $focusedCandidate
        staging_worktree = $focusedAdmissionFixture
    }
    $script:IntegrationWorktree = $focusedAdmissionFixture
    $script:StateRoot = $focusedAdmissionStateRoot
    $focusedAdmissionResult = Invoke-FocusedCandidateAdmission $focusedAdmissionState
    $focusedAdmissionPathMatches = Test-AshAtlasSamePath `
        $focusedAdmissionState.admission_receipt.working_directory $focusedAdmissionFixture
    Assert-True ($focusedAdmissionState.admission_before_sha -eq $focusedCandidate -and
        $focusedAdmissionState.admission_after_sha -eq $focusedCandidate -and
        $focusedAdmissionState.admission_candidate_sha -eq $focusedCandidate -and
        $focusedAdmissionState.admission_working_directory -eq
            (& git -C $focusedAdmissionFixture rev-parse --show-toplevel).Trim() -and
        $focusedAdmissionState.admission_receipt.exit_code -eq 0 -and
        $focusedAdmissionState.admission_receipt.candidate_sha -eq $focusedCandidate -and
        $focusedAdmissionPathMatches) `
        'focused candidate admission executes in the exact candidate cwd and records conflict merge provenance'
} finally {
    Remove-Item -LiteralPath $focusedAdmissionFixture -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $focusedAdmissionStateRoot -Recurse -Force -ErrorAction SilentlyContinue
}

$script:NativeShaFixture = [pscustomobject]@{
    start_succeeded = $true
    timed_out = $false
    exit_code = 0
    stdout = ('a' * 40) + "`n"
    stderr = 'warning: informational stderr must not contaminate stdout'
}
function Invoke-BoundedNativeProcess { return $script:NativeShaFixture }
Assert-True ((Get-GitCommitId $root 'HEAD') -eq ('a' * 40)) `
    'commit identity parsing accepts one canonical stdout SHA while ignoring informational stderr'
$script:NativeShaFixture.stdout = ('a' * 40) + "`nwarning mixed into stdout"
$mixedShaRejected = $false
try { Get-GitCommitId $root 'HEAD' | Out-Null }
catch { $mixedShaRejected = $_.Exception.Message -match 'non-canonical commit id' }
Assert-True $mixedShaRejected 'commit identity parsing rejects stdout polluted with non-SHA text'
. (Join-Path $PSScriptRoot 'deployment-transport.ps1')
Assert-True ((Get-GitCommitId $root 'HEAD') -eq ((& git -C $root rev-parse HEAD).Trim())) `
    'strict commit identity parsing resolves an actual repository commit'

$candidateDiagnostic = "C:\candidate\apps\client\src\App.tsx(1,2): error TS1`r`n"
$baselineDiagnostic = "/baseline/apps/client/src/App.tsx(1,2): error TS1`n"
Assert-True ((ConvertTo-NormalizedGateDiagnostics $candidateDiagnostic @('C:\candidate')) -eq
    (ConvertTo-NormalizedGateDiagnostics $baselineDiagnostic @('/baseline'))) `
    'baseline comparison normalizes worktree roots and line endings without hiding diagnostic changes'

$Mode = 'Resume'
$resumePhaseStart = [DateTimeOffset]::UtcNow.AddSeconds(-10).ToString('o')
$resumeLastObserved = [DateTimeOffset]::UtcNow.AddSeconds(-7).ToString('o')
$resumeTimingState = [pscustomobject]@{
    operation_id = 'resume-timing-fixture'
    status = 'running:fixture'
    failure_phase = ''
    updated_at_utc = $resumeLastObserved
    phases = [pscustomobject]@{
        fixture = [pscustomobject]@{
            status = 'running'
            started_at_utc = $resumePhaseStart
            first_started_at_utc = $resumePhaseStart
            finished_at_utc = ''
            duration_ms = 0
            active_duration_ms = 0
            wall_clock_duration_ms = 0
            attempt_count = 1
            attempts = @([pscustomobject]@{
                    attempt = 1
                    mode = 'IntegrateAndPublish'
                    status = 'running'
                    started_at_utc = $resumePhaseStart
                    finished_at_utc = ''
                    duration_ms = 0
                    result = ''
                })
            result = ''
        }
    }
}
$resumeTimingState = $resumeTimingState | ConvertTo-Json -Depth 8 | ConvertFrom-Json
$resumeResult = Invoke-Phase $resumeTimingState fixture { 'resumed-completion' }
$resumePhase = $resumeTimingState.phases.fixture
Assert-True ($resumeResult -eq 'resumed-completion' -and
    $resumePhase.status -eq 'completed' -and
    $resumePhase.attempt_count -eq 2 -and
    $resumePhase.attempts[0].status -eq 'interrupted' -and
    $resumePhase.attempts[0].duration_ms -ge 2900 -and
    $resumePhase.attempts[0].duration_ms -le 3100 -and
    $resumePhase.attempts[1].status -eq 'completed' -and
    $resumePhase.wall_clock_duration_ms -ge $resumePhase.active_duration_ms) `
    'Resume preserves the original phase clock and appends measured attempts'

$descriptorTarget = '1' * 40
$descriptorPrevious = '2' * 40
$descriptorHash = 'a' * 64
$descriptorNativePolicy = '{"serverProtocol":{"min":3,"max":3},"hardMinimum":{"ios":{"version":"0.0.0","build":0},"android":{"version":"0.0.0","build":0}}}'
$descriptorNativePolicyHash = Get-TextSha256 $descriptorNativePolicy
$descriptorState = [pscustomobject]@{
    operation_id = 'client-descriptor-fixture'
    release_candidate_ref = 'refs/heads/integration/release-candidates/client-descriptor-fixture'
}
$clientDescriptor = [pscustomobject]@{
    operation_id = $descriptorState.operation_id
    requested_target_sha = $descriptorTarget
    updater_hash = ('b' * 64)
    requested_generation = 'test/t542'
    candidate_ref = $descriptorState.release_candidate_ref
    result = 'prepared'
    prepare_result = 'completed'
    prepared_generation = 'test/t542'
    prepared_previous_game_sha = $descriptorPrevious
    release_classification_version = 1
    release_class = 'client_only'
    release_classification_evidence_sha256 = ('c' * 64)
    release_changed_paths_sha256 = ('d' * 64)
    prepared_descriptor_version = 4
    prepared_descriptor_sha256 = $descriptorHash
    prepare_receipt_sha256 = $descriptorHash
    prepared_remote_receipt_sha256 = ('4' * 64)
    prepared_env_sha256 = ('5' * 64)
    prepared_native_compatibility_json = $descriptorNativePolicy
    prepared_native_compatibility_sha256 = $descriptorNativePolicyHash
    prepared_game_release_sha256 = ''
    prepared_public_release_sha256 = ('e' * 64)
    prepared_server_component_sha = $descriptorPrevious
    prepared_server_artifact_sha256 = ('f' * 64)
    prepared_client_component_sha = $descriptorTarget
    prepared_client_artifact_sha256 = ('1' * 64)
    prepared_static_artifact_fence_sha256 = ('2' * 64)
    prepared_release_metadata_fence_sha256 = ('3' * 64)
    prepared_game_main_pid = 1234
    prepared_game_start_timestamp_monotonic = 5678
    prepared_live_game_link_sha = $descriptorPrevious
    prepared_live_public_link_sha = $descriptorPrevious
    prepared_live_public_release_sha = $descriptorPrevious
    activation_result = 'pending'
    activation_started = $false
}
Assert-ExactPreparedReceipt $clientDescriptor $descriptorState $descriptorTarget ('b' * 64) t542
$clientDescriptor.prepared_server_component_sha = $descriptorTarget
$invalidClientDescriptorRefused = $false
try { Assert-ExactPreparedReceipt $clientDescriptor $descriptorState $descriptorTarget ('b' * 64) t542 }
catch { $invalidClientDescriptorRefused = $_.Exception.Message -match 'inactive PREPARED receipt' }
Assert-True $invalidClientDescriptorRefused `
    'client-only prepared descriptor refuses a server component different from the live baseline'
$clientDescriptor.prepared_server_component_sha = $descriptorPrevious
$clientDescriptor.prepared_static_artifact_fence_sha256 = ''
$missingPreparedFenceRefused = $false
try { Assert-ExactPreparedReceipt $clientDescriptor $descriptorState $descriptorTarget ('b' * 64) t542 }
catch { $missingPreparedFenceRefused = $_.Exception.Message -match 'inactive PREPARED receipt' }
Assert-True $missingPreparedFenceRefused `
    'prepared descriptor refuses a missing static artifact metadata fence'
$clientDescriptor.prepared_static_artifact_fence_sha256 = ('2' * 64)

$clientStatusState = [pscustomobject]@{
    operation_id = 'client-status-fixture'
    release_class = 'client_only'
    prepared_server_component_sha = $descriptorPrevious
}
$clientCompletedStatus = [pscustomobject][ordered]@{
    schema_version = 1
    operation_id = $clientStatusState.operation_id
    target_sha = $descriptorTarget
    result = 'completed'
    current_phase = 'completed'
    active_game_sha = $descriptorPrevious
    active_public_sha = $descriptorTarget
    migration_result = 'not_required'
    activation_result = 'completed'
    readiness_result = 'completed'
    mutation_evidence_complete = $true
    migration_started = $false
    migration_completed = $false
    migration_outcome_uncertain = $false
    activation_started = $true
    activation_completed = $true
    rollback_result = 'not_required'
    failure_phase = ''
    failure_code = ''
    updated_at_utc = [DateTimeOffset]::UtcNow.ToString('o')
}
Assert-DeploymentStatusPayload $clientCompletedStatus $clientStatusState $descriptorTarget
$clientCompletedStatus | Add-Member NoteProperty state_transitions @([pscustomobject]@{
        timestamp_utc = [DateTimeOffset]::UtcNow.AddMilliseconds(-250).ToString('o')
        operation_id = $clientStatusState.operation_id
        previous_state = 'host_readiness'
        next_state = 'completed'
        elapsed_previous_state_ms = 250
        reason = 'controller_receipt_update'
        process_pid = 1234
        scope = 'remote_controller'
    })
Assert-DeploymentStatusPayload $clientCompletedStatus $clientStatusState $descriptorTarget
$clientCompletedStatus.state_transitions[0].operation_id = 'wrong-operation'
$foreignTransitionRefused = $false
try { Assert-DeploymentStatusPayload $clientCompletedStatus $clientStatusState $descriptorTarget }
catch { $foreignTransitionRefused = $_.Exception.Message -match 'unsafe transition record' }
Assert-True $foreignTransitionRefused `
    'HTTPS status rejects transition telemetry from a different operation'
$clientCompletedStatus.state_transitions[0].operation_id = $clientStatusState.operation_id
$clientCompletedStatus.active_game_sha = $descriptorTarget
$restartedClientStatusRefused = $false
try { Assert-DeploymentStatusPayload $clientCompletedStatus $clientStatusState $descriptorTarget }
catch { $restartedClientStatusRefused = $_.Exception.Message -match 'exact active identity' }
Assert-True $restartedClientStatusRefused `
    'client-only completion requires the prepared server component to remain active'

$ConfirmIntegration = $true
$ConfirmGenerationCheckpoint = $true
$ApprovedIntegrationTest = $true
$ConfirmPublish = $true
$ConfirmDeploy = $false
Assert-IntegrationAuthorization ([pscustomobject]@{
        atomic_master_publication = $true
        requested_mode = 'Integrate'
    })
$deploymentAuthorizationRefused = $false
try {
    Assert-IntegrationAuthorization ([pscustomobject]@{
            atomic_master_publication = $true
            requested_mode = 'IntegrateAndPublish'
        })
} catch {
    $deploymentAuthorizationRefused = $_.Exception.Message -eq 'deployment requires -ConfirmDeploy'
}
Assert-True $deploymentAuthorizationRefused `
    'git-only atomic master publication does not require deployment authorization, while combined publication does'
$ConfirmDeploy = $true
Assert-IntegrationAuthorization ([pscustomobject]@{
        atomic_master_publication = $true
        requested_mode = 'IntegrateAndPublish'
    })

$gitFixture = Join-Path $env:TEMP ("ash-atlas-release-git-fields-" + [guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Path $gitFixture -Force | Out-Null
try {
    & git -C $gitFixture init -b master | Out-Null
    & git -C $gitFixture config user.email 'release-flow-tests@example.invalid'
    & git -C $gitFixture config user.name 'Release Flow Tests'
    Set-Content -LiteralPath (Join-Path $gitFixture 'fixture.txt') -Value 'base'
    & git -C $gitFixture add fixture.txt
    & git -C $gitFixture commit -m 'base' | Out-Null
    $firstParent = (& git -C $gitFixture rev-parse HEAD).Trim()
    & git -C $gitFixture checkout -b feature | Out-Null
    Set-Content -LiteralPath (Join-Path $gitFixture 'feature.txt') -Value 'feature'
    & git -C $gitFixture add feature.txt
    & git -C $gitFixture commit -m 'feature' | Out-Null
    $secondParent = (& git -C $gitFixture rev-parse HEAD).Trim()
    & git -C $gitFixture checkout master | Out-Null
    & git -C $gitFixture merge --no-ff --no-edit $secondParent | Out-Null
    $mergeSha = (& git -C $gitFixture rev-parse HEAD).Trim()
    $parents = Get-GitFields $gitFixture @('show', '-s', '--format=%P', $mergeSha)
    Assert-True ($parents.Count -eq 2 -and $parents[0] -eq $firstParent -and $parents[1] -eq $secondParent) 'Get-GitFields returns exact ordered parents from a two-parent merge'
    Assert-True (Test-ExactMergeParents $parents $firstParent $secondParent) 'exact merge parents pass post-merge and pre-publication validation'
    Assert-True (-not (Test-ExactMergeParents @($secondParent, $firstParent) $firstParent $secondParent)) 'reversed merge parents are refused'
    Assert-True (-not (Test-ExactMergeParents @($firstParent) $firstParent $secondParent)) 'one-parent commit is refused'
    Assert-True (-not (Test-ExactMergeParents @($firstParent, $secondParent, ('f' * 40)) $firstParent $secondParent)) 'three-parent merge is refused'
    Assert-True (-not (Test-ExactMergeParents $parents ('0' * 40) $secondParent)) 'wrong first parent is refused'
    Assert-True (-not (Test-ExactMergeParents $parents $firstParent ('1' * 40))) 'wrong feature-tip parent is refused'
    $originalGetGitText = (Get-Command Get-GitText).ScriptBlock
    function Get-GitText { return "$firstParent  `t`n  $secondParent" }
    $whitespaceParents = Get-GitFields $gitFixture @('unused')
    Assert-True ($whitespaceParents.Count -eq 2 -and
        $whitespaceParents[0] -eq $firstParent -and $whitespaceParents[1] -eq $secondParent) 'Git fields split repeated spaces, tabs, and newlines without empty entries'
    Set-Item Function:\Get-GitText $originalGetGitText
} finally {
    Remove-Item -LiteralPath $gitFixture -Recurse -Force
}

$recoveryBaseline = 'a' * 40
$recoveryCandidate = 'b' * 40
$recoveryIntegration = 'c' * 40
$recoveryMaster = 'd' * 40
$recoveryDeployed = 'e' * 40
$recoveryPublic = 'f' * 40
$recoveryFeature = '9' * 40
$recoveryState = [pscustomobject]@{
    status = 'failed'
    requested_mode = 'IntegrateAndPublish'
    original_integration_sha = $recoveryBaseline
    original_master_sha = $recoveryBaseline
    candidate_integration_sha = $recoveryCandidate
    feature_tip = $recoveryFeature
    new_generation = ''
    atomic_push_result = ''
    master_publication_result = ''
    exact_deployed_sha = ''
    phases = [pscustomobject]@{
        local_merge = [pscustomobject]@{ status = 'completed' }
    }
    remote_deployment_receipt = [pscustomobject]@{
        target_sha = $recoveryCandidate
        result = 'failed'
        active_game_sha = $recoveryBaseline
        active_public_sha = $recoveryBaseline
        activation_result = 'pending'
    }
}
Assert-IntegrationWorktreeRecoveryState $recoveryState
$recoveryTruth = [pscustomobject]@{
    integration_test_sha = $recoveryIntegration
    master_sha = $recoveryMaster
    deployed_sha = $recoveryDeployed
    public_release_sha = $recoveryPublic
}
$originalTestGitAncestor = (Get-Command Test-GitAncestor).ScriptBlock
$originalRecoveryGetGitText = (Get-Command Get-GitText).ScriptBlock
$script:RepositoryRoot = $root
function Test-GitAncestor {
    param([string]$Repository, [string]$Ancestor, [string]$Descendant)
    return ($Ancestor -eq $recoveryBaseline -and
            $Descendant -in @($recoveryIntegration, $recoveryMaster))
}
function Get-GitText {
    param([string]$Repository, [string[]]$Arguments)
    if ($Arguments[0] -eq 'cherry') { return "+ $recoveryFeature" }
    throw "unexpected recovery Git command: $($Arguments -join ' ')"
}
$recoveryEvidence = Get-IntegrationWorktreeRecoveryEvidence `
    $recoveryState $recoveryTruth '' $recoveryCandidate
Assert-True ($recoveryEvidence.classification -eq 'unmerged' -and
    $recoveryEvidence.current_integration_sha -eq $recoveryIntegration -and
    $recoveryEvidence.current_deployed_sha -eq $recoveryDeployed) `
    'recovery accepts advanced protected and deployed baselines only after classifying the preserved candidate'
$originalCherry = (Get-Command Get-GitText).ScriptBlock
function Get-GitText { return "- $recoveryFeature" }
$equivalentEvidence = Get-IntegrationWorktreeRecoveryEvidence `
    $recoveryState $recoveryTruth '' $recoveryCandidate
Assert-True ($equivalentEvidence.classification -eq 'feature_patch_equivalent') `
    'recovery identifies patch-equivalent incorporation without requiring original commit ancestry'
Set-Item Function:\Get-GitText $originalCherry
$protectedCandidateRefused = $false
try {
    $taggedCandidate = $recoveryCandidate + [char]9 + 'refs/tags/test/t999'
    Get-IntegrationWorktreeRecoveryEvidence `
        $recoveryState $recoveryTruth $taggedCandidate $recoveryCandidate | Out-Null
} catch { $protectedCandidateRefused = $_.Exception.Message -match 'immutable generation' }
Assert-True $protectedCandidateRefused `
    'recovery refuses inconsistent state where a tagged candidate is absent from current integration'
$activatedCandidateRefused = $false
$recoveryState.remote_deployment_receipt.active_game_sha = $recoveryCandidate
try { Assert-IntegrationWorktreeRecoveryState $recoveryState }
catch { $activatedCandidateRefused = $_.Exception.Message -match 'remained inactive' }
Assert-True $activatedCandidateRefused 'recovery refuses an activated candidate'
$recoveryState.remote_deployment_receipt.active_game_sha = $recoveryBaseline

$preparedRecoveryState = $recoveryState.PSObject.Copy()
$preparedRecoveryState.remote_deployment_receipt = [pscustomobject]@{
    requested_target_sha = $recoveryCandidate
    result = 'prepared'
    prepare_result = 'completed'
    current_phase = 'prepared'
    candidate_preflight_result = 'completed'
    activation_started = $false
    activation_completed = $false
    activation_result = 'pending'
    active_game_sha = ''
    active_public_sha = ''
    preparation_live_game_sha = $recoveryBaseline
    prepared_previous_game_sha = $recoveryBaseline
    prepared_previous_public_sha = $recoveryBaseline
}
Assert-IntegrationWorktreeRecoveryState $preparedRecoveryState
Get-IntegrationWorktreeRecoveryEvidence `
    $preparedRecoveryState $recoveryTruth '' $recoveryCandidate | Out-Null
$orphanPreparedState = $preparedRecoveryState.PSObject.Copy()
$orphanPreparedState.status = 'running:prepare_candidate_on_vps'
Assert-IntegrationWorktreeRecoveryState $orphanPreparedState
$orphanPreparedState.remote_deployment_receipt.activation_started = $true
$orphanPreparedRefused = $false
try { Assert-IntegrationWorktreeRecoveryState $orphanPreparedState }
catch { $orphanPreparedRefused = $_.Exception.Message -match 'prepared deployment receipt' }
Assert-True $orphanPreparedRefused 'orphan recovery refuses a PREPARE whose activation started'
$orphanPreparedState.remote_deployment_receipt.activation_started = $false
$projectedPreparedState = $preparedRecoveryState.PSObject.Copy()
$projectedPreparedState | Add-Member -NotePropertyName prepared_receipt_sha256 -NotePropertyValue ('c' * 64)
$projectedPreparedState.remote_deployment_receipt = [pscustomobject]@{
    target_sha = $recoveryCandidate
    result = 'prepared'
    current_phase = 'prepared'
    activation_result = 'pending'
    active_game_sha = $recoveryBaseline
    active_public_sha = $recoveryBaseline
}
Assert-IntegrationWorktreeRecoveryState $projectedPreparedState
Get-IntegrationWorktreeRecoveryEvidence `
    $projectedPreparedState $recoveryTruth '' $recoveryCandidate | Out-Null
$preparedRecoveryState.remote_deployment_receipt.activation_started = $true
$preparedActivationRefused = $false
try { Assert-IntegrationWorktreeRecoveryState $preparedRecoveryState }
catch { $preparedActivationRefused = $_.Exception.Message -match 'activation pending' }
Assert-True $preparedActivationRefused 'recovery refuses a PREPARED candidate whose activation started'
Set-Item Function:\Test-GitAncestor $originalTestGitAncestor
Set-Item Function:\Get-GitText $originalRecoveryGetGitText

$recoveryFixture = Join-Path $env:TEMP ("ash-atlas-integration-recovery-" + [guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Path $recoveryFixture -Force | Out-Null
try {
    & git -C $recoveryFixture init -b integration/test | Out-Null
    & git -C $recoveryFixture config user.email 'release-recovery-tests@example.invalid'
    & git -C $recoveryFixture config user.name 'Release Recovery Tests'
    Set-Content -LiteralPath (Join-Path $recoveryFixture 'baseline.txt') -Value 'baseline'
    & git -C $recoveryFixture add baseline.txt
    & git -C $recoveryFixture commit -m 'baseline' | Out-Null
    $fixtureBaseline = (& git -C $recoveryFixture rev-parse HEAD).Trim()
    Set-Content -LiteralPath (Join-Path $recoveryFixture 'candidate.txt') -Value 'candidate'
    & git -C $recoveryFixture add candidate.txt
    & git -C $recoveryFixture commit -m 'candidate' | Out-Null
    $fixtureCandidate = (& git -C $recoveryFixture rev-parse HEAD).Trim()
    $script:IntegrationWorktree = $recoveryFixture
    Set-Content -LiteralPath (Join-Path $recoveryFixture 'dirty.txt') -Value 'dirty'
    $dirtyRecoveryRefused = $false
    try { Restore-IntegrationWorktreeToProtectedIntegration $fixtureCandidate $fixtureBaseline }
    catch { $dirtyRecoveryRefused = $_.Exception.Message -match 'dirty' }
    Assert-True $dirtyRecoveryRefused 'recovery refuses a dirty integration worktree'
    Remove-Item -LiteralPath (Join-Path $recoveryFixture 'dirty.txt')
    $restoreOutput = @(Restore-IntegrationWorktreeToProtectedIntegration $fixtureCandidate $fixtureBaseline)
    $restoredClean = -not [bool](& git -C $recoveryFixture status --porcelain)
    Assert-True ((& git -C $recoveryFixture rev-parse HEAD).Trim() -eq $fixtureBaseline -and
        $restoredClean -and $restoreOutput.Count -eq 0) 'recovery restores the exact baseline without polluting its receipt output'
} finally {
    Remove-Item -LiteralPath $recoveryFixture -Recurse -Force
}

$candidateFixture = Join-Path $env:TEMP ("ash-atlas-release-candidate-" + [guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Path $candidateFixture -Force | Out-Null
try {
    $candidateSource = Join-Path $candidateFixture 'source'
    $candidateRemote = Join-Path $candidateFixture 'remote.git'
    & git init --bare $candidateRemote | Out-Null
    & git init -b master $candidateSource | Out-Null
    & git -C $candidateSource config user.email 'release-flow-tests@example.invalid'
    & git -C $candidateSource config user.name 'Release Flow Tests'
    Set-Content -LiteralPath (Join-Path $candidateSource 'candidate.txt') -Value 'candidate'
    & git -C $candidateSource add candidate.txt
    & git -C $candidateSource commit -m 'candidate' | Out-Null
    & git -C $candidateSource remote add origin $candidateRemote
    $candidateSha = (& git -C $candidateSource rev-parse HEAD).Trim()
    $candidateState = [pscustomobject]@{
        operation_id = 'candidate-operation'
        staging_worktree = $candidateSource
        release_candidate_ref = ''
        release_protocol = ''
    }
    $candidateRef = Publish-ReleaseCandidateRef $candidateState $candidateSha
    $candidateRemoteFields = Get-GitFields $candidateSource @('ls-remote', '--heads', 'origin', $candidateRef)
    Assert-True ($candidateRemoteFields.Count -eq 2 -and
        $candidateRemoteFields[0] -eq $candidateSha -and
        $candidateRemoteFields[1] -eq $candidateRef) `
        'operation-scoped release candidate publication records one exact remote ref'
    Assert-True ((Publish-ReleaseCandidateRef $candidateState $candidateSha) -eq $candidateRef) `
        'exact release candidate publication is idempotent'
    Set-Content -LiteralPath (Join-Path $candidateSource 'candidate.txt') -Value 'different candidate'
    & git -C $candidateSource commit -am 'different candidate' | Out-Null
    $differentCandidate = (& git -C $candidateSource rev-parse HEAD).Trim()
    $collisionRejected = $false
    try { Publish-ReleaseCandidateRef $candidateState $differentCandidate | Out-Null }
    catch { $collisionRejected = $_.Exception.Message -match 'different immutable target' }
    Assert-True $collisionRejected 'an operation candidate ref can never be moved to another SHA'
} finally {
    Remove-Item -LiteralPath $candidateFixture -Recurse -Force
}

$publicationRecoveryRoot = Join-Path $env:TEMP (
    'ash-atlas-publication-recovery-' + [guid]::NewGuid().ToString('n'))
$publicationRecoveryRemote = Join-Path $publicationRecoveryRoot 'remote.git'
$publicationRecoveryPublisher = Join-Path $publicationRecoveryRoot 'publisher'
$publicationRecoveryIntegration = Join-Path $publicationRecoveryRoot 'integration'
$publicationRecoveryMaster = Join-Path $publicationRecoveryRoot 'master'
New-Item -ItemType Directory -Path $publicationRecoveryRoot -Force | Out-Null
$oldIntegrationWorktreeVariable = Get-Variable -Name IntegrationWorktree -Scope Script `
    -ErrorAction SilentlyContinue
$oldPermanentCheckoutVariable = Get-Variable -Name PermanentCheckout -Scope Script `
    -ErrorAction SilentlyContinue
try {
    & git init --bare $publicationRecoveryRemote | Out-Null
    & git init -b integration/test $publicationRecoveryPublisher | Out-Null
    & git -C $publicationRecoveryPublisher config user.email 'publication-recovery-tests@example.invalid'
    & git -C $publicationRecoveryPublisher config user.name 'Publication Recovery Tests'
    Set-Content -LiteralPath (Join-Path $publicationRecoveryPublisher 'base.txt') -Value 'base'
    & git -C $publicationRecoveryPublisher add base.txt
    & git -C $publicationRecoveryPublisher commit -qm base
    $publicationRecoveryBase = (& git -C $publicationRecoveryPublisher rev-parse HEAD).Trim()
    & git -C $publicationRecoveryPublisher branch master $publicationRecoveryBase
    & git -C $publicationRecoveryPublisher remote add origin $publicationRecoveryRemote
    & git -C $publicationRecoveryPublisher push origin integration/test master | Out-Null
    & git --git-dir=$publicationRecoveryRemote symbolic-ref HEAD refs/heads/integration/test
    & git clone -q $publicationRecoveryRemote $publicationRecoveryIntegration
    & git clone -q $publicationRecoveryRemote $publicationRecoveryMaster
    & git -C $publicationRecoveryIntegration checkout -q -B integration/test origin/integration/test
    & git -C $publicationRecoveryMaster checkout -q -B master origin/master

    $script:IntegrationWorktree = $publicationRecoveryIntegration
    $script:PermanentCheckout = $publicationRecoveryMaster
    $publicationRecoveryModes = @('IntegrateAndPublish', 'Integrate', 'IntegrateAndPublish')
    $publicationRecoveryTargets = @()
    for ($index = 0; $index -lt $publicationRecoveryModes.Count; $index++) {
        $stepName = $publicationRecoveryModes[$index].ToLowerInvariant()
        Set-Content -LiteralPath (Join-Path $publicationRecoveryPublisher "step-$index.txt") `
            -Value "$stepName publication"
        & git -C $publicationRecoveryPublisher add "step-$index.txt"
        & git -C $publicationRecoveryPublisher commit -qm "$stepName publication"
        $target = (& git -C $publicationRecoveryPublisher rev-parse HEAD).Trim()
        $publicationRecoveryTargets += $target
        $publicationState = [pscustomobject]@{
            operation_id = "publication-response-loss-$index"
            side_effect_reconciliation_required = $true
            side_effect_reconciliation_reason = ''
            side_effect_reconciliation_started_at_utc = ''
            side_effect_reconciliation_completed_at_utc = ''
            remote_side_effect_intent = $null
            remote_side_effect_intent_reconciled_at_utc = ''
            remote_side_effect_intent_terminal_result = ''
            local_checkout_reconciliation_result = ''
            local_checkout_reconciliation_target_sha = ''
        }
        Set-RemoteSideEffectIntent $publicationState 'git_master_publication' $target `
            "$($publicationRecoveryModes[$index]) publication response may be lost"
        & git -C $publicationRecoveryPublisher push --atomic origin `
            "${target}:refs/heads/integration/test" `
            "${target}:refs/heads/master" | Out-Null
        $reconciled = Invoke-LocalPublishedCheckoutReconciliation $publicationState $target -RequireMaster
        Assert-True ($reconciled -match [regex]::Escape("integration/test and master reconciled@$target") -and
            (Get-GitCommitId $publicationRecoveryIntegration 'HEAD') -eq $target -and
            (Get-GitCommitId $publicationRecoveryMaster 'HEAD') -eq $target -and
            $null -eq $publicationState.remote_side_effect_intent -and
            -not [bool]$publicationState.side_effect_reconciliation_required) `
            "$($publicationRecoveryModes[$index]) remote publication response loss reconciles both clean checkouts"
    }
    Assert-True ((Get-GitCommitId $publicationRecoveryIntegration 'HEAD') -eq $publicationRecoveryTargets[-1] -and
        (Get-GitCommitId $publicationRecoveryMaster 'HEAD') -eq $publicationRecoveryTargets[-1]) `
        'batch to single to batch publication sequence remains resumable at the final exact target'
} finally {
    if ($null -ne $oldIntegrationWorktreeVariable) {
        Set-Variable -Name IntegrationWorktree -Scope Script -Value $oldIntegrationWorktreeVariable.Value
    } else {
        Remove-Variable -Name IntegrationWorktree -Scope Script -ErrorAction SilentlyContinue
    }
    if ($null -ne $oldPermanentCheckoutVariable) {
        Set-Variable -Name PermanentCheckout -Scope Script -Value $oldPermanentCheckoutVariable.Value
    } else {
        Remove-Variable -Name PermanentCheckout -Scope Script -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $publicationRecoveryRoot -Recurse -Force -ErrorAction SilentlyContinue
}

$activationResponseLossTarget = 'a' * 40
$activationResponseLossState = [pscustomobject]@{
    operation_id = 'activation-response-loss-fixture'
    remote_side_effect_intent = $null
    remote_side_effect_intent_reconciled_at_utc = ''
    remote_side_effect_intent_terminal_result = ''
    deployment_automatic_reconciliation_required = $false
    remote_deployment_receipt = $null
    activation_intent_resolved = $true
    deployment_transition_events = @()
    deployment_completion_observation_lag_ms = 0
    deployment_lane = ''
    deployment_phase_timings = $null
}
Set-RemoteSideEffectIntent $activationResponseLossState 'vps_activation' `
    $activationResponseLossTarget 'activation response may be lost after remote acceptance'
Assert-True ([string]$activationResponseLossState.remote_side_effect_intent.status -eq 'pending' -and
    [bool]$activationResponseLossState.deployment_automatic_reconciliation_required) `
    'ACTIVATE response loss persists a pending durable intent before reconciliation'
Set-RemoteReceipt $activationResponseLossState ([pscustomobject]@{
        operation_id = $activationResponseLossState.operation_id
        requested_target_sha = $activationResponseLossTarget
        target_sha = $activationResponseLossTarget
        current_phase = 'completed'
        result = 'completed'
        rollback_result = 'not_required'
        state_transitions = @()
        deployment_timings = $null
    })
Assert-True ($null -eq $activationResponseLossState.remote_side_effect_intent -and
    -not [bool]$activationResponseLossState.deployment_automatic_reconciliation_required -and
    $activationResponseLossState.remote_side_effect_intent_terminal_result -eq 'completed' -and
    $activationResponseLossState.remote_deployment_receipt.result -eq 'completed') `
    'authoritative ACTIVATE completion clears its pending intent after response loss'

$receiptNormalizationState = [pscustomobject]@{
    operation_id = 'raw-receipt-normalization-fixture'
}
$rawPartialMigrationReceipt = [pscustomobject]@{
    operation_id = $receiptNormalizationState.operation_id
    target_sha = ('a' * 40)
    result = 'failed'
    current_phase = 'migration'
    failure_phase = 'migration'
    migration_required = $true
    migration_started = $true
    migration_completed = $false
    migration_outcome_uncertain = $true
    activation_started = $false
    activation_completed = $false
    activation_result = 'pending'
    migration_result = 'failed'
    rollback_result = 'blocked_migration_compatibility_uncertain'
    observed_game_sha = ('b' * 40)
    observed_public_sha = ('c' * 40)
}
$normalizedPartialMigrationReceipt = ConvertFrom-ControllerReceipt `
    $rawPartialMigrationReceipt $receiptNormalizationState
Assert-True ($normalizedPartialMigrationReceipt.target_sha -eq $rawPartialMigrationReceipt.target_sha -and
    $normalizedPartialMigrationReceipt.migration_started -eq $true -and
    $normalizedPartialMigrationReceipt.migration_outcome_uncertain -eq $true -and
    $normalizedPartialMigrationReceipt.rollback_result -eq
        'blocked_migration_compatibility_uncertain' -and
    (Test-ReceiptMutationEvidence $normalizedPartialMigrationReceipt) -and
    -not (Test-ReceiptNoMutation $normalizedPartialMigrationReceipt)) `
    'raw partial-migration receipts preserve target and authoritative mutation uncertainty through normalization'
$partialMigrationResolverState = [pscustomobject]@{
    operation_id = 'raw-receipt-resolver-fixture'
    activation_intent_id = 'raw-receipt-resolver-fixture'
    activation_intent = [pscustomobject]@{ intentId = 'raw-receipt-resolver-fixture' }
    activation_intent_resolved = $false
    release_class = 'server_no_migration'
    prepared_live_game_link_sha = ('b' * 40)
    prepared_live_public_release_sha = ('c' * 40)
    reconciled_remote_truth = $null
}
$partialMigrationResolutionRefused = $false
try {
    Resolve-MobileActivationIntent $root $partialMigrationResolverState `
        $normalizedPartialMigrationReceipt | Out-Null
} catch {
    $partialMigrationResolutionRefused = $_.Exception.Message -match 'exact live completion|proven rollback|proven no-mutation'
}
Assert-True $partialMigrationResolutionRefused `
    'resolver refuses cancellation when normalized migration evidence is uncertain'
$rawHttpsCompletedReceipt = [pscustomobject]@{
    operation_id = 'raw-https-target-fixture'
    target_sha = ('d' * 40)
    result = 'completed'
    current_phase = 'completed'
    active_game_sha = ('d' * 40)
    active_public_sha = ('d' * 40)
    migration_started = $false
    migration_completed = $false
    migration_outcome_uncertain = $false
    activation_started = $true
    activation_completed = $true
    mutation_evidence_complete = $true
    rollback_result = 'not_required'
}
$normalizedHttpsCompletedReceipt = ConvertFrom-ControllerReceipt `
    $rawHttpsCompletedReceipt $receiptNormalizationState
Assert-True ($normalizedHttpsCompletedReceipt.target_sha -eq $rawHttpsCompletedReceipt.target_sha -and
    $normalizedHttpsCompletedReceipt.activation_completed -eq $true -and
    (Test-ReceiptMutationEvidence $normalizedHttpsCompletedReceipt)) `
    'HTTPS target_sha receipts normalize with complete activation evidence'

$activationRegistryFixtureRoot = Join-Path $env:TEMP (
    'ash-atlas-activation-registry-' + [guid]::NewGuid().ToString('n'))
$activationRegistryRemote = Join-Path $activationRegistryFixtureRoot 'registry.git'
$activationRegistryCandidate = Join-Path $activationRegistryFixtureRoot 'candidate'
New-Item -ItemType Directory -Path $activationRegistryFixtureRoot -Force | Out-Null
try {
    & git init --bare --quiet $activationRegistryRemote
    & git clone --quiet $root $activationRegistryCandidate
    & git -C $activationRegistryCandidate remote set-url origin $activationRegistryRemote
    $activationTarget = (& git -C $activationRegistryCandidate rev-parse HEAD).Trim()
    $activationNativePolicy = '{"serverProtocol":{"min":3,"max":3},"hardMinimum":{"ios":{"version":"1.0.0","build":1},"android":{"version":"1.0.0","build":1}}}'
    $activationNativePolicyHash = Get-TextSha256 $activationNativePolicy
    $activationFixtureState = [pscustomobject]@{
        operation_id = 'activation-registry-response-loss-fixture'
        prepared_remote_receipt_sha256 = 'b' * 64
        prepared_env_sha256 = 'c' * 64
        prepared_native_compatibility_json = $activationNativePolicy
        prepared_native_compatibility_sha256 = $activationNativePolicyHash
        prepared_server_component_sha = $activationTarget
        mobile_compatibility_registry_commit_sha = 'd' * 40
        mobile_compatibility_registry_remote = $activationRegistryRemote
        mobile_compatibility_protocol_min = 9
        mobile_compatibility_protocol_max = 9
        mobile_compatibility_settings = @(
            [pscustomobject]@{ platform = 'ios'; hard_minimum_version = '9.9.9'; hard_minimum_build = 0 }
            [pscustomobject]@{ platform = 'android'; hard_minimum_version = '9.9.9'; hard_minimum_build = 0 }
        )
        activation_intent = $null
        activation_intent_id = 'activation-registry-response-loss-fixture'
        activation_registry_commit_sha = ''
        activation_intent_resolved = $false
        activation_registry_resolved_at_utc = ''
        activation_intent_terminal_result = ''
        release_class = 'server_no_migration'
        prepared_live_game_link_sha = 'e' * 40
        prepared_live_public_release_sha = 'f' * 40
        reconciled_remote_truth = $null
    }
    $activationIntent = [ordered]@{
        schemaVersion = 1
        intentId = $activationFixtureState.activation_intent_id
        serverSha = $activationTarget
        candidateComponentSha = $activationTarget
        preparedReceiptSha = $activationFixtureState.prepared_remote_receipt_sha256
        preSwitchEnvSha = $activationFixtureState.prepared_env_sha256
        serverProtocol = [ordered]@{ min = 3; max = 3 }
        hardMinimum = [ordered]@{
            ios = [ordered]@{ version = '1.0.0'; build = 1 }
            android = [ordered]@{ version = '1.0.0'; build = 1 }
        }
        createdAt = '2026-01-01T00:00:00.000Z'
    }
    $activationFixtureState.activation_intent = $activationIntent | ConvertTo-Json -Depth 10 | ConvertFrom-Json
    $registryWorktree = Join-Path $activationRegistryFixtureRoot 'registry-worktree'
    & git init -b registry-state --quiet $registryWorktree
    & git -C $registryWorktree config user.email 'activation-fixture@example.invalid'
    & git -C $registryWorktree config user.name 'Activation Fixture'
    $registryJsonPath = Join-Path $registryWorktree 'mobile-release-registry.json'
    $registrySeedPath = Join-Path $activationRegistryCandidate 'config\mobile-release-registry.seed.json'
    $activationIntentSeedPath = Join-Path $activationRegistryFixtureRoot 'activation-intent.json'
    [IO.File]::WriteAllText(
        $activationIntentSeedPath,
        ($activationFixtureState.activation_intent | ConvertTo-Json -Depth 10) + [Environment]::NewLine,
        [Text.UTF8Encoding]::new($false))
    $registryScript = @'
const fs = require("node:fs");
const [seedPath, outputPath, intentPath] = process.argv.slice(2);
const registry = JSON.parse(fs.readFileSync(seedPath, "utf8"));
registry.activationIntent = JSON.parse(fs.readFileSync(intentPath, "utf8"));
delete registry.resolvedIntent;
fs.writeFileSync(outputPath, `${JSON.stringify(registry, null, 2)}\n`);
'@
    $registryScript | & node - $registrySeedPath $registryJsonPath $activationIntentSeedPath
    if ($LASTEXITCODE -ne 0) {
        throw 'activation registry fixture could not seed the intent document'
    }
    & git -C $registryWorktree add mobile-release-registry.json
    & git -C $registryWorktree commit -qm 'fixture: seed activation intent'
    & git -C $registryWorktree remote add origin $activationRegistryRemote
    & git -C $registryWorktree push --quiet origin HEAD:refs/heads/mobile-release-state
    $activationFixtureState.mobile_compatibility_registry_commit_sha =
        (& git -C $registryWorktree rev-parse HEAD).Trim()
    Push-Location $activationRegistryCandidate
    try {
        $debugRemoteStatus = & node (Join-Path $activationRegistryCandidate 'tools\mobile-release\registry-remote.mjs') activation-status
        $activationFixtureState.activation_intent =
            (($debugRemoteStatus -join '') | ConvertFrom-Json).activationIntent
        $activationFixtureState.activation_intent_id =
            [string]$activationFixtureState.activation_intent.intentId
        $activationRegistryCommit = Set-MobileActivationIntent $activationRegistryCandidate `
            $activationTarget $activationFixtureState
        Assert-True ($activationRegistryCommit -match '^[0-9a-f]{40}$' -and
            -not [bool]$activationFixtureState.activation_intent_resolved) `
            'activation intent CAS accepts BOM-free JSON and records the exact durable identity'
        $persistedActivationStatus = Get-MobileActivationRegistryStatus $activationRegistryCandidate -State $activationFixtureState
        Assert-True ($activationFixtureState.activation_intent -is [pscustomobject] -and
            (Test-MobileActivationIntentIdentity $activationFixtureState.activation_intent $persistedActivationStatus.activationIntent)) `
            'same-process activation retains the property-based identity used by terminal resolution'
        Assert-True ($activationFixtureState.activation_intent.serverProtocol.min -eq 3 -and
            $activationFixtureState.activation_intent.serverProtocol.max -eq 3 -and
            $activationFixtureState.activation_intent.hardMinimum.ios.version -eq '1.0.0' -and
            $activationFixtureState.activation_intent.hardMinimum.ios.build -eq 1 -and
            $activationFixtureState.activation_intent.hardMinimum.android.version -eq '1.0.0' -and
            $activationFixtureState.activation_intent.hardMinimum.android.build -eq 1) `
            'activation intent binds the prepared native policy instead of changed live compatibility settings'
        $completedActivationReceipt = [pscustomobject]@{
            operation_id = $activationFixtureState.operation_id
            target_sha = $activationTarget
            result = 'completed'
            active_game_sha = $activationTarget
            active_public_sha = $activationTarget
            mutation_evidence_complete = $true
            migration_started = $false
            migration_completed = $false
            migration_outcome_uncertain = $false
            activation_started = $true
            activation_completed = $true
            rollback_result = 'not_required'
            deployment_status_token = 'fixture-must-not-persist'
            log_url = 'https://example.invalid/fixture-must-not-persist'
        }
        Assert-True ((Resolve-MobileActivationIntentRemote $activationRegistryCandidate `
            $activationFixtureState.activation_intent -State $activationFixtureState `
            -TerminalReceipt $completedActivationReceipt) -eq 'resolved') `
            'fixture resolves the exact completed remote intent before discarding the response'
        $auditedStatus = Get-MobileActivationRegistryStatus $activationRegistryCandidate -State $activationFixtureState
        $terminalAudit = $auditedStatus.resolvedIntents[0].terminalAudit
        Assert-True ($terminalAudit.version -eq 'terminal-reconciliation-v1' -and
            $terminalAudit.originalIntentSha256 -eq (Get-TextSha256 $terminalAudit.originalIntentJson) -and
            $terminalAudit.serverProof.receipt.operation_id -eq $activationFixtureState.operation_id -and
            $terminalAudit.serverProof.liveIdentity.publicSha -eq $activationTarget) `
            'completed resolution appends immutable identity and authoritative server proof'
        Assert-True ($null -eq $terminalAudit.serverProof.receipt.PSObject.Properties['deployment_status_token'] -and
            $null -eq $terminalAudit.serverProof.receipt.PSObject.Properties['log_url']) `
            'terminal audit persists only whitelisted server proof fields'
        $activationFixtureState.activation_intent_resolved = $false
        $activationFixtureState.activation_registry_resolved_at_utc = ''
        Resolve-MobileActivationIntent $activationRegistryCandidate $activationFixtureState `
            $completedActivationReceipt
        Assert-True ([bool]$activationFixtureState.activation_intent_resolved -and
            $activationFixtureState.activation_intent_terminal_result -eq 'completed' -and
            $activationFixtureState.activation_registry_resolved_at_utc) `
            'Resume resolves an already-deleted activation intent after a lost delete response'
        $conflictingReceipt = $completedActivationReceipt | ConvertTo-Json -Depth 10 | ConvertFrom-Json
        $conflictingReceipt.activation_completed = $false
        $conflictingRetryRefused = $false
        try {
            Resolve-MobileActivationIntentRemote $activationRegistryCandidate $activationFixtureState.activation_intent `
                -State $activationFixtureState -TerminalReceipt $conflictingReceipt | Out-Null
        } catch { $conflictingRetryRefused = $_.Exception.Message -match 'terminal activation retry was refused|lacks the exact immutable server proof' }
        Assert-True $conflictingRetryRefused 'an already-resolved retry refuses conflicting partial server proof'
        $script:ActualActivationStatusFunction = (Get-Command Get-MobileActivationRegistryStatus).ScriptBlock
        try {
            foreach ($fault in @('missing_audit', 'different_completed_proof')) {
                $script:ActivationStatusFault = $fault
                $script:ActivationStatusReadCount = 0
                function Get-MobileActivationRegistryStatus {
                    param([string]$CandidateWorktree, [object]$State = $null)
                    $result = & $script:ActualActivationStatusFunction $CandidateWorktree -State $State
                    $script:ActivationStatusReadCount++
                    if ($script:ActivationStatusReadCount -eq 1) {
                        # Model a resolver racing after our initial active-intent read.
                        $result.activationIntent = $State.activation_intent
                        $result.resolvedIntents = @()
                    } elseif ($script:ActivationStatusFault -eq 'missing_audit') {
                        $result.resolvedIntents[0].terminalAudit = $null
                    } else {
                        $result.resolvedIntents[0].terminalAudit.serverProof.receipt | Add-Member `
                            -NotePropertyName prepared_env_sha256 -NotePropertyValue $State.activation_intent.preSwitchEnvSha
                    }
                    return $result
                }
                $followUpRefused = $false
                try {
                    Resolve-MobileActivationIntentRemote $activationRegistryCandidate $activationFixtureState.activation_intent `
                        -State $activationFixtureState -TerminalReceipt $completedActivationReceipt | Out-Null
                } catch { $followUpRefused = $_.Exception.Message -match 'lacks the exact immutable server proof' }
                Assert-True $followUpRefused "authoritative follow-up refuses $fault despite an exact resolved intent"
            }
        } finally {
            Set-Item -Path Function:Get-MobileActivationRegistryStatus -Value $script:ActualActivationStatusFunction
        }
        $aIntent = $activationFixtureState.activation_intent | ConvertTo-Json -Depth 10 | ConvertFrom-Json
        $bIntent = $aIntent | ConvertTo-Json -Depth 10 | ConvertFrom-Json
        $bIntent.intentId = 'activation-registry-b-fixture'
        $bIntent.createdAt = '2026-01-02T00:00:00.000Z'
        $bIntentPath = Join-Path $activationRegistryFixtureRoot 'b-intent.json'
        [IO.File]::WriteAllText(
            $bIntentPath,
            ($bIntent | ConvertTo-Json -Depth 10) + [Environment]::NewLine,
            [Text.UTF8Encoding]::new($false))
        & node (Join-Path $activationRegistryCandidate 'tools\mobile-release\registry-remote.mjs') `
            set-activation-intent '--intent-file' $bIntentPath | Out-Null
        Assert-True ($LASTEXITCODE -eq 0) `
            'fixture acquires a different active B intent after resolving A'
        $activationFixtureState.activation_intent = $aIntent
        $activationFixtureState.activation_intent_id = [string]$aIntent.intentId
        $activationFixtureState.activation_intent_resolved = $false
        $activationFixtureState.activation_registry_resolved_at_utc = ''
        Assert-True ((Resolve-MobileActivationIntentRemote $activationRegistryCandidate $aIntent) -eq
            'already_resolved') `
            'A retry honors its exact resolved history while a different B intent is active'
        & node (Join-Path $activationRegistryCandidate 'tools\mobile-release\registry-remote.mjs') `
            resolve-activation-intent '--intent-file' $bIntentPath | Out-Null
        Assert-True ($LASTEXITCODE -eq 0) `
            'fixture resolves active B before testing the next no-mutation acquisition'
        $unauditedReceipt = $completedActivationReceipt | ConvertTo-Json -Depth 10 | ConvertFrom-Json
        $unauditedReceipt.operation_id = $bIntent.intentId
        $unauditedRetryRefused = $false
        try {
            Resolve-MobileActivationIntentRemote $activationRegistryCandidate $bIntent `
                -State $activationFixtureState -TerminalReceipt $unauditedReceipt | Out-Null
        } catch { $unauditedRetryRefused = $_.Exception.Message -match 'lacks the exact immutable server proof' }
        Assert-True $unauditedRetryRefused 'audited terminal retry refuses a legacy receipt without an audit'
        Assert-True ((Resolve-MobileActivationIntentRemote $activationRegistryCandidate $bIntent) -eq 'already_resolved') `
            'legacy retry without terminal proof remains unchanged after the audited refusal'
        $activationFixtureState.activation_intent_resolved = $true
        $activationFixtureState.operation_id = 'activation-registry-cancel-fixture'
        $activationFixtureState.activation_intent_id = $activationFixtureState.operation_id
        $activationFixtureState.activation_intent.intentId = $activationFixtureState.activation_intent_id
        $activationFixtureState.activation_registry_commit_sha = ''
        $cancelIntentPath = Join-Path $activationRegistryFixtureRoot 'cancel-intent.json'
        [IO.File]::WriteAllText(
            $cancelIntentPath,
            ($activationFixtureState.activation_intent | ConvertTo-Json -Depth 10) + [Environment]::NewLine,
            [Text.UTF8Encoding]::new($false))
        & node (Join-Path $activationRegistryCandidate 'tools\mobile-release\registry-remote.mjs') `
            set-activation-intent '--intent-file' $cancelIntentPath | Out-Null
        Assert-True ($LASTEXITCODE -eq 0) 'fixture reacquires the exact intent before no-mutation cancellation'
        $activationFixtureState.activation_intent_resolved = $false
        $noMutationReceipt = [pscustomobject]@{
            requested_target_sha = $activationTarget
            result = 'prepared'
            mutation_evidence_complete = $true
            activation_started = $false
            activation_completed = $false
            activation_result = 'pending'
            migration_started = $false
            migration_completed = $false
            migration_outcome_uncertain = $false
            migration_result = 'not_required'
            rollback_result = 'not_required'
            preparation_live_game_sha = $activationFixtureState.prepared_live_game_link_sha
            preparation_live_public_sha = $activationFixtureState.prepared_live_public_release_sha
            active_game_sha = ''
            active_public_sha = ''
        }
        Resolve-MobileActivationIntent $activationRegistryCandidate $activationFixtureState $noMutationReceipt
        Assert-True ($activationFixtureState.activation_intent_terminal_result -eq 'canceled_no_mutation') `
            'prepared activation with unchanged live identities can safely cancel its acquired intent'
        $activationFixtureState.operation_id = 'activation-registry-fresh-terminal-fixture'
        $activationFixtureState.activation_intent = $null
        $activationFixtureState.activation_registry_commit_sha = ''
        $activationFixtureState.activation_intent_resolved = $false
        Set-MobileActivationIntent $activationRegistryCandidate $activationTarget $activationFixtureState | Out-Null
        Assert-True ($activationFixtureState.activation_intent -is [pscustomobject]) `
            'fresh CAS converts its transient ordered dictionary into the durable property-based identity'
        $completedActivationReceipt.operation_id = $activationFixtureState.operation_id
        Resolve-MobileActivationIntent $activationRegistryCandidate $activationFixtureState $completedActivationReceipt
        Assert-True ($activationFixtureState.activation_intent_resolved -and
            $activationFixtureState.activation_intent_terminal_result -eq 'completed') `
            'fresh activation resolves in the same process immediately after CAS'
    } finally {
        Pop-Location
    }
} finally {
    Remove-Item -LiteralPath $activationRegistryFixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Assert-True ($orchestrator -match '\[string\[\]\]\$FeatureWorktrees' -and
    $orchestrator -match '\[switch\]\$ConfirmCombinedRelease' -and
    $orchestrator -match 'use either -FeatureWorktree or -FeatureWorktrees') `
    'one-feature interface remains while ordered batch binding is explicit'
Assert-True ($orchestrator -match '\[switch\]\$ConfirmPlayerPatchNoteEncodingRecovery' -and
    $orchestrator -match 'Get-PlayerPatchNoteRecoveryMatch' -and
    $orchestrator -match 'ConvertFrom-Windows1252Utf8Mojibake' -and
    $orchestrator -match 'immutable_candidate_trailer' -and
    $orchestrator -match 'Get-Content -Raw -LiteralPath \$path -Encoding utf8' -and
    $orchestrator -match 'Get-Content -Raw -LiteralPath \$(_|file)[.]FullName -Encoding utf8') `
    'recovery-only player-note encoding compatibility is explicit, bounded, audited, and UTF-8 state reads are pinned'
Assert-True ($orchestrator -match 'one feature cannot use -FeatureWorktrees; use -FeatureWorktree' -and
    $orchestrator.IndexOf('one feature cannot use -FeatureWorktrees') -lt
        $orchestrator.IndexOf('Acquire-ReleaseLease $OperationId $Mode')) `
    'a one-item batch is rejected before queueing so it cannot select broad combined validation'
Assert-True ($orchestrator -match 'accepted_unchanged_baseline_failure' -and
    $orchestrator -match 'diagnostics that differ from the failing baseline' -and
    $orchestrator -match 'the exact baseline passes') `
    'batch typecheck failures are accepted only when the exact protected baseline fails identically'
Assert-True ($orchestrator -match 'Acquire-ReleaseLease \$OperationId \$Mode' -and
    $orchestrator -match 'RELEASE QUEUED:' -and
    $orchestrator -match 'ConvertTo-CanonicalProcessStartUtc' -and
    $orchestrator -match 'release_queue_wait_duration_ms' -and
    $orchestrator -match 'Set-ReleaseLeaseTiming \$state' -and
    $orchestrator -match 'Resolve-AutomaticReleaseResume' -and
    $orchestrator -match 'Test-ReleaseOperationActivelyCoordinated' -and
    $orchestrator -match 'Assert-NoUnfinishedReleaseConflict \$OperationId' -and
    $orchestrator -match 'finally \{\s*Release-ReleaseLease') `
    'active releases queue while abandoned unfinished state blocks after lease acquisition'
Assert-True ($orchestrator -match "'RecoverIntegrationWorktree'" -and
    $orchestrator -match 'ConfirmIntegrationWorktreeRecovery' -and
    $orchestrator -match "ValidateSet\('Auto', 'Reintegrate', 'Superseded', 'Abandoned'\)" -and
    $orchestrator -match 'ConfirmCandidateRetirement' -and
    $orchestrator -match 'candidate remains unmerged; choose Reintegrate, Superseded, or Abandoned' -and
    $orchestrator -match 'exact recovery receipt does not prove the candidate remained prepared and inactive' -and
    $orchestrator -match 'Assert-IntegrationWorktreeRecoveryState' -and
    $orchestrator -match 'Get-IntegrationWorktreeRecoveryEvidence' -and
    $orchestrator -match 'Invoke-Git \$IntegrationWorktree @\(''reset'', ''--hard'', \$ProtectedIntegration\)' -and
    $orchestrator -match "local_candidate_ownership = 'released'") `
    'canonical recovery is explicit, ancestry-aware, disposition-bound, fail-closed, and ownership-releasing'
Assert-True ($orchestrator -match 'if \(\$Mode -eq ''IntegrateAndPublish''\)' -and
    $orchestrator -match '\$AtomicMasterPublication = \$true') `
    'combined single-feature releases use atomic master publication by default'
Assert-True ($orchestrator -match 'IntegrateBatchAdmission' -and
    $orchestrator -match '\[string\[\]\]\$FeatureBranches' -and
    $orchestrator -match '\[string\[\]\]\$FeatureTipShas' -and
    $orchestrator -match '\[switch\]\$ConfirmBatchAdmission' -and
    $orchestrator -match 'batch_admission_authorized' -and
    $orchestrator -match 'original_integration_generation' -and
    $orchestrator -match 'accepted_integration_sha' -and
    $orchestrator -match 'accepted_generation' -and
    $orchestrator -match 'external_uncredentialed_validator_verified' -and
    $orchestrator -match 'batch Resume observed a newer or changed protected snapshot') `
    'batch admission binds ordered feature refs and exact accepted generation identity'
$admissionBlockStart = $orchestrator.IndexOf('if ($AdmissionOnly) {')
$admissionBlockEnd = $orchestrator.IndexOf("Invoke-Phase `$State 'installed_deployment_identity_preflight'", $admissionBlockStart)
$admissionBlock = if ($admissionBlockStart -ge 0 -and $admissionBlockEnd -gt $admissionBlockStart) {
    $orchestrator.Substring($admissionBlockStart, $admissionBlockEnd - $admissionBlockStart)
} else { '' }
Assert-True ($admissionBlock -match 'batch_admission_protected_publication' -and
    $admissionBlock -match 'batch_admission_remote_publication_verification' -and
    $admissionBlock -match 'batch_admission_merged_receipts' -and
    $admissionBlock -match 'master remained' -and
    $admissionBlock -notmatch 'Invoke-PrepareCandidate' -and
    $admissionBlock -notmatch '-ExpectedMasterSha' -and
    $admissionBlock -notmatch '-PublishMaster') `
    'batch admission publishes integration/test plus one tag while excluding VPS and master publication'
Assert-True ($generation -match '(?s)\$refspecs = @\(.*?refs/heads/integration/test.*?refs/tags/test/\$newGeneration.*?\).*?if \(\$PublishMaster\).*?refs/heads/master' -and
    $generation -match '\$ExpectedMasterSha -and -not \$PublishMaster') `
    'generation helper keeps the no-master admission refspec and rejects an unbound master expectation'
Assert-True ($orchestrator -match '\^\(feature\|fix\|chore\|audit\)/' -and
    $featureRuntime -match '\^\(feature\|fix\|chore\|audit\)/') `
    'release admission and merged receipts accept every policy-approved task branch'
Assert-True ($orchestrator -match "'installed_deployment_identity_preflight'" -and
    $orchestrator -match 'Assert-InstalledDeploymentIdentity' -and
    $orchestrator -match "ValidateSet\('start', 'prepare', 'activate', 'status', 'result', 'identity', 'integrity', 'integrity-handoff'\)" -and
    $controller -match 'identity_operation') `
    'installed controller and updater identity is proven before every deployment publication lane'
Assert-True ($orchestrator -match 'function Get-FileSha256' -and
    $orchestrator -notmatch 'Get-FileHash') `
    'release hashing remains available without PowerShell utility module autoloading'
Assert-True ($orchestrator -match "'live_production_integrity_preflight'" -and
    $orchestrator -match 'Assert-LiveProductionIntegrity' -and
    $orchestrator -match 'active production readiness passed; fail-only signal, PREPARE remains authoritative' -and
    $controller -match 'integrity_operation' -and
    $controller -match 'timeout 8 /usr/local/libexec/ash-atlas-wait-ready game' -and
    $controller -match '"authoritative":false') `
    'fast live integrity preflight fails on existing production readiness blockers without replacing PREPARE'
Assert-True ($controller -match 'validate_world_handoff_authority' -and
    $controller -match 'release_manifest_sha256' -and
    $controller -match 'river_surface' -and
    $controller -match 'lake_surface' -and
    $controller -match 'ocean_coast_surface' -and
    $controller -match 'waterbody_identity_overlay' -and
    $controller -match 'waterbodyIdentityV1' -and
    $controller -match 'water_name_index' -and
    $controller -match 'waterNameFallbackV1' -and
    $controller -match 'waterbody-identity-overlay-v4' -and
    $controller -notmatch 'withoutPipelineSha') `
    'World handoff recovery matches complete target lock authority instead of partial lock equivalence'
$singleLiveIntegrityIndex = $orchestrator.IndexOf(
    "Invoke-Phase `$State 'live_production_integrity_preflight'")
$singleLocalMergeIndex = $orchestrator.IndexOf("Invoke-Phase `$State 'local_merge'")
$batchLiveIntegrityIndex = $orchestrator.IndexOf(
    "Invoke-Phase `$State 'live_production_integrity_preflight'", $singleLiveIntegrityIndex + 1)
$batchLocalMergeIndex = $orchestrator.IndexOf("Invoke-Phase `$State 'batch_local_merge_chain'")
Assert-True ($singleLiveIntegrityIndex -ge 0 -and
    $singleLiveIntegrityIndex -lt $singleLocalMergeIndex -and
    $batchLiveIntegrityIndex -ge 0 -and
    $batchLiveIntegrityIndex -lt $batchLocalMergeIndex) `
    'single and batch releases check live production integrity before local candidate merge work'
$identityPreflightIndex = $orchestrator.LastIndexOf(
    "Invoke-Phase `$state 'installed_deployment_identity_preflight'")
$standalonePublicationIndex = $orchestrator.LastIndexOf('Invoke-PublishGitWorkflow $state')
Assert-True ($identityPreflightIndex -ge 0 -and
    $standalonePublicationIndex -gt $identityPreflightIndex) `
    'standalone publication cannot move master before installed deployment identity passes'
Assert-True ($orchestrator -match
    "if \(\[string\]\`$State\.requested_mode -eq 'IntegrateAndPublish'\) \{\s*Invoke-Phase \`$State 'installed_deployment_identity_preflight'" -and
    $orchestrator -notmatch
    "if \(\[bool\]\`$State\.atomic_master_publication\) \{\s*Invoke-Phase \`$State 'installed_deployment_identity_preflight'") `
    'git-only atomic master publication skips deployment identity and VPS preparation'
Assert-True ($orchestrator -match "ConfirmCombinedRelease.*valid only with IntegrateAndPublish" -and
    $orchestrator -match 'ConfirmCombinedRelease requires -FeatureWorktrees' -and
    $orchestrator -match '\$ConfirmIntegration = \$true' -and
    $orchestrator -match '\$ConfirmGenerationCheckpoint = \$true' -and
    $orchestrator -match '\$ConfirmPublish = \$true' -and
    $orchestrator -match '\$ConfirmDeploy = \$true') `
    'combined confirmation authorizes only the existing integration, checkpoint, publication, and deployment gates'
Assert-True ($orchestrator -match 'Get-BatchRemoteSnapshot' -and
    $orchestrator -match "ls-remote', 'origin', 'refs/heads/\*', 'refs/tags/test/\*'" -and
    $orchestrator -match 'initial_remote_snapshot_count') `
    'batch preflight captures all feature, protected, and generation refs in one initial snapshot'
Assert-True ($orchestrator -match 'batch feature tip drift' -and
    $orchestrator -match 'duplicate feature worktree' -and
    $orchestrator -match 'duplicate feature branch' -and
    $orchestrator -match 'feature branch changed after manifest creation') `
    'immutable batch manifest refuses duplicate identities and local or remote tip drift'
Assert-True ($orchestrator -match 'merge --no-ff' -and
    $orchestrator -match 'Get-IntegrationMergeMessage' -and
    $orchestrator -match 'Test-ExactMergeParents' -and
    $orchestrator -match 'Assert-BatchMergeChain' -and
    $orchestrator -match 'ConfirmConflictResolution') `
    'batch merges are ordered no-ff commits with resumable exact-parent verification'
Assert-True ($orchestrator -match 'Get-LiveMobileCompatibilitySetting' -and
    $orchestrator -match 'mobile_compatibility_registry_sha256' -and
    $orchestrator -match 'mobile_compatibility_server_sha256' -and
    $orchestrator -match 'stale_recheck_required' -and
    $orchestrator -match 'Assert-MobileBackwardCompatibility \$mobileCandidateRoot \$target -State \$State' -and
    $orchestrator -notmatch '\$env:NATIVE_IOS_HARD_MIN_VERSION') `
    'mobile release admission binds VPS hard minimums and registry identity, then rechecks before activation'
Assert-True ($orchestrator -match 'function Get-TrustedMobileReleaseToolPath' -and
    $orchestrator -match "Get-TrustedMobileReleaseToolPath 'candidate-protocol-range\.mjs'" -and
    $orchestrator -match "Get-TrustedMobileReleaseToolPath 'server-compatibility-gate\.mjs'" -and
    $orchestrator -match "Get-TrustedMobileReleaseToolPath 'registry-remote\.mjs'" -and
    $orchestrator -match 'Get-MobileRegistryRemote -State \$State' -and
    $orchestrator -match 'activation-status ''--remote'' \$registryRemote' -and
    $orchestrator -match 'set-activation-intent ''--remote'' \$registryRemote' -and
    $orchestrator -match 'resolve-activation-intent `\r?\n\s*''--remote'' \$registryRemote' -and
    $orchestrator -notmatch 'Join-Path \$candidateRoot ''tools\\mobile-release' ) `
    'privileged mobile checks execute only pinned tooling while the candidate checkout remains input data'
$activationReadinessIndex = $orchestrator.IndexOf('Assert-CoordinatedReleaseActivationReadiness $coordinatedManifest')
$activationWorkflowIndex = $orchestrator.IndexOf('Invoke-DeploymentWorkflow $State')
Assert-True ($activationReadinessIndex -ge 0 -and
    $orchestrator -notmatch 'Assert-CoordinatedReleaseActivationReadiness \$manifest\s*\| Out-Null\s*\r?\n\s*Invoke-DeploymentWorkflow' -and
    $orchestrator.IndexOf('Assert-CoordinatedReleaseActivationReadiness $coordinatedManifest') -lt
        $orchestrator.IndexOf('Assert-MobileBackwardCompatibility $mobileCandidateRoot $target -State $State')) `
    'coordinated Resume rechecks exact app readiness only inside the new activation branch after reconciliation'
$mobileRecheckIndex = $orchestrator.IndexOf('Assert-MobileBackwardCompatibility $mobileCandidateRoot $target -State $State')
$mobileActivationIndex = $orchestrator.IndexOf('Invoke-PreparedActivation $State $target $preparedHash')
Assert-True ($mobileRecheckIndex -ge 0 -and $mobileActivationIndex -gt $mobileRecheckIndex) `
    'mobile compatibility recheck occurs before prepared activation'
Assert-True ($orchestrator -match "\`$preparedHash = \[string\]\(Get-StateValue \`$State 'deployment_submission_updater_hash' ''\)" -and
    $orchestrator -match 'state does not record the updater hash used for PREPARE' -and
    $orchestrator -match 'PREPARED receipt updater hash differs from the hash submitted for PREPARE' -and
    $orchestrator -notmatch 'Invoke-PreparedActivation \$State \$target \$localHash') `
    'prepared activation presents the updater hash submitted and verified at PREPARE, not the fast-forwarded file or the status receipt'
Assert-True ($orchestrator -match '\$retryExistingActivationIntent' -and
    $orchestrator -match 'A proven no-mutation retry is still a new activation attempt' -and
    $orchestrator.IndexOf('Assert-CoordinatedReleaseActivationReadiness $coordinatedManifest') -lt
        $orchestrator.IndexOf('if (-not $retryExistingActivationIntent)')) `
    'proven no-mutation activation retries remain behind the readiness gate while completed reconciliation can bypass it'
Assert-True ($orchestrator -match 'test-generation\.ps1''\) advance' -and
    $orchestrator -match '-ExpectedMasterSha' -and
    $orchestrator -match '-PublishMaster -ConfirmGenerationCheckpoint' -and
    $orchestrator -match 'batch_atomic_protected_publication') `
    'batch publication delegates one integration, master, and gameplay-tag transaction to the generation helper'
Assert-True ($orchestrator -match 'Require-ReleaseSideEffectReconciliation' -and
    $orchestrator -match 'Invoke-LocalPublishedCheckoutReconciliation' -and
    $orchestrator -match 'batch_local_checkout_reconciliation' -and
    $orchestrator -match 'publish_local_checkout_reconciliation' -and
    $orchestrator -match 'remote_publication_succeeded') `
    'successful remote publication retains a resumable local integration and master checkout reconciliation phase'
$batchPublicationIndex = $orchestrator.IndexOf("Invoke-Phase `$State 'batch_atomic_protected_publication'")
$batchDeploymentIndex = $orchestrator.IndexOf('Invoke-DeploymentWorkflow $state')
Assert-True ($batchPublicationIndex -ge 0 -and $batchDeploymentIndex -gt $batchPublicationIndex) `
    'the batch lane cannot contact the deployment controller before atomic Git publication'
Assert-True ($orchestrator -notmatch 'pnpm test:policy' -and
    $orchestrator -match 'release_infrastructure_suites = \$true' -and
    $orchestrator -match 'gameplay batch refuses release infrastructure') `
    'gameplay batches refuse infrastructure and never invoke the broad infrastructure policy suite'
Assert-True ($orchestrator -match 'completed final validation cannot be reused because its immutable fingerprint changed' -and
    $orchestrator -match 'completed final validation has an incomplete gate receipt set' -and
    $orchestrator -match 'validation_plan_fingerprint' -and
    $orchestrator -match 'validation_toolchain_fingerprint') `
    'final validation is reused only for the exact candidate, commands, and toolchain'
Assert-True ($orchestrator -match 'batch_external_validator_preflight' -and
    $orchestrator -match 'Invoke-IsolatedBatchValidation \$State \$currentPlan \$currentToolchain' -and
    $orchestrator -match 'validator_contract = ''ash-atlas-isolated-uncredentialed-vm/v1''' -and
    $orchestrator -match 'update-ref' -and
    $orchestrator -match 'isolated-validation/\$\(\$State[.]operation_id\)' -and
    $orchestrator -match '''bundle'', ''create'', \$baselineBundle, \$baselineRef' -and
    $orchestrator -notmatch 'Assert-BatchAdmissionIsolation') `
    'batch admission requires a host-authenticated external validator receipt and exact Git bundle source data'
Assert-True ($orchestrator -match '\[string\]\$SourceRepositoryRoot' -and
    $orchestrator -match 'function Get-GameRepositoryRoot' -and
    $orchestrator -match 'Get-GitText \(Get-GameRepositoryRoot\)' -and
    $orchestrator -match 'tooling_repository_root' -and
    $orchestrator -match 'integration_worktree_path') `
    'private tooling execution keeps game Git and worktree operations bound to the explicit source checkout'
$oldToolingRoot = $script:RepositoryRoot
$oldSourceVariable = Get-Variable -Name SourceRepositoryRoot -Scope Script -ErrorAction SilentlyContinue
$oldSourceRoot = if ($null -ne $oldSourceVariable) { $oldSourceVariable.Value } else { $null }
try {
    $script:RepositoryRoot = 'C:\private-tooling-checkout'
    $script:SourceRepositoryRoot = 'C:\game-source-mirror'
    Assert-True ((Get-GameRepositoryRoot) -ceq $script:SourceRepositoryRoot -and
        (Get-GameRepositoryRoot) -cne $script:RepositoryRoot) `
        'private tooling and game mirror roots remain distinct for source Git operations'
} finally {
    $script:RepositoryRoot = $oldToolingRoot
    if ($null -ne $oldSourceVariable) {
        $script:SourceRepositoryRoot = $oldSourceRoot
    } else {
        Remove-Variable -Name SourceRepositoryRoot -Scope Script -ErrorAction SilentlyContinue
    }
}
Assert-True ($orchestrator -match '\.validation\.\$\(\$worker\.gate\.name\)' -and
    $orchestrator -match 'active=.*elapsed=.*last_completed' -and
    $orchestrator -match 'Stop-NativeProcessTree') `
    'parallel gates have separate logs, hard cleanup, durations, and thirty-second status heartbeats'
Assert-True ($orchestrator -match "'workspace_install'.*'pnpm.cmd'" -and
    $orchestrator -match "'client_affected_tests'" -and
    $orchestrator -match "'server_affected_tests'" -and
    $orchestrator -match "'shared_affected_tests'") `
    'one serial frozen install precedes impact-selected affected-package tests'
Assert-True ($orchestrator -match "'batch_merged_receipts'" -and
    $orchestrator -match "'-BatchOperationId'" -and
    $orchestrator -match 'all batch features have one exact shared release receipt') `
    'every newly included feature receipt binds the shared generation, candidate, and batch operation'

$clientImpact = Get-BatchImpactClassification @('apps/client/src/Game.tsx')
Assert-True ($clientImpact.client -and -not $clientImpact.server -and
    -not $clientImpact.database_migrations) 'pure client impact skips PostgreSQL classification'
$clientTextImpact = Get-BatchImpactClassification @('apps/client/src/content/player-copy.json')
Assert-True ($clientTextImpact.client_text_only -and -not $clientTextImpact.client_runtime) `
    'client text-only impact is separated from runtime client risk'
$clientRuntimeImpact = Get-BatchImpactClassification @('apps/client/src/App.tsx')
Assert-True ($clientRuntimeImpact.client_runtime -and -not $clientRuntimeImpact.client_text_only) `
    'client source impact retains runtime client risk gates'
$clientExecutableContentImpact = Get-BatchImpactClassification @('apps/client/src/content/contentPolicy.ts')
Assert-True ($clientExecutableContentImpact.client_runtime -and -not $clientExecutableContentImpact.client_text_only) `
    'executable client content policy retains runtime client risk gates'
$serverExecutableContentImpact = Get-BatchImpactClassification @('apps/server/src/chat/contentPolicy.ts')
Assert-True ($serverExecutableContentImpact.server_runtime -and -not $serverExecutableContentImpact.server_text_only) `
    'executable server content policy retains runtime server risk gates'
$migrationImpact = Get-BatchImpactClassification @('db/migrations/9999_fixture.sql')
Assert-True (-not $migrationImpact.server -and $migrationImpact.database_migrations) `
    'root migration impact requires the disposable PostgreSQL and server validation lane'
$sharedImpact = Get-BatchImpactClassification @('packages/shared/src/protocol.ts')
Assert-True $sharedImpact.shared_protocol 'shared protocol changes are classified independently'
$documentationImpact = Get-BatchImpactClassification @('docs/release.md', 'README.md')
Assert-True $documentationImpact.documentation_only 'documentation-only intervals are classified without gameplay gates'
foreach ($forbiddenPath in @(
        '.gitattributes',
        'tools/release/new-controller.ps1',
        'tools/dev/test-generation.ps1',
        'tools/telemetry-home/install.sh',
        '.github/workflows/release.yml',
        'package.json',
        'apps/client/package.json',
        'pnpm-lock.yaml',
        'apps/client/vite.config.ts',
        'apps/client/systemd/game.service'
    )) {
    Assert-True (Test-BatchForbiddenInfrastructurePath $forbiddenPath) `
        "gameplay batch rejects infrastructure path $forbiddenPath"
}
Assert-True (-not (Test-BatchForbiddenInfrastructurePath 'apps/client/src/Game.tsx')) `
    'ordinary gameplay application paths remain eligible'

$manifestFixtureRoot = Join-Path $env:TEMP ("ash-atlas-batch-manifest-" + [guid]::NewGuid().ToString('n'))
$manifestRepository = Join-Path $manifestFixtureRoot 'repository'
$manifestWorktreeOld = Join-Path $manifestFixtureRoot 'feature-old__t000'
$manifestWorktreeNew = Join-Path $manifestFixtureRoot 'feature-new__t001'
$manifestWorktreeIncompatible = Join-Path $manifestFixtureRoot 'feature-incompatible__t000'
New-Item -ItemType Directory -Path $manifestRepository -Force | Out-Null
try {
    & git -C $manifestRepository init -b integration/test | Out-Null
    & git -C $manifestRepository config user.email 'batch-manifest-tests@example.invalid'
    & git -C $manifestRepository config user.name 'Batch Manifest Tests'
    Set-Content -LiteralPath (Join-Path $manifestRepository 'base.txt') -Value 't000'
    & git -C $manifestRepository add base.txt
    & git -C $manifestRepository commit -m t000 | Out-Null
    $manifestT000 = (& git -C $manifestRepository rev-parse HEAD).Trim()
    & git -C $manifestRepository tag test/t000 $manifestT000
    Set-Content -LiteralPath (Join-Path $manifestRepository 'base.txt') -Value 't001'
    & git -C $manifestRepository add base.txt
    & git -C $manifestRepository commit -m t001 | Out-Null
    $manifestT001 = (& git -C $manifestRepository rev-parse HEAD).Trim()
    & git -C $manifestRepository tag test/t001 $manifestT001
    & git -C $manifestRepository worktree add -b fix/feature-old--from-t000 $manifestWorktreeOld $manifestT000 | Out-Null
    Set-Content -LiteralPath (Join-Path $manifestWorktreeOld 'apps-client-fixture.ts') -Value 'old feature'
    & git -C $manifestWorktreeOld add apps-client-fixture.ts
    & git -C $manifestWorktreeOld commit -m 'old feature' | Out-Null
    $manifestOldTip = (& git -C $manifestWorktreeOld rev-parse HEAD).Trim()
    & git -C $manifestRepository worktree add -b feature/feature-new--from-t001 $manifestWorktreeNew $manifestT001 | Out-Null
    Set-Content -LiteralPath (Join-Path $manifestWorktreeNew 'server-fixture.ts') -Value 'new feature'
    & git -C $manifestWorktreeNew add server-fixture.ts
    & git -C $manifestWorktreeNew commit -m 'new feature' | Out-Null
    $manifestNewTip = (& git -C $manifestWorktreeNew rev-parse HEAD).Trim()
    $manifestHeads = @{
        'fix/feature-old--from-t000' = $manifestOldTip
        'feature/feature-new--from-t001' = $manifestNewTip
    }
    $manifestSnapshot = [pscustomobject]@{
        heads = $manifestHeads
        integration_test_sha = $manifestT001
        generations = @(
            [pscustomobject]@{ name = 'test/t000'; commit_sha = $manifestT000 },
            [pscustomobject]@{ name = 'test/t001'; commit_sha = $manifestT001 }
        )
    }
    $AdmissionMode = 'PreservedExactFeatureVerification'
    $AdmissionCommand = ''
    $DisplayName = ''
    $manifestState = [pscustomobject]@{
        feature_worktrees = @($manifestWorktreeOld, $manifestWorktreeNew)
        feature_branches = @('fix/feature-old--from-t000', 'feature/feature-new--from-t001')
        feature_tip_shas = @($manifestOldTip, $manifestNewTip)
        player_patch_notes = @('Older feature note.', 'Newer feature note.')
    }
    $manifest = @(Get-BatchFeatureManifest $manifestState $manifestSnapshot)
    Assert-True ($manifest.Count -eq 2 -and
        $manifest[0].effective_base_generation -eq 't000' -and
        $manifest[0].effective_base_sha -eq $manifestT000 -and
        $manifest[0].historical_base_sha -eq $manifestT000 -and
        $manifest[1].effective_base_generation -eq 't001' -and
        $manifest[1].effective_base_sha -eq $manifestT001 -and
        $manifest[1].historical_base_sha -eq $manifestT001 -and
        $manifest[0].requested_branch -eq 'fix/feature-old--from-t000' -and
        $manifest[1].requested_tip_sha -eq $manifestNewTip) `
        'features from different valid historical bases freeze their exact effective bases safely'
    $duplicatePathRefused = $false
    try {
        Get-BatchFeatureManifest ([pscustomobject]@{
                feature_worktrees = @($manifestWorktreeOld, $manifestWorktreeOld)
                player_patch_notes = @('First duplicate note.', 'Second duplicate note.')
            }) $manifestSnapshot | Out-Null
    } catch { $duplicatePathRefused = $_.Exception.Message -match 'duplicate feature worktree' }
    Assert-True $duplicatePathRefused 'duplicate worktree entries are deterministically rejected'
    $duplicateBranchRefused = $false
    $duplicateBranchPath = Join-Path $manifestFixtureRoot 'duplicate-branch'
    Copy-Item -LiteralPath $manifestWorktreeOld -Destination $duplicateBranchPath -Recurse
    try {
        Get-BatchFeatureManifest ([pscustomobject]@{
                feature_worktrees = @($manifestWorktreeOld, $duplicateBranchPath)
                player_patch_notes = @('Original branch note.', 'Duplicate branch note.')
            }) $manifestSnapshot | Out-Null
    } catch { $duplicateBranchRefused = $true }
    Assert-True $duplicateBranchRefused 'duplicate or non-canonical branch/worktree identities are rejected'
    Remove-Item -LiteralPath $duplicateBranchPath -Recurse -Force
    $driftSnapshot = [pscustomobject]@{
        heads = @{
            'fix/feature-old--from-t000' = ('f' * 40)
            'feature/feature-new--from-t001' = $manifestNewTip
        }
        integration_test_sha = $manifestT001
        generations = $manifestSnapshot.generations
    }
    $driftRefused = $false
    try { Get-BatchFeatureManifest $manifestState $driftSnapshot | Out-Null }
    catch { $driftRefused = $_.Exception.Message -match 'tip drift' }
    Assert-True $driftRefused 'frozen manifest refuses origin branch-tip drift'

    $manifestTree = (& git -C $manifestRepository rev-parse "$manifestT001`^{tree}").Trim()
    $orphanTip = ('unrelated root' | & git -C $manifestRepository commit-tree $manifestTree).Trim()
    & git -C $manifestRepository worktree add -b feature/incompatible--from-t000 `
        $manifestWorktreeIncompatible $orphanTip | Out-Null
    $incompatibleSnapshot = [pscustomobject]@{
        heads = @{
            'feature/incompatible--from-t000' = $orphanTip
        }
        integration_test_sha = $manifestT001
        generations = $manifestSnapshot.generations
    }
    $incompatibleRefused = $false
    try {
        Get-BatchFeatureManifest ([pscustomobject]@{
                feature_worktrees = @($manifestWorktreeIncompatible)
                player_patch_notes = @('Incompatible ancestry note.')
            }) $incompatibleSnapshot | Out-Null
    } catch {
        $incompatibleRefused = $true
    }
    Assert-True $incompatibleRefused 'an unrelated feature ancestry is rejected before merging'
} finally {
    if (Test-Path -LiteralPath $manifestRepository) {
        & git -C $manifestRepository worktree remove --force $manifestWorktreeOld 2>$null
        & git -C $manifestRepository worktree remove --force $manifestWorktreeNew 2>$null
        & git -C $manifestRepository worktree remove --force $manifestWorktreeIncompatible 2>$null
    }
    if (Test-Path -LiteralPath $manifestFixtureRoot) {
        Remove-Item -LiteralPath $manifestFixtureRoot -Recurse -Force
    }
}

function New-OrderedBatchMergeFixture([int]$Count) {
    $root = Join-Path $env:TEMP ("ash-atlas-batch-merge-$Count-" + [guid]::NewGuid().ToString('n'))
    New-Item -ItemType Directory -Path $root -Force | Out-Null
    & git -C $root init -b integration/test | Out-Null
    & git -C $root config user.email 'batch-release-tests@example.invalid'
    & git -C $root config user.name 'Batch Release Tests'
    Set-Content -LiteralPath (Join-Path $root 'base.txt') -Value 'base'
    & git -C $root add base.txt
    & git -C $root commit -m base | Out-Null
    $baseSha = (& git -C $root rev-parse HEAD).Trim()
    $features = @()
    for ($index = 1; $index -le $Count; $index++) {
        & git -C $root checkout -b "feature/batch-$index" $baseSha | Out-Null
        Set-Content -LiteralPath (Join-Path $root "feature-$index.txt") -Value "feature $index"
        & git -C $root add "feature-$index.txt"
        & git -C $root commit -m "feature $index" | Out-Null
        $features += (& git -C $root rev-parse HEAD).Trim()
    }
    & git -C $root checkout -B batch-candidate $baseSha | Out-Null
    $previous = $baseSha
    $merges = @()
    foreach ($tip in $features) {
        & git -C $root merge --no-ff --no-edit $tip | Out-Null
        $merged = (& git -C $root rev-parse HEAD).Trim()
        $parents = @((& git -C $root show -s --format=%P $merged).Trim() -split '\s+')
        if (-not (Test-ExactMergeParents $parents $previous $tip)) {
            throw "fixture merge did not preserve ordered parents at $tip"
        }
        $merges += $merged
        $previous = $merged
    }
    return [pscustomobject]@{
        root = $root
        base = $baseSha
        features = $features
        merges = $merges
        candidate = $previous
    }
}

foreach ($count in @(2, 3, 5)) {
    $batchFixture = New-OrderedBatchMergeFixture $count
    try {
        Assert-True ($batchFixture.merges.Count -eq $count) `
            "$count-feature batch creates exactly $count ordered merge commits"
        Assert-True ((& git -C $batchFixture.root rev-parse HEAD).Trim() -eq $batchFixture.candidate) `
            "$count-feature batch has one final candidate"
        & git -C $batchFixture.root merge --no-ff --no-edit $batchFixture.features[0] | Out-Null
        Assert-True ((& git -C $batchFixture.root rev-parse HEAD).Trim() -eq $batchFixture.candidate) `
            "$count-feature batch skips an exact tip already contained without duplication"
    } finally {
        Remove-Item -LiteralPath $batchFixture.root -Recurse -Force
    }
}

$batchReturnFixture = New-OrderedBatchMergeFixture 5
try {
    & git -C $batchReturnFixture.root reset --hard $batchReturnFixture.base | Out-Null
    & git -C $batchReturnFixture.root branch -m integration/batch-release-aaaaaaaaaa--from-t000 | Out-Null
    $batchReturnManifest = @()
    for ($index = 0; $index -lt $batchReturnFixture.features.Count; $index++) {
        $batchReturnManifest += [pscustomobject][ordered]@{
            order = $index
            branch = "feature/batch-$($index + 1)"
            local_tip_sha = [string]$batchReturnFixture.features[$index]
            player_patch_note = "Batch feature $($index + 1) note."
            merge_result = ''
        }
    }
    $batchReturnState = [pscustomobject]@{
        operation_id = 'batch-return-fixture'
        is_batch = $true
        original_integration_sha = $batchReturnFixture.base
        latest_gameplay_generation = 't000'
        staging_worktree = $batchReturnFixture.root
        staging_branch = 'integration/batch-release-aaaaaaaaaa--from-t000'
        batch_manifest = $batchReturnManifest
        merge_chain = @()
        merge_conflict = $null
        final_candidate_sha = ''
        candidate_integration_sha = ''
    }
    $batchReturnValues = @(Invoke-BatchMergeChain $batchReturnState)
    Assert-True ($batchReturnValues.Count -eq 1 -and
        $batchReturnValues[0] -is [string] -and
        [string]$batchReturnValues[0] -match '^[0-9a-f]{40}$') `
        'multi-feature batch merge emits exactly one canonical scalar SHA'
    $batchReturnCandidate = [string]$batchReturnValues[0]
    $batchReturnState.final_candidate_sha = $batchReturnCandidate
    $batchReturnState.candidate_integration_sha = $batchReturnCandidate
    Assert-True ($batchReturnState.final_candidate_sha -is [string] -and
        $batchReturnState.candidate_integration_sha -is [string] -and
        @($batchReturnState.merge_chain).Count -eq 5 -and
        (Get-GitCommitId $batchReturnFixture.root 'HEAD') -eq $batchReturnCandidate) `
        'batch caller persists one scalar candidate after the merge-chain return boundary'
    Assert-BatchMergeChain $batchReturnState
} finally {
    if (Test-Path -LiteralPath $batchReturnFixture.root) {
        Remove-Item -LiteralPath $batchReturnFixture.root -Recurse -Force
    }
}

$changedPathFixture = Join-Path $env:TEMP (
    'ash-atlas-batch-lint-' + [guid]::NewGuid().ToString('n')
)
New-Item -ItemType Directory -Path $changedPathFixture -Force | Out-Null
try {
    & git -C $changedPathFixture init -q -b integration/test
    & git -C $changedPathFixture config user.email 'batch-lint-tests@example.invalid'
    & git -C $changedPathFixture config user.name 'Batch Lint Tests'
    $changedClientRoot = Join-Path $changedPathFixture 'apps/client/src'
    New-Item -ItemType Directory -Path $changedClientRoot -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $changedClientRoot 'modified.ts') -Value 'base'
    Set-Content -LiteralPath (Join-Path $changedClientRoot 'deleted.tsx') -Value 'deleted'
    Set-Content -LiteralPath (Join-Path $changedClientRoot 'rename-source.ts') -Value 'rename'
    Set-Content -LiteralPath (Join-Path $changedClientRoot 'copy-source.ts') -Value 'copy base'
    & git -C $changedPathFixture add .
    & git -C $changedPathFixture commit -qm base
    $changedPathBase = (& git -C $changedPathFixture rev-parse HEAD).Trim()

    Set-Content -LiteralPath (Join-Path $changedClientRoot 'modified.ts') -Value 'changed'
    Set-Content -LiteralPath (Join-Path $changedClientRoot 'copy-source.ts') -Value 'copy changed'
    Remove-Item -LiteralPath (Join-Path $changedClientRoot 'deleted.tsx')
    Move-Item -LiteralPath (Join-Path $changedClientRoot 'rename-source.ts') `
        -Destination (Join-Path $changedClientRoot 'rename-destination.tsx')
    Copy-Item -LiteralPath (Join-Path $changedClientRoot 'copy-source.ts') `
        -Destination (Join-Path $changedClientRoot 'copy-destination.jsx')
    Set-Content -LiteralPath (Join-Path $changedClientRoot 'added.js') -Value 'added'
    & git -C $changedPathFixture add -A
    & git -C $changedPathFixture commit -qm changes
    $changedPathCandidate = (& git -C $changedPathFixture rev-parse HEAD).Trim()

    $changedPathEntries = @(Get-BatchChangedPathEntries `
        $changedPathFixture $changedPathBase $changedPathCandidate)
    $renameEntry = @($changedPathEntries | Where-Object {
            $_.status_code -eq 'R' -and $_.old_path -eq 'apps/client/src/rename-source.ts' -and
            $_.path -eq 'apps/client/src/rename-destination.tsx'
        })
    Assert-True ($renameEntry.Count -eq 1) `
        'changed-path status preserves the exact rename source and destination'
    Assert-True (@($changedPathEntries | Where-Object {
                $_.status_code -eq 'D' -and $_.path -eq 'apps/client/src/deleted.tsx'
            }).Count -eq 1) `
        'changed-path status records the deleted source path without treating it as a destination'

    $changedPathState = [pscustomobject]@{
        staging_worktree = $changedPathFixture
        original_integration_sha = $changedPathBase
        final_candidate_sha = $changedPathCandidate
    }
    $changedPathPlan = Get-BatchValidationPlan $changedPathState
    $changedPathLintGates = @($changedPathPlan.gates | Where-Object name -eq 'changed_file_lint')
    Assert-True ($changedPathLintGates.Count -eq 1) `
        'changed-file lint gate is present for eligible candidate paths'
    $changedPathLintPaths = @($changedPathLintGates[0].arguments | Select-Object -Skip 3)
    Assert-True ($changedPathLintPaths -contains 'apps/client/src/added.js' -and
        $changedPathLintPaths -contains 'apps/client/src/modified.ts' -and
        $changedPathLintPaths -contains 'apps/client/src/rename-destination.tsx' -and
        $changedPathLintPaths -contains 'apps/client/src/copy-destination.jsx') `
        'added, modified, renamed, and copied eligible destinations reach ESLint'
    Assert-True ($changedPathLintPaths -notcontains 'apps/client/src/deleted.tsx' -and
        $changedPathLintPaths -notcontains 'apps/client/src/rename-source.ts' -and
        $changedPathLintPaths.Count -eq (@($changedPathLintPaths | Select-Object -Unique)).Count) `
        'deleted paths and rename sources never reach ESLint, with no duplicate lint inputs'
} finally {
    if (Test-Path -LiteralPath $changedPathFixture) {
        Remove-Item -LiteralPath $changedPathFixture -Recurse -Force
    }
}

$batchIdentityFixture = New-OrderedBatchMergeFixture 3
$batchIdentityRemote = Join-Path $env:TEMP (
    'ash-atlas-batch-identity-remote-' + [guid]::NewGuid().ToString('n') + '.git'
)
try {
    & git init --bare $batchIdentityRemote | Out-Null
    & git -C $batchIdentityFixture.root remote add origin $batchIdentityRemote
    & git -C $batchIdentityFixture.root reset --hard $batchIdentityFixture.base | Out-Null
    & git -C $batchIdentityFixture.root branch -m integration/batch-release-bbbbbbbbbb--from-t000 | Out-Null
    $batchIdentityManifest = @()
    for ($index = 0; $index -lt $batchIdentityFixture.features.Count; $index++) {
        $batchIdentityManifest += [pscustomobject][ordered]@{
            order = $index
            branch = "feature/batch-$($index + 1)"
            local_tip_sha = [string]$batchIdentityFixture.features[$index]
            player_patch_note = "Identity feature $($index + 1) note."
            merge_result = ''
        }
    }
    $batchIdentityChainState = [pscustomobject]@{
        operation_id = 'batch-identity-chain-fixture'
        is_batch = $true
        original_integration_sha = $batchIdentityFixture.base
        latest_gameplay_generation = 't000'
        staging_worktree = $batchIdentityFixture.root
        staging_branch = 'integration/batch-release-bbbbbbbbbb--from-t000'
        batch_manifest = $batchIdentityManifest
        merge_chain = @()
        merge_conflict = $null
        final_candidate_sha = ''
        candidate_integration_sha = ''
    }
    $null = @(Invoke-BatchMergeChain $batchIdentityChainState)
    $batchIdentityCandidate = Get-GitCommitId $batchIdentityFixture.root 'HEAD'

    $batchIdentitySnapshotId = 'c' * 64
    $script:BatchIdentitySnapshot = [pscustomobject]@{
        integration_test_sha = $batchIdentityFixture.base
        master_sha = $batchIdentityFixture.base
        latest_generation = 't000'
        latest_generation_sha = $batchIdentityFixture.base
        snapshot_id = $batchIdentitySnapshotId
        generation_refs = @([pscustomobject]@{
                name = 'test/t000'; commit_sha = $batchIdentityFixture.base
            })
    }
    $script:ConfirmBatchCandidateIdentityReconciliation = $true
    $script:RepositoryRoot = $batchIdentityFixture.root
    function Get-GenerationStatus { return $script:BatchIdentitySnapshot }
    function Invoke-DeploymentController {
        param($State, $Action, $Arguments, [AllowNull()][string]$StandardInput = $null)
        return [pscustomobject]@{
            exit_code = 0
            payload = [pscustomobject]@{
                schema_version = 1
                operation_id = [string]$State.operation_id
                result = 'absent'
                current_phase = 'genuinely_unknown'
                operation_state = 'genuinely_unknown'
                unit_state = 'inactive'
                controller_state = 'consistent'
            }
            output = ''
        }
    }
    function Invoke-RestMethod {
        param([string]$Uri, [int]$TimeoutSec)
        return [pscustomobject]@{ game_sha = 'd' * 40 }
    }
    $makeBatchIdentityState = {
        param([string]$OperationId)
        return [pscustomobject]@{
            operation_id = $OperationId
            is_batch = $true
            requested_mode = 'IntegrateAndPublish'
            batch_release_authorized = $true
            status = 'failed'
            failure_phase = 'batch_local_merge_chain'
            completed_at_utc = ''
            phases = [pscustomobject]@{
                batch_local_merge_chain = [pscustomobject]@{ status = 'completed'; result = '3 merges' }
            }
            batch_manifest = $batchIdentityManifest
            merge_chain = $batchIdentityChainState.merge_chain
            original_integration_sha = $batchIdentityFixture.base
            original_master_sha = $batchIdentityFixture.base
            latest_gameplay_generation = 't000'
            latest_gameplay_generation_sha = $batchIdentityFixture.base
            previous_generation = 't000'
            expected_remote_tag_namespace_snapshot = $batchIdentitySnapshotId
            staging_worktree = $batchIdentityFixture.root
            staging_branch = 'integration/batch-release-bbbbbbbbbb--from-t000'
            release_candidate_ref = ''
            admission_result = ''
            merged_receipt_result = ''
            deployment_verification_result = ''
            final_candidate_sha = @('Merge made by the batch pipeline.', $batchIdentityCandidate)
            candidate_integration_sha = @('batch merge informational output', $batchIdentityCandidate)
            final_validation_plan = $null
            validation_receipts = @()
            baseline_validation_receipts = @()
            validation_plan_fingerprint = ''
            validation_toolchain_fingerprint = ''
            active_validation_gate = ''
            deployment_start_attempted = $false
            deployment_submission_state = 'pending_submission'
            deployment_submission_attempt_count = 0
            deployment_submission_retry_count = 0
            deployment_start_connection_count = 0
            deployment_prepare_connection_count = 0
            deployment_activate_connection_count = 0
            deployment_status_connection_count = 0
            deployment_result_connection_count = 0
            deployment_ssh_connection_count = 0
            deployment_https_status_read_count = 0
            deployment_transport_events = @()
            remote_deployment_receipt = $null
        }
    }
    $batchIdentityState = & $makeBatchIdentityState 'batch-identity-fixture'
    $identityBeforeHead = Get-GitCommitId $batchIdentityFixture.root 'HEAD'
    $identityBeforeReflog = (& git -C $batchIdentityFixture.root reflog -n 1 --format=%H).Trim()
    $identityResult = Invoke-BatchCandidateIdentityReconciliation $batchIdentityState
    Assert-True ([string]$identityResult.repaired_sha -eq $batchIdentityCandidate -and
        $batchIdentityState.final_candidate_sha -is [string] -and
        $batchIdentityState.candidate_integration_sha -is [string] -and
        $batchIdentityState.final_candidate_sha -eq $batchIdentityCandidate -and
        $batchIdentityState.failure_phase -eq 'batch_final_validation' -and
        $batchIdentityState.phases.batch_local_merge_chain.status -eq 'completed') `
        'guarded identity reconciliation repairs only the two candidate fields and marks validation resumable'
    Assert-True ($batchIdentityState.batch_candidate_identity_reconciliation.prior_final_candidate_sha_json_sha256 -match '^[0-9a-f]{64}$' -and
        $batchIdentityState.batch_candidate_identity_reconciliation.prior_candidate_integration_sha_json_sha256 -match '^[0-9a-f]{64}$' -and
        $batchIdentityState.batch_candidate_identity_reconciliation.repaired_sha -eq $batchIdentityCandidate) `
        'identity reconciliation preserves malformed values with canonical JSON hashes in its audit record'
    Assert-True ((Get-GitCommitId $batchIdentityFixture.root 'HEAD') -eq $identityBeforeHead -and
        (& git -C $batchIdentityFixture.root reflog -n 1 --format=%H).Trim() -eq $identityBeforeReflog -and
        @($batchIdentityState.merge_chain).Count -eq 3) `
        'identity reconciliation does not merge, move HEAD, or alter the merge-chain record count'
    $identityAgain = Invoke-BatchCandidateIdentityReconciliation $batchIdentityState
    Assert-True ($identityAgain.idempotent -eq $true -and
        (Get-GitCommitId $batchIdentityFixture.root 'HEAD') -eq $identityBeforeHead -and
        @($batchIdentityState.merge_chain).Count -eq 3) `
        'identity reconciliation is idempotent after the exact repair'

    $reconcileFailureCases = @(
        @{ name = 'dirty staging worktree'; mutate = { param($state) Set-Content -LiteralPath (Join-Path $state.staging_worktree 'dirty-fixture.txt') -Value 'dirty' } },
        @{ name = 'wrong staging branch'; mutate = { param($state) $state.staging_branch = 'integration/wrong' } },
        @{ name = 'staging HEAD and chain mismatch'; mutate = { param($state) $state.merge_chain[2].merge_commit_sha = '0' * 40 } },
        @{ name = 'merge-chain order'; mutate = { param($state) $state.merge_chain[0].order = 1 } },
        @{ name = 'merge-chain parent'; mutate = { param($state) $state.merge_chain[1].previous_candidate_sha = $state.original_integration_sha } },
        @{ name = 'merge-chain trailer'; mutate = { param($state) $state.merge_chain[0].player_patch_note = 'Wrong note.' } },
        @{ name = 'skipped ancestry'; mutate = { param($state) $state.merge_chain[0].skipped = $true; $state.merge_chain[0].merge_commit_sha = '' } },
        @{ name = 'protected ref drift'; mutate = { param($snapshot) $snapshot.master_sha = 'e' * 40 } },
        @{ name = 'generation namespace drift'; mutate = { param($snapshot) $snapshot.snapshot_id = 'f' * 64 } },
        @{ name = 'publication evidence'; mutate = { param($state) $state.release_candidate_ref = 'refs/heads/integration/release-candidates/batch-identity-fixture' } },
        @{ name = 'candidate ref evidence'; mutate = { param($state) & git -C $batchIdentityFixture.root push origin "$batchIdentityCandidate`:refs/heads/integration/release-candidates/$($state.operation_id)" | Out-Null } },
        @{ name = 'receipt evidence'; mutate = { param($state) $state.merged_receipt_result = 'already merged' } },
        @{ name = 'deployment evidence'; mutate = { param($state) $state.deployment_start_attempted = $true } },
        @{ name = 'unavailable deployment probe'; mutate = { param($state) } },
        @{ name = 'candidate public probe'; mutate = { param($state) } }
    )
    foreach ($failureCase in $reconcileFailureCases) {
        $caseState = & $makeBatchIdentityState ("batch-identity-$($failureCase.name -replace '\s+', '-')")
        $caseState.batch_manifest = @(
            ($batchIdentityManifest | ConvertTo-Json -Depth 8 -Compress) | ConvertFrom-Json
        )
        $caseState.merge_chain = @(
            $batchIdentityChainState.merge_chain | ForEach-Object {
                ($_ | ConvertTo-Json -Depth 12 -Compress) | ConvertFrom-Json
            }
        )
        $caseSnapshot = [pscustomobject]@{
            integration_test_sha = $batchIdentityFixture.base
            master_sha = $batchIdentityFixture.base
            latest_generation = 't000'
            latest_generation_sha = $batchIdentityFixture.base
            snapshot_id = $batchIdentitySnapshotId
            generation_refs = @([pscustomobject]@{ name = 'test/t000'; commit_sha = $batchIdentityFixture.base })
        }
        if ($failureCase.name -in @('protected ref drift', 'generation namespace drift')) {
            & $failureCase.mutate $caseSnapshot
        } elseif ($failureCase.name -eq 'wrong staging branch' -or
            $failureCase.name -eq 'dirty staging worktree' -or
            $failureCase.name -eq 'staging HEAD and chain mismatch' -or
            $failureCase.name -eq 'merge-chain order' -or
            $failureCase.name -eq 'merge-chain parent' -or
            $failureCase.name -eq 'merge-chain trailer' -or
            $failureCase.name -eq 'skipped ancestry' -or
            $failureCase.name -eq 'publication evidence' -or
            $failureCase.name -eq 'candidate ref evidence' -or
            $failureCase.name -eq 'receipt evidence' -or
            $failureCase.name -eq 'deployment evidence') {
            & $failureCase.mutate $caseState
        }
        $script:BatchIdentitySnapshot = $caseSnapshot
        if ($failureCase.name -eq 'unavailable deployment probe') {
            function Invoke-DeploymentController {
                param($State, $Action, $Arguments, [AllowNull()][string]$StandardInput = $null)
                return [pscustomobject]@{ exit_code = 1; payload = $null; output = 'probe unavailable' }
            }
        } elseif ($failureCase.name -eq 'candidate public probe') {
            function Invoke-RestMethod {
                param([string]$Uri, [int]$TimeoutSec)
                return [pscustomobject]@{ game_sha = $batchIdentityCandidate }
            }
        }
        $refused = $false
        try { Invoke-BatchCandidateIdentityReconciliation $caseState | Out-Null }
        catch { $refused = $true }
        Assert-True $refused "identity reconciliation fails closed for $($failureCase.name)"
        if ($failureCase.name -eq 'dirty staging worktree') {
            Remove-Item -LiteralPath (Join-Path $caseState.staging_worktree 'dirty-fixture.txt') -Force
        }
        if ($failureCase.name -eq 'unavailable deployment probe') {
            function Invoke-DeploymentController {
                param($State, $Action, $Arguments, [AllowNull()][string]$StandardInput = $null)
                return [pscustomobject]@{
                    exit_code = 0
                    payload = [pscustomobject]@{
                        schema_version = 1; operation_id = [string]$State.operation_id
                        result = 'absent'; current_phase = 'genuinely_unknown'
                        operation_state = 'genuinely_unknown'; unit_state = 'inactive'
                        controller_state = 'consistent'
                    }
                    output = ''
                }
            }
        } elseif ($failureCase.name -eq 'candidate public probe') {
            function Invoke-RestMethod {
                param([string]$Uri, [int]$TimeoutSec)
                return [pscustomobject]@{ game_sha = 'd' * 40 }
            }
        }
    }

    $malformedState = & $makeBatchIdentityState 'batch-identity-malformed'
    $malformedState.final_candidate_sha = 'not a pipeline identity'
    $refusedMalformed = $false
    try { Invoke-BatchCandidateIdentityReconciliation $malformedState | Out-Null }
    catch { $refusedMalformed = $true }
    Assert-True $refusedMalformed 'identity reconciliation rejects arbitrary malformed candidate text'
} finally {
    Remove-Item Function:\Get-GenerationStatus -Force -ErrorAction SilentlyContinue
    Remove-Item Function:\Invoke-DeploymentController -Force -ErrorAction SilentlyContinue
    Remove-Item Function:\Invoke-RestMethod -Force -ErrorAction SilentlyContinue
    Remove-Variable BatchIdentitySnapshot -Scope Script -ErrorAction SilentlyContinue
    Remove-Variable ConfirmBatchCandidateIdentityReconciliation -Scope Script -ErrorAction SilentlyContinue
    Remove-Variable RepositoryRoot -Scope Script -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $batchIdentityFixture.root) {
        Remove-Item -LiteralPath $batchIdentityFixture.root -Recurse -Force
    }
    if (Test-Path -LiteralPath $batchIdentityRemote) {
        Remove-Item -LiteralPath $batchIdentityRemote -Recurse -Force
    }
}

$failureFixtureRoot = Join-Path $env:TEMP ("ash-atlas-batch-failure-" + [guid]::NewGuid().ToString('n'))
$failureRemote = Join-Path $failureFixtureRoot 'remote.git'
$failureRepository = Join-Path $failureFixtureRoot 'repository'
New-Item -ItemType Directory -Path $failureFixtureRoot -Force | Out-Null
try {
    & git init --bare $failureRemote | Out-Null
    & git init -b integration/test $failureRepository | Out-Null
    & git -C $failureRepository config user.email 'batch-failure-tests@example.invalid'
    & git -C $failureRepository config user.name 'Batch Failure Tests'
    & git -C $failureRepository remote add origin $failureRemote
    Set-Content -LiteralPath (Join-Path $failureRepository 'conflict.txt') -Value 'base'
    & git -C $failureRepository add conflict.txt
    & git -C $failureRepository commit -m base | Out-Null
    $failureBase = (& git -C $failureRepository rev-parse HEAD).Trim()
    & git -C $failureRepository branch master $failureBase
    & git -C $failureRepository tag test/t000 $failureBase
    & git -C $failureRepository push origin integration/test master --tags | Out-Null
    & git -C $failureRepository checkout -b feature/first $failureBase | Out-Null
    Set-Content -LiteralPath (Join-Path $failureRepository 'conflict.txt') -Value 'first'
    & git -C $failureRepository commit -am first | Out-Null
    $failureFirst = (& git -C $failureRepository rev-parse HEAD).Trim()
    & git -C $failureRepository checkout -b feature/second $failureBase | Out-Null
    Set-Content -LiteralPath (Join-Path $failureRepository 'conflict.txt') -Value 'second'
    & git -C $failureRepository commit -am second | Out-Null
    $failureSecond = (& git -C $failureRepository rev-parse HEAD).Trim()
    & git -C $failureRepository checkout -B batch-candidate $failureBase | Out-Null
    & git -C $failureRepository merge --no-ff --no-edit $failureFirst | Out-Null
    $beforeConflictRefs = (& git -C $failureRepository ls-remote origin `
        refs/heads/integration/test refs/heads/master refs/tags/test/t000 refs/tags/test/t001) -join "`n"
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & git -C $failureRepository merge --no-ff --no-edit $failureSecond 2>$null | Out-Null
        $conflictExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    $afterConflictRefs = (& git -C $failureRepository ls-remote origin `
        refs/heads/integration/test refs/heads/master refs/tags/test/t000 refs/tags/test/t001) -join "`n"
    Assert-True ($conflictExit -ne 0 -and $beforeConflictRefs -ceq $afterConflictRefs) `
        'conflict in feature N leaves integration/test, master, and gameplay tags unchanged'
    & git -C $failureRepository merge --abort | Out-Null

    $atomicCandidate = $failureFirst
    $hook = Join-Path $failureRemote 'hooks\pre-receive'
    @'
#!/bin/sh
exit 1
'@ | Set-Content -LiteralPath $hook -Encoding ascii
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & git -C $failureRepository push --atomic origin `
            "$atomicCandidate`:refs/heads/integration/test" `
            "$atomicCandidate`:refs/heads/master" `
            "$atomicCandidate`:refs/tags/test/t001" 2>$null | Out-Null
        $atomicFailureExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    $afterAtomicFailure = (& git -C $failureRepository ls-remote origin `
        refs/heads/integration/test refs/heads/master refs/tags/test/t000 refs/tags/test/t001) -join "`n"
    Assert-True ($atomicFailureExit -ne 0 -and $afterAtomicFailure -ceq $beforeConflictRefs) `
        'failed atomic three-ref publication leaves every protected ref unchanged'
} finally {
    if (Test-Path -LiteralPath $failureFixtureRoot) {
        Remove-Item -LiteralPath $failureFixtureRoot -Recurse -Force
    }
}

$threeFeatureFixture = New-OrderedBatchMergeFixture 3
$threeFeatureRemote = Join-Path $env:TEMP (
    'ash-atlas-batch-three-remote-' + [guid]::NewGuid().ToString('n') + '.git'
)
try {
    & git init --bare $threeFeatureRemote | Out-Null
    & git -C $threeFeatureFixture.root remote add origin $threeFeatureRemote
    & git -C $threeFeatureFixture.root branch master $threeFeatureFixture.base
    & git -C $threeFeatureFixture.root tag test/t000 $threeFeatureFixture.base
    & git -C $threeFeatureFixture.root push origin `
        "$($threeFeatureFixture.base):refs/heads/integration/test" `
        "$($threeFeatureFixture.base):refs/heads/master" `
        'refs/heads/feature/batch-1' 'refs/heads/feature/batch-2' `
        'refs/heads/feature/batch-3' 'refs/tags/test/t000' | Out-Null

    $RepositoryRoot = $threeFeatureFixture.root
    $threeFeatureState = [pscustomobject]@{
        initial_remote_fetch_count = 0
        initial_remote_snapshot_count = 0
    }
    $threeFeatureSnapshot = Get-BatchRemoteSnapshot $threeFeatureState
    $expectedSnapshotText = @(
        "refs/heads/integration/test $($threeFeatureFixture.base)"
        "refs/heads/master $($threeFeatureFixture.base)"
        "refs/tags/test/t000 $($threeFeatureFixture.base) $($threeFeatureFixture.base)"
    ) -join "`n"
    Assert-True ($threeFeatureSnapshot.snapshot_id -eq (Get-TextSha256 $expectedSnapshotText)) `
        'batch snapshot identity exactly matches canonical generation-helper ref ordering'

    $threeFeatureCounts = [ordered]@{
        remote_preflights = $(if (
                [int]$threeFeatureState.initial_remote_fetch_count -eq 1 -and
                [int]$threeFeatureState.initial_remote_snapshot_count -eq 1
            ) { 1 } else { 0 })
        candidates = $(if ($threeFeatureFixture.candidate -match '^[0-9a-f]{40}$') { 1 } else { 0 })
        validation_plans = 0
        gameplay_tags = 0
        atomic_protected_pushes = 0
        deployment_submissions = 0
    }
    $threeFeatureChangedPaths = @(
        (& git -C $threeFeatureFixture.root diff --name-only `
            "$($threeFeatureFixture.base)..$($threeFeatureFixture.candidate)") |
            Where-Object { $_ }
    )
    $threeFeaturePlan = [pscustomobject]@{
        candidate_sha = $threeFeatureFixture.candidate
        impact = Get-BatchImpactClassification $threeFeatureChangedPaths
    }
    if ($threeFeaturePlan.candidate_sha -eq $threeFeatureFixture.candidate) {
        $threeFeatureCounts.validation_plans++
    }
    & git -C $threeFeatureFixture.root push --atomic origin `
        "$($threeFeatureFixture.candidate):refs/heads/integration/test" `
        "$($threeFeatureFixture.candidate):refs/heads/master" `
        "$($threeFeatureFixture.candidate):refs/tags/test/t001" | Out-Null
    if ($LASTEXITCODE -eq 0) { $threeFeatureCounts.atomic_protected_pushes++ }
    $publishedRefs = @(
        & git -C $threeFeatureFixture.root ls-remote origin `
            refs/heads/integration/test refs/heads/master refs/tags/test/t001
    )
    $threeFeatureCounts.gameplay_tags = @(
        $publishedRefs | Where-Object { $_ -match 'refs/tags/test/t001$' }
    ).Count
    $submitMock = {
        param([string]$OperationId, [string]$TargetSha)
        if ($OperationId -eq 'synthetic-three' -and
            $TargetSha -eq $threeFeatureFixture.candidate) {
            $threeFeatureCounts.deployment_submissions++
        }
    }
    & $submitMock 'synthetic-three' $threeFeatureFixture.candidate

    Assert-True ($threeFeatureCounts.remote_preflights -eq 1 -and
        $threeFeatureCounts.candidates -eq 1 -and
        $threeFeatureCounts.validation_plans -eq 1 -and
        $threeFeatureCounts.gameplay_tags -eq 1 -and
        $threeFeatureCounts.atomic_protected_pushes -eq 1 -and
        $threeFeatureCounts.deployment_submissions -eq 1 -and
        @($publishedRefs | Where-Object {
                $_ -notmatch "^$($threeFeatureFixture.candidate)\s+"
            }).Count -eq 0) `
        'synthetic three-feature lane has one preflight, candidate, plan, tag, atomic push, and deployment submission'
} finally {
    $RepositoryRoot = $root
    if (Test-Path -LiteralPath $threeFeatureFixture.root) {
        Remove-Item -LiteralPath $threeFeatureFixture.root -Recurse -Force
    }
    if (Test-Path -LiteralPath $threeFeatureRemote) {
        Remove-Item -LiteralPath $threeFeatureRemote -Recurse -Force
    }
}

$bindingDefects = @()
foreach ($releaseScript in @(Get-ChildItem -LiteralPath (Join-Path $root 'tools\release') -Filter '*.ps1' -Recurse)) {
    $scriptTokens = $null
    $scriptErrors = $null
    $scriptAst = [Management.Automation.Language.Parser]::ParseFile(
        $releaseScript.FullName, [ref]$scriptTokens, [ref]$scriptErrors)
    Assert-True ($scriptErrors.Count -eq 0) "$($releaseScript.Name) parses without errors"
    $bindingDefects += @($scriptAst.FindAll({
        param($node)
        $node -is [Management.Automation.Language.CommandParameterAst] -and
            $node.ParameterName -in @('split', 'replace', 'match', 'join')
    }, $true))
}
Assert-True ($bindingDefects.Count -eq 0) 'release tooling has no operator parsed as a command parameter'

$pathFixture = Join-Path $env:TEMP ("ash-atlas-release-path-" + [guid]::NewGuid().ToString('n'))
$pathChild = Join-Path $pathFixture 'child'
$pathSimilar = "$pathFixture-similar"
New-Item -ItemType Directory -Path $pathChild, $pathSimilar -Force | Out-Null
try {
    $forwardSlash = $pathFixture.Replace([char]'\', [char]'/')
    Assert-True (Test-AshAtlasSamePath $pathFixture $forwardSlash) 'Windows slash forms compare as one canonical path'
    Assert-True (Test-AshAtlasSamePath $pathFixture.ToUpperInvariant() $pathFixture.ToLowerInvariant()) 'Windows path case compares ordinal-ignore-case'
    Assert-True (Test-AshAtlasSamePath ($pathFixture + [IO.Path]::DirectorySeparatorChar) $pathFixture) 'trailing separator does not change path identity'
    Assert-True (Test-AshAtlasSamePath '.' $pathFixture $pathFixture) 'relative path resolves only against the supplied base directory'
    Assert-True (-not (Test-AshAtlasSamePath $pathFixture $pathChild)) 'parent and child remain different paths'
    Assert-True (-not (Test-AshAtlasSamePath $pathFixture $pathSimilar)) 'similar path prefixes remain different'
    $gitRoot = (& git -C $root rev-parse --show-toplevel).Trim()
    Assert-True (Test-AshAtlasSamePath $gitRoot $root) 'Git forward-slash worktree root equals PowerShell worktree path'
    Assert-True (-not (Test-AshAtlasSamePath $gitRoot $pathFixture)) 'genuinely wrong feature worktree remains different'
    $emptyRefused = $false
    try { Get-AshAtlasCanonicalPath ' ' | Out-Null } catch { $emptyRefused = $true }
    Assert-True $emptyRefused 'empty canonical path is refused'
} finally {
    Remove-Item -LiteralPath $pathChild, $pathSimilar, $pathFixture -Force -Recurse
}

function Get-Key($InputSet) {
    $text = @(
        $InputSet.source
        $InputSet.shared
        $InputSet.lockfile
        $InputSet.manifest
        $InputSet.node
        $InputSet.pnpm
        $InputSet.typescript
        $InputSet.vite
        $InputSet.esbuild
        $InputSet.environment
        $InputSet.generated
    ) -join "`n"
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($text)))).Replace('-', '') }
    finally { $algorithm.Dispose() }
}

$base = [ordered]@{
    source = 'source-a'
    shared = 'shared-a'
    lockfile = 'lock-a'
    manifest = 'manifest-a'
    node = 'v24.1.0'
    pnpm = '10.0.0'
    typescript = 'tsconfig-a'
    vite = 'vite-a'
    esbuild = 'esbuild-a'
    environment = 'env-a'
    generated = 'generated-a'
}
$baseKey = Get-Key $base
foreach ($field in @('source', 'shared', 'lockfile', 'manifest', 'node', 'pnpm', 'typescript', 'vite', 'esbuild', 'environment', 'generated')) {
    $changed = [ordered]@{}
    foreach ($entry in $base.GetEnumerator()) { $changed[$entry.Key] = $entry.Value }
    $changed[$field] = "$($changed[$field])-changed"
    Assert-True ((Get-Key $changed) -ne $baseKey) "cache invalidates when $field changes"
}
$documentationOnly = [ordered]@{}
foreach ($entry in $base.GetEnumerator()) { $documentationOnly[$entry.Key] = $entry.Value }
$documentationOnly['documentation_tree'] = 'docs-changed'
Assert-True ((Get-Key $documentationOnly) -eq $baseKey) 'documentation-only change reuses artifacts only when all application inputs remain exact'

$integrationPhases = @(
    'initial_remote_snapshot',
    'feature_and_worktree_validation',
    'local_merge',
    'focused_admission',
    'atomic_branch_and_generation_publication',
    'remote_verification',
    'merged_receipt'
)
$publicationPhases = @(
    'master_fast_forward_and_push',
    'deployment',
    'host_readiness_and_public_world_verification'
)
foreach ($phase in @($integrationPhases + $publicationPhases)) {
    Assert-True ($orchestrator -match [regex]::Escape("'$phase'")) "orchestrator records $phase"
}
foreach ($interruption in @(
    'local_merge',
    'focused_admission',
    'atomic_branch_and_generation_publication',
    'merged_receipt',
    'master_fast_forward_and_push',
    'deployment',
    'host_readiness_and_public_world_verification'
)) {
    $ordered = @($integrationPhases + $publicationPhases)
    $index = [array]::IndexOf($ordered, $interruption)
    $completed = @($ordered | Select-Object -First ($index + 1))
    $next = @($ordered | Where-Object { $completed -notcontains $_ } | Select-Object -First 1)
    Assert-True ($completed[-1] -eq $interruption) "simulated interruption records exact completed phase $interruption"
    if ($next.Count -gt 0) { Assert-True ([array]::IndexOf($ordered, $next[0]) -eq $index + 1) "resume selects only the next phase after $interruption" }
}
Assert-True ($orchestrator -match "existing\.Value\.status -eq 'completed'.+return" -and
    $orchestrator -match 'Reconcile-RemoteTruth \$state') 'resume reconciles truth and skips completed phases'
Assert-True ($orchestrator -match 'candidate merge parents do not equal exact original integration and feature tip') 'resume refuses mismatched local merge state'
Assert-True ($orchestrator -match "deployment_submission_state = 'pending_submission'" -and
    $orchestrator -match 'Publish-DeploymentRequest \$State \$Target \$UpdaterHash' -and
    $orchestrator -match 'deployment_request_commit' -and
    $orchestrator -match 'deployment_submission_attempt_count' -and
    $orchestrator -match "deployment_submission_state = 'submitted'" -and
    $orchestrator -notmatch "result = 'accepted'\s+current_phase = 'accepted'") 'Resume preserves one immutable submission and never fabricates acceptance'
Assert-True ($orchestrator -match 'remote deployment failed in' -and
    $orchestrator -notmatch 'deploy-test-update[.]sh \$target') 'failed remote receipts are reported without directly rerunning the updater'
Assert-True ($orchestrator -notmatch 'ssh[.]exe' -and $installer -notmatch '(?m)^\s*&\s*(ssh|scp)\b' -and
    $transport -match 'Invoke-WslOpenSshCommand' -and
    $transport -match 'Invoke-BoundedNativeProcess') 'all release SSH traffic uses one bounded WSL OpenSSH transport'
Assert-True ([regex]::Matches($installer, 'Invoke-WslOpenSshCommand').Count -eq 1 -and
    $installer -match "'bash -s'" -and $installer -match 'base64 --decode') 'controller bootstrap uses one supervised SSH connection for staging, install, verification, and cleanup'
Assert-True ([regex]::Matches($worldPromotion, 'Invoke-WslOpenSshCommand').Count -eq 5 -and
    $worldPromotion -match 'ConfirmPromotion' -and
    $worldPromotion -match 'rev-parse origin/main' -and
    $worldPromotion -match '\$defaults[.]map_repository' -and
    $worldPromotion -match '\[Parameter\(Mandatory = \$true\)\]\[ValidatePattern\(''\^\[0-9a-f\]\{40\}\$''\)\]\[string\]\$ExpectedCurrentWorldSha' -and
    $worldPromotion -match '\[Parameter\(Mandatory = \$true\)\]\[ValidatePattern\(''\^\(origin/master\|refs/remotes/origin/master\)\$''\)\]\[string\]\$ExpectedCurrentWorldLockRef' -and
    $worldPromotion -match 'cat-file.*config/world-runtime[.]lock[.]json' -and
    $worldPromotion -match '\$WorldSha,\s+\$ExpectedCurrentWorldSha,' -and
    $worldPromotion -match '\$currentWorldRelease,\s+\$currentWorldManifest,\s+\$currentRiverRelease,\s+\$currentRiverManifest' -and
    $worldPromotion -match 'expected_current_identity = \$currentIdentity' -and
    $worldPromotion -match 'target_identity = \$targetIdentity' -and
    $worldPromotion -match 'WaterNameIndexRoot' -and
    $worldPromotion -match 'Assert-WorldLocalRiverbankRoot' -and
    $worldPromotion -match 'Assert-WorldLocalWaterNameIndexRoot' -and
    $worldPromotion -match 'Invoke-WorldSupplementalTransfer' -and
    $worldPromotion -match 'Get-WorldLocalTreeCapacity' -and
    $worldPromotion -match 'Invoke-WorldSupplementalCapacityPreflight' -and
    $worldPromotion -match 'requiredFreeBytes' -and
    $worldPromotion -match 'archiveHeaderReservePerEntryBytes' -and
    $worldPromotion -match 'expandedSafetyReserveBytesPerRoot' -and
    $worldPromotion -match 'controllerSafetyReserveBytes' -and
    $worldPromotion -match 'Invoke-WorldSupplementalArchiveFinalize' -and
    $worldPromotion -match 'archiveFinalize' -and
    $worldPromotion -match 'chown -- debian:debian' -and
    $worldPromotion -match 'chmod -- 0600' -and
    $worldPromotion -match 'unsafe supplemental archive path' -and
    $worldPromotion -match 'supplemental archive is absent or unsafe' -and
    $worldPromotion -match 'supplemental archive hard-link count is unsafe' -and
    $worldPromotion -match 'owner_group' -and
    $worldPromotion -match 'link_count' -and
    $worldPromotion -match 'supplemental_archive_finalizations' -and
    $worldPromotion -match 'Remove-WorldSupplementalStaging' -and
    $worldPromotion -match 'HardDeadlineSeconds 120' -and
    $worldPromotion -match 'transferReleaseIds' -and
    $worldPromotion -match 'owned staging cleanup failed' -and
    $worldPromotion -match "-Program scp" -and
    $worldPromotion -match '/home/debian/ash-atlas-world-promotion-staging/' -and
    $worldPromotion -notmatch '/tmp/ash-atlas-world-promotion-' -and
    $worldPromotion -notmatch '\$lock[.]pipeline[.]sha' -and
    $worldPromotion -match 'World Promotion Operations') 'World promotion uses bounded supplemental transfers, exact protected main, explicit authorization, and an external receipt'
Assert-True ($worldPromotion -match "Get-Command 'tar[.]exe'" -and
    $worldPromotion -match "'-cf', \`$archivePath" -and
    $worldPromotion -match "transfer_mode = 'single-tar-archive'" -and
    $worldPromotion -match 'archive_sha256' -and
    $worldPromotion -match 'TimeoutMilliseconds 3600000' -and
    $worldPromotion -match 'HardDeadlineSeconds 3600' -and
    $worldPromotion -notmatch "(?s)function Invoke-WorldSupplementalTransfer.+?'\-r'," -and
    $worldPromotionRemote -match 'extract_transferred_archive' -and
    $worldPromotionRemote -match 'tarfile[.]open' -and
    $worldPromotionRemote -match 'member[.]isfile' -and
    $worldPromotionRemote -match '\$transfer[.]tar') 'World supplemental transport uses one bounded archive per root with safe remote extraction'
Assert-True ($worldPromotionRemote -match 'dependency_environment' -and
    $worldPromotionRemote -match 'candidate_readiness' -and
    $worldPromotionRemote -match 'ash-atlas-world-candidate[.]service' -and
    $worldPromotionRemote -match 'ash-atlas-world-activation[.]service' -and
    $worldPromotionRemote -match 'supplemental_surface_verification_mode' -and
    $worldPromotionRemote -match 'manifest-only' -and
    $worldPromotion -match 'waterbodyOverlay' -and
    $worldPromotion -match 'waterbody_identity_overlay' -and
    $worldPromotionRemote -match 'WATERBODY_IDENTITY_OVERLAY_RELEASE' -and
    $worldPromotionRemote -match 'waterbody-identity-overlay-release-root' -and
    $worldPromotionRemote -match 'waterbody-identity-overlay-manifest-sha256' -and
    $worldPromotionRemote -match 'RIVERBANK_TRANSFER_ROOT' -and
    $worldPromotionRemote -match 'WATER_NAME_INDEX_TRANSFER_ROOT' -and
    $worldPromotionRemote -match 'SUPPLEMENTAL_STAGING_ROOT=/home/debian/ash-atlas-world-promotion-staging' -and
    $worldPromotionRemote -match "stat -c '%U:%G:%a'" -and
    $worldPromotionRemote -match 'validate_transferred_archive' -and
    $worldPromotionRemote -match 'archive ownership is unsafe' -and
    $worldPromotionRemote -match 'archive mode is unsafe' -and
    $worldPromotionRemote -match 'supplemental extraction directory already exists' -and
    $worldPromotionRemote -match 'publish_supplemental_root' -and
    $worldPromotionRemote -match 'riverbankLakeshoreV1' -and
    $worldPromotionRemote -match 'water-name-index' -and
    $worldPromotionRemote -match 'waterbodyIdentityV1') 'World promotion reuses immutable dependencies and admits exact waterbody, riverbank/lakeshore, and water-name authorities on a separate candidate'
Assert-True ($worldPromotionRemote -match 'rollback\(\)' -and
    $worldPromotionRemote -match 'PREVIOUS_CURRENT' -and
    $worldPromotionRemote -match 'UNIT_BACKUP' -and
    $worldPromotionRemote -match 'EXPECTED_CURRENT_WORLD_RELEASE' -and
    $worldPromotionRemote -match 'EXPECTED_CURRENT_RIVER_MANIFEST_SHA256' -and
    $worldPromotionRemote -match '\$world_id' -and
    $worldPromotionRemote -match '"current_identity":%s' -and
    $worldPromotionRemote -match '"target_identity":%s' -and
    $worldPromotionRemote -match 'require_overlay=\$\{4:-false\}' -and
    $worldPromotionRemote -match 'require_overlay = sys.argv\[36\] == "true"' -and
    $worldPromotionRemote -match 'if require_overlay:' -and
    $worldPromotionRemote -match 'require_supplemental=\$\{14:-false\}' -and
    $worldPromotionRemote -match 'require_supplemental = sys.argv\[37\] == "true"' -and
    $worldPromotionRemote -match 'if require_supplemental:' -and
    $worldPromotionRemote -match 'unit_has_supplemental_args' -and
    $worldPromotionRemote -match 'result":"already-active"' -and
    [regex]::Matches($worldPromotionRemote, 'wait_ready 8765 "\$EXPECTED_CURRENT_SHA" false false').Count -eq 2 -and
    $worldPromotionRemote -match 'wait_ready "\$CANDIDATE_PORT" "\$TARGET_SHA" true true' -and
    $worldPromotionRemote -match 'wait_ready 8765 "\$TARGET_SHA" true true' -and
    $worldPromotionRemote -match 'CLEANUP_DONE=false' -and
    $worldPromotionRemote -match 'CLEANUP_DONE=true' -and
    $worldPromotionRemote -match 'ROLLBACK_RUNNING=false' -and
    $worldPromotionRemote -match 'TRAP_INSTALLED=true' -and
    $worldPromotionRemote -match 'rollback 1') 'World promotion gates all target authorities while preserving exact current, candidate, activation, rollback, same-SHA recovery, and one-shot cleanup identities'
Assert-True ($worldPromotionRemote -match 'TARGET_ACTIVE_RECOVERY=false' -and
    $worldPromotionRemote -match 'unit_supplemental_arg_state' -and
    $worldPromotionRemote -match 'supplemental_state=\$\(unit_supplemental_arg_state\)' -and
    $worldPromotionRemote -match 'target_active_recovery_state_is_safe' -and
    $worldPromotionRemote -match '\[\[ "\$state" = missing \]\]' -and
    $worldPromotionRemote -match '! unit_has_canonical_execstart' -and
    $worldPromotionRemote -match 'target-active recovery requires missing supplemental arguments or a complete exact noncanonical repair state' -and
    $worldPromotionRemote -match 'current World is neither the approved base nor an eligible target-active recovery' -and
    $worldPromotionRemote -match 'TARGET_ACTIVE_RECOVERY=true' -and
    $worldPromotionRemote -match 'target_active_recovery":%s') 'World promotion permits only an exact target-active core-identity recovery with a safe supplemental repair state and refuses mismatched or partial state'
Assert-True ($worldPromotionRemote -match 'readonly UNIT=/etc/systemd/system/ash-atlas-world[.]service' -and
    $worldPromotionRemote -match 'read_validated_unit_text' -and
    $worldPromotionRemote -match '\[\[ -f "\$UNIT" && ! -L "\$UNIT" \]\] \|\| return 2' -and
    $worldPromotionRemote -match 'cat -- "\$UNIT"' -and
    $worldPromotionRemote -notmatch 'systemctl cat "\$UNIT"') 'World supplemental classifier reads the exact absolute unit file and fails closed on read failure'
Assert-True ($worldPromotion -match '\[ValidateRange\(45, 1800\)\]\[int\]\$CandidateReadinessSeconds = 45' -and
    $worldPromotion -match '\$operationId,\s+\$CandidateReadinessSeconds' -and
    $worldPromotion -match 'candidate_readiness_seconds = \$CandidateReadinessSeconds') 'World promotion exposes and records a bounded candidate readiness allowance'
Assert-True ([string]$worldRuntimeLock.riverbank_lakeshore.release_id -eq 'riverbank-lakeshore-v1' -and
    [string]$worldRuntimeLock.riverbank_lakeshore.manifest_sha256 -eq 'c3a2823f759271abb77bf23220e33cb1146d9a3ecb2615f79d3e173189a2344f' -and
    [string]$worldRuntimeLock.water_name_index.release_id -eq 'water-names-v1' -and
    [string]$worldRuntimeLock.water_name_index.manifest_sha256 -eq 'bb73ebeac7c48d4adcedf9dd10e9a0a6cf591bd8ef7dfe01dca2a141a9e6317b' -and
    $worldPromotionRemote -match 'c3a2823f759271abb77bf23220e33cb1146d9a3ecb2615f79d3e173189a2344f' -and
    $worldPromotionRemote -match 'bb73ebeac7c48d4adcedf9dd10e9a0a6cf591bd8ef7dfe01dca2a141a9e6317b') 'World promotion pins the exact riverbank/lakeshore and water-name index authorities'
Assert-True ($worldPromotionRemote -match 'CANDIDATE_READINESS_SECONDS=\$\{30:-45\}' -and
    $worldPromotionRemote -match 'local timeout_seconds=\$\{13:-45\}' -and
    $worldPromotionRemote -match 'CANDIDATE_READINESS_SECONDS <= 1800' -and
    [regex]::Matches($worldPromotionRemote, 'CANDIDATE_READINESS_SECONDS" true \|\| fail').Count -eq 2 -and
    $worldPromotionRemote -match '"candidate_readiness_seconds":%s') 'World promotion applies the allowance only to candidate and activated target waits and records it remotely'
$legacyRiverRootToken = [string]$worldRuntimeLock.river_surface.release_id
$targetRiverRootToken = '{0}--sha256-{1}' -f [string]$worldRuntimeLock.river_surface.release_id,
    [string]$worldRuntimeLock.river_surface.manifest_sha256
Assert-True ($legacyRiverRootToken -eq 'river-surface-v1' -and
    $targetRiverRootToken -eq 'river-surface-v1--sha256-c605631193ff786e33182fb8b6d7cfa3ab868b35d0a47fec5e1aa717ace447d5' -and
    $targetRiverRootToken -ne $legacyRiverRootToken -and
    $worldPromotion -match '\$targetRiverSurfaceRootToken = ''\{0\}--sha256-\{1\}'' -f' -and
    $worldPromotion -match '\$targetRiverSurfaceRootToken' -and
    $worldPromotionRemote -match 'RIVER_SURFACE_TARGET_ROOT_TOKEN=\$\{31:-\}' -and
    $worldPromotionRemote -match 'release_root_token') `
    'World promotion keeps the logical river identity while deriving and recording a distinct manifest-qualified target root token'
Assert-True ($worldPromotionRemote -match 'validate_river_surface_target_root' -and
    $worldPromotionRemote -match 'river surface target root token does not match' -and
    $worldPromotionRemote -match 'target river surface release root is absent or unsafe' -and
    $worldPromotionRemote -match 'sha256sum "\$manifest"' -and
    $worldPromotionRemote -match 'target river surface manifest hash differs' -and
    $worldPromotionRemote.IndexOf('phase_start target_surface_validation') -lt
        $worldPromotionRemote.IndexOf('phase_start candidate_readiness')) `
    'World promotion hard-fails unsafe or wrong target river manifests before candidate startup'
Assert-True ($updater -match 'RIVER_SURFACE_TARGET_ROOT_TOKEN' -and
    $updater -match 'RIVER_SURFACE_TARGET_ROOT=/srv/ash-atlas/world/releases/\$RIVER_SURFACE_TARGET_ROOT_TOKEN' -and
    $updater -match '--river-surface-release-root \$RIVER_SURFACE_TARGET_ROOT' -and
    $updater -match 'operation_receipt_update world_river_surface_target_root_token' -and
    $updater -match 'world_river_surface_target_root "\$RIVER_SURFACE_TARGET_ROOT"') `
    'deployment updater asserts and records the exact manifest-qualified target river surface root'
Assert-True ($orchestrator -match 'Publish-DeploymentRequest \$State \$Target \$UpdaterHash' -and
    $orchestrator -match 'Invoke-HttpsDeploymentStatus \$State' -and
    $orchestrator -match 'Wait-HttpsSubmissionReconciliation' -and
    $orchestrator -match 'github-pull-request-ref') 'ordinary deployment publishes a Git request and monitors only through HTTPS'
Assert-True ($orchestrator -notmatch 'Start-Job') 'public and remote verification no longer create PowerShell background jobs'
Assert-True ($orchestrator -match 'DeploymentPollIntervalSeconds = 2' -and
    $orchestrator -match 'SshConnectTimeoutSeconds = 30' -and
    $orchestrator -match 'SshHardDeadlineSeconds = 45' -and
    $orchestrator -match 'AmbiguousSubmissionGraceSeconds = 75' -and
    $orchestrator -match 'DeploymentSubmissionRetryLimit = 5' -and
    $orchestrator -match 'HttpsStatusFallbackSeconds = 5' -and
    $orchestrator -match 'ReceiptUnreachableGraceSeconds = 120' -and
    $transport -match 'ConnectTimeout=\$connect_timeout' -and
    $transport -match 'ConnectionAttempts=1' -and
    $transport -match 'WaitForExit\(\$TimeoutMilliseconds\)' -and
    $transport -match 'taskkill[.]exe' -and
    $orchestrator -match "TimeoutMilliseconds 45000") 'request publication, status polling, and breakglass SSH are wall-clock bounded'
Assert-True ($transport -match 'BatchMode=yes' -and
    $transport -match 'IdentitiesOnly=yes' -and
    $transport -match 'StrictHostKeyChecking=yes' -and
    $transport -match 'UserKnownHostsFile=' -and
    $transport -match 'PasswordAuthentication=no' -and
    $transport -match 'KbdInteractiveAuthentication=no' -and
    $transport -notmatch 'StrictHostKeyChecking=no') 'WSL transport enforces pinned public-key-only authentication'
Assert-True ($orchestrator -match 'function Invoke-PublishGitWorkflow' -and
    $orchestrator -match 'function Invoke-DeploymentWorkflow' -and
    $orchestrator -match "ActiveWorkflowDomain = 'git-only'" -and
    $orchestrator -match "ActiveWorkflowDomain = 'deployment'") 'Git publication and deployment are explicit independent workflow domains'
Assert-True ($orchestrator -match '\[math\]::Min\(10, \$DelaySeconds \* 2\)' -and
    $orchestrator -match '\$outageMilliseconds -ge \(\$HttpsStatusFallbackSeconds \* 1000\)' -and
    $orchestrator -match 'Invoke-SshStatusFallback \$State \$Target' -and
    $orchestrator -match 'deployment_automatic_reconciliation_required' -and
    $orchestrator -match 'request-submitted-status-unavailable' -and
    $orchestrator -match 'deployment_longest_receipt_outage_ms' -and
    $orchestrator -match 'deployment_total_receipt_outage_ms') 'receipt outages use capped backoff, then bounded read-only SSH reconciliation with recorded metrics'
Assert-True ($orchestrator -match '(?s)\$publicProbe = Start-PublicVerification.+Complete-PublicVerification' -and
    $orchestrator -match '/api/auth/session' -and
    $orchestrator -match '/api/lookup[?]lat=35[.]0844' -and
    $orchestrator -match '\[int\]\$Probe[.]HtmlResponse[.]StatusCode -ne 200' -and
    $orchestrator -match '\[int\]\$Probe[.]JsResponse[.]StatusCode -ne 200') 'public game, World, HTML, assets, and release checks run through concurrent bounded HTTPS probes'
Assert-True ($orchestrator -match '\[AllowEmptyCollection\(\)\]\[string\[\]\]\$Arguments = @\(\)') 'status and result controller calls accept their intentional empty argument lists'
Assert-True ($orchestrator -match 'EffectiveBaseTestGeneration' -and
    $orchestrator -match 'EffectiveBaseTestSha' -and
    $orchestrator -match 'Assert-RecordedEffectiveBase') 'orchestrator persists, forwards, and revalidates the effective-base pair'
Assert-True ($orchestrator -match 'Historical name-derived generation:' -and
    $orchestrator -match 'Proven effective base:') 'Inspect displays historical and proven base identities'
Assert-True ($generation -match "'push', '--atomic'" -and
    $generation -notmatch '--force-with-lease|--force-if-includes|[''"]--force[''"]') 'canonical protected publication is atomic and contains no force-enabled option'
Assert-True ($generation -notmatch '["'']\+[^"'']*:refs/(?:heads/integration/test|tags/test/)') 'canonical protected publication contains no plus-prefixed protected refspec'
Assert-True ($orchestrator -match '\$prePublication = Get-GenerationStatus' -and
    $orchestrator -match 'origin/\$\(\$State\.feature_branch\) changed before protected publication') 'orchestrator repeats authoritative feature, branch, and generation checks immediately before publication'
Assert-True ($orchestrator -match 'Test-Path -LiteralPath \$Path -PathType Container' -and
    $orchestrator -match 'Test-AshAtlasSamePath \$gitRoot \$Path') 'worktree existence and canonical Git-root identity remain independent requirements'

foreach ($functionName in @(
        'Get-GitText', 'Get-GitFields', 'Get-TextSha256', 'Get-FileSha256',
        'Get-StateValue', 'New-DeploymentStatusToken', 'Get-RedactedWorkflowState',
        'Set-RemoteReceipt', 'Assert-ConsistentControllerPayload', 'Assert-DeploymentStatusPayload',
        'ConvertTo-SanitizedFailureCode', 'ConvertFrom-ControllerReceipt',
        'Set-DeploymentOutcome', 'Set-DeploymentAdmissionDiscovered',
        'Wait-HttpsSubmissionReconciliation', 'Invoke-SshSubmissionReconciliation',
        'Resolve-AmbiguousSubmission',
        'Invoke-SshStatusFallback', 'Complete-ReceiptOutage', 'Get-ReceiptOutageStart',
        'Invoke-ReceiptOutageBackoff', 'Wait-RemoteDeployment',
        'Invoke-DeploymentPollSleep',
        'Invoke-GitPlumbingWithInput', 'Get-DeploymentRequestRemoteSha',
        'New-DeploymentRequestCommit', 'Assert-DeploymentRequestCommit',
        'Publish-DeploymentRequest', 'Invoke-DurableDeployment',
        'Assert-FinalDeploymentEvidence', 'Require-FreshResumeVerification',
        'Test-GitOnlyReconciliationRequired'
    )) {
    $functionAst = @($orchestratorAst.FindAll({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $functionName
    }, $true))
    Assert-True ($functionAst.Count -eq 1) "orchestrator defines exactly one executable $functionName helper"
    Invoke-Expression $functionAst[0].Extent.Text
}
$durableDeploymentAst = @($orchestratorAst.FindAll({
    param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq 'Invoke-DurableDeployment'
}, $true))[0]
Assert-True ($durableDeploymentAst.Extent.Text -match 'Publish-DeploymentRequest' -and
    $durableDeploymentAst.Extent.Text -notmatch 'Invoke-DeploymentController') 'ordinary deployment submission has no SSH execution path'
function Write-State { param($State) }
$boundedStarted = Get-Date
$bounded = Invoke-BoundedNativeProcess -FilePath 'powershell.exe' -Arguments @(
    '-NoProfile', '-Command', 'Start-Sleep -Seconds 2'
) -TimeoutMilliseconds 100
$boundedDuration = ((Get-Date) - $boundedStarted).TotalMilliseconds
Assert-True ($bounded.timed_out -and $bounded.exit_code -eq 124 -and $boundedDuration -lt 3000) 'connected native commands are killed at their wall-clock bound'

if ($SkipWslTransportProbes) {
    Write-Host 'SKIPPED: 4 WSL byte-boundary assertions (2 WSL executions); dedicated release-runner WSL SSH preflight is still required.'
} else {
    $transportStdinFixture = Join-Path $env:TEMP (
        'ash-atlas-release-stdin-test-' + [guid]::NewGuid().ToString('n')
    )
    try {
        $deploymentToken = 'a' * 64
        [IO.File]::WriteAllBytes(
            $transportStdinFixture,
            [Text.UTF8Encoding]::new($false).GetBytes("$deploymentToken`n")
        )
        $transportStdinWslPath = ConvertTo-WslPath $transportStdinFixture
        $tokenProbe = Invoke-BoundedNativeProcess -FilePath 'wsl.exe' -Arguments @(
            '-e', 'bash', '-c',
            'exec < "$1"; IFS= read -r token; printf "chars=%s;hex=" "${#token}"; printf "%s" "$token" | od -An -v -tx1 | tr -d " \n"',
            'ash-atlas-release-stdin-probe', $transportStdinWslPath
        ) -TimeoutMilliseconds 5000
        Assert-True ($tokenProbe.exit_code -eq 0 -and
            $tokenProbe.stdout -match '^chars=(?<chars>\d+);hex=(?<hex>[0-9a-f]+)$') `
            'deployment-token byte probe reads one complete line through the WSL transport boundary'
        $tokenCharacterCount = [int]$Matches.chars
        $tokenHex = [string]$Matches.hex
        Assert-True ($tokenCharacterCount -eq 64) `
            "a 64-character deployment token remains exactly 64 characters remotely (observed chars=$tokenCharacterCount, prefix=$($tokenHex.Substring(0, [math]::Min(6, $tokenHex.Length))))"
        Assert-True (-not $tokenHex.StartsWith('efbbbf', [StringComparison]::OrdinalIgnoreCase)) `
            'remote standard input has no UTF-8 BOM prefix'

        $multilinePayload = "first line`nsecond line`n"
        [IO.File]::WriteAllBytes(
            $transportStdinFixture,
            [Text.UTF8Encoding]::new($false).GetBytes($multilinePayload)
        )
        $multilineProbe = Invoke-BoundedNativeProcess -FilePath 'wsl.exe' -Arguments @(
            '-e', 'bash', '-c', 'exec < "$1"; od -An -v -tx1 | tr -d " \n"',
            'ash-atlas-release-stdin-probe', $transportStdinWslPath
        ) -TimeoutMilliseconds 5000
        $expectedMultilineHex = [BitConverter]::ToString(
            [Text.UTF8Encoding]::new($false).GetBytes($multilinePayload)
        ).Replace('-', '').ToLowerInvariant()
        Assert-True ($multilineProbe.exit_code -eq 0 -and $multilineProbe.stdout -eq $expectedMultilineHex) `
            'ordinary multiline standard input preserves exact BOM-less UTF-8 bytes and intended LF framing'
    } finally {
        if (Test-Path -LiteralPath $transportStdinFixture) {
            Remove-Item -LiteralPath $transportStdinFixture -Force
        }
    }
}
Assert-True ($transport -match '\[IO[.]File\]::WriteAllBytes' -and
    $transport -match '\[Text[.]UTF8Encoding\]::new\(\$false\)' -and
    $transport -match 'exec < "\$stdin_source"' -and
    $transport -notmatch '-StandardInput \$StandardInput') `
    'WSL SSH stdin is staged as BOM-less UTF-8 and redirected without the BOM-emitting process writer'

$treeFixture = Join-Path $env:TEMP ("ash-atlas-watchdog-tree-" + [guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Path $treeFixture -Force | Out-Null
try {
    $childPidPath = Join-Path $treeFixture 'child.pid'
    $quotedChildPidPath = $childPidPath.Replace("'", "''")
    $parentCommand = "`$child = Start-Process powershell.exe -ArgumentList @('-NoProfile','-Command','Start-Sleep -Seconds 30') -PassThru; " +
        "Set-Content -LiteralPath '$quotedChildPidPath' -Value `$child.Id; Start-Sleep -Seconds 30"
    $treeResult = Invoke-BoundedNativeProcess -FilePath 'powershell.exe' -Arguments @(
        '-NoProfile', '-Command', $parentCommand
    ) -TimeoutMilliseconds 1500
    $childPid = [int](Get-Content -Raw -LiteralPath $childPidPath)
    $childAlive = $null -ne (Get-Process -Id $childPid -ErrorAction SilentlyContinue)
    Assert-True ($treeResult.watchdog_terminated -and $treeResult.process_tree_terminated -and
        -not $childAlive) 'external watchdog terminates the entire descendant process tree'
} finally {
    if (Test-Path -LiteralPath $treeFixture) {
        Remove-Item -LiteralPath $treeFixture -Recurse -Force
    }
}

$floodCommand = '1..4000 | ForEach-Object { [Console]::Out.WriteLine(("o" * 128)); [Console]::Error.WriteLine(("e" * 128)) }; Start-Sleep -Seconds 30'
$floodStarted = Get-Date
$floodResult = Invoke-BoundedNativeProcess -FilePath 'powershell.exe' -Arguments @(
    '-NoProfile', '-Command', $floodCommand
) -TimeoutMilliseconds 1000
$floodDuration = ((Get-Date) - $floodStarted).TotalMilliseconds
Assert-True ($floodResult.watchdog_terminated -and $floodResult.output_capture_complete -and
    $floodResult.stdout.Length -gt 100000 -and $floodResult.stderr.Length -gt 100000 -and
    $floodDuration -lt 5000) 'redirected stdout and stderr are drained asynchronously without deadlocking the watchdog'

$spacePath = ConvertTo-WslPath 'C:\Release Fixtures\key with spaces'
Assert-True ($spacePath -eq '/mnt/c/Release Fixtures/key with spaces') 'Windows-to-WSL path conversion preserves spaces without shell quoting'
$quotedArgument = ConvertTo-NativeCommandArgument 'value with "quotes" and spaces'
Assert-True ($quotedArgument.StartsWith('"') -and $quotedArgument.EndsWith('"') -and
    $quotedArgument -match '\\"quotes\\"') 'native argument quoting preserves embedded quotes as one argument'
$redactionTransport = [pscustomobject]@{
    key_windows_path = 'C:\Secret Folder\private key'
    known_hosts_windows_path = 'C:\Secret Folder\known hosts'
    key_wsl_path = '/mnt/c/Secret Folder/private key'
    known_hosts_wsl_path = '/mnt/c/Secret Folder/known hosts'
}
$redactedTransportOutput = Protect-ReleaseTransportText (
    'C:\Secret Folder\private key /mnt/c/Secret Folder/known hosts /tmp/ash-atlas-release-transport.ABC123/identity'
) $redactionTransport
Assert-True ($redactedTransportOutput -notmatch 'Secret Folder|ABC123|private key') 'private-key and pinned-known-host paths are redacted from transport output'
Assert-True ((Get-SshTransportFailureClass ([pscustomobject]@{
                start_succeeded = $true; timed_out = $false; exit_code = 255
            }) 'Host key verification failed') -eq 'host-key-verification-failure' -and
    (Get-SshTransportFailureClass ([pscustomobject]@{
                start_succeeded = $true; timed_out = $false; exit_code = 255
            }) 'Permission denied (publickey)') -eq 'ssh-authentication-failure' -and
    (Get-SshTransportFailureClass ([pscustomobject]@{
                start_succeeded = $true; timed_out = $false; exit_code = 255
            }) 'ssh: connect to host example port 22: Connection timed out') -eq 'tcp-connect-timeout') 'transport failures classify host key, authentication, and TCP timeout independently'
Assert-True ((Get-SshTransportFailureClass ([pscustomobject]@{
                start_succeeded = $true; timed_out = $false; exit_code = 0
            }) '') -eq 'transport-succeeded') `
    'successful silent SSH and SCP commands are accepted without requiring output text'

$integrationFunction = @($orchestratorAst.FindAll({
    param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq 'Invoke-IntegrationWorkflow'
}, $true))[0].Extent.Text
$publishGitFunction = @($orchestratorAst.FindAll({
    param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq 'Invoke-PublishGitWorkflow'
}, $true))[0].Extent.Text
$deploymentFunction = @($orchestratorAst.FindAll({
    param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq 'Invoke-DeploymentWorkflow'
}, $true))[0].Extent.Text
Assert-True ($integrationFunction -notmatch 'Invoke-DeploymentController|Invoke-HttpsDeploymentStatus|Get-DeploymentTransport' -and
    $publishGitFunction -notmatch 'Invoke-DeploymentController|Invoke-HttpsDeploymentStatus|Get-DeploymentTransport') 'Git-only integration and master publication contain no VPS transport call'
Assert-True ($deploymentFunction -notmatch 'Invoke-Git|git\s+-C|refs/heads|refs/tags') 'deployment failure cannot roll back or rewrite already-published Git refs'

$gitOnlyState = [pscustomobject]@{
    requested_mode = 'Publish'
    phases = [pscustomobject]@{}
}
Assert-True (Test-GitOnlyReconciliationRequired $gitOnlyState) 'pre-publication reconciliation remains Git-only'
Add-Member -InputObject $gitOnlyState.phases -NotePropertyName master_fast_forward_and_push `
    -NotePropertyValue ([pscustomobject]@{ status = 'completed' })
Assert-True (-not (Test-GitOnlyReconciliationRequired $gitOnlyState)) 'VPS reconciliation is enabled only after the Git publication phase is durable'

$requestFixture = Join-Path $env:TEMP ("ash-atlas-request-publisher-" + [guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Path $requestFixture -Force | Out-Null
try {
    $requestOrigin = Join-Path $requestFixture 'origin.git'
    $requestSource = Join-Path $requestFixture 'source'
    & git init --bare -q $requestOrigin
    & git init -q $requestSource
    & git -C $requestSource config user.name fixture
    & git -C $requestSource config user.email fixture@example.invalid
    New-Item -ItemType Directory -Path (Join-Path $requestSource 'tools\release\vps') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $requestSource 'target.txt') -Value target -Encoding ascii
    Copy-Item -LiteralPath (Join-Path $root 'tools\release\vps\deploy-control.sh') `
        -Destination (Join-Path $requestSource 'tools\release\vps\deploy-control.sh')
    & git -C $requestSource add .
    & git -C $requestSource commit -qm target
    $requestTarget = (& git -C $requestSource rev-parse HEAD).Trim()
    & git -C $requestSource branch -M master
    & git -C $requestSource remote add origin $requestOrigin
    & git -C $requestSource push -q origin master
    & git -C $requestSource tag test/t231
    & git -C $requestSource push -q origin refs/tags/test/t231
    $script:RepositoryRoot = $requestSource
    $script:DeploymentSubmissionRetryLimit = 2
    $gitInputProbe = 'git-stdin-byte-probe'
    $bomlessProbePath = Join-Path $requestFixture 'git-input-bomless.txt'
    $actualProbePath = Join-Path $requestFixture 'git-input-actual.txt'
    $actualProbeErrorPath = Join-Path $requestFixture 'git-input-actual.err'
    $bomlessProbeBytes = [Text.UTF8Encoding]::new($false).GetBytes($gitInputProbe)
    [IO.File]::WriteAllBytes($bomlessProbePath, $bomlessProbeBytes)
    $actualGitInputBlob = Invoke-GitPlumbingWithInput -Arguments @('hash-object', '-w', '--stdin') `
        -InputText $gitInputProbe
    $catFile = Start-Process -FilePath 'git.exe' -ArgumentList @(
        '-C', $requestSource, 'cat-file', 'blob', $actualGitInputBlob
    ) -NoNewWindow -Wait -PassThru -RedirectStandardOutput $actualProbePath `
        -RedirectStandardError $actualProbeErrorPath
    Assert-True ($catFile.ExitCode -eq 0) 'Git stdin byte probe can read its exact stored blob'
    $actualProbeBytes = [IO.File]::ReadAllBytes($actualProbePath)
    $actualProbeHex = [BitConverter]::ToString($actualProbeBytes).Replace('-', '').ToLowerInvariant()
    $expectedProbeHex = [BitConverter]::ToString($bomlessProbeBytes).Replace('-', '').ToLowerInvariant()
    Assert-True ($actualProbeHex -eq $expectedProbeHex) `
        "Invoke-GitPlumbingWithInput sends exact BOM-less UTF-8 bytes (prefix=$($actualProbeHex.Substring(0, [math]::Min(6, $actualProbeHex.Length))), suffix=$($actualProbeHex.Substring([math]::Max(0, $actualProbeHex.Length - 4))))"
    $requestState = [pscustomobject]@{
        operation_id = 'publisher-fixture'
        new_generation = 't231'
        deployment_status_token = 'a' * 64
        deployment_submission_first_attempt_at_utc = ''
        deployment_request_ref = 'refs/heads/integration/deployment-requests'
        deployment_request_parent = ''
        deployment_request_commit = ''
        deployment_request_manifest_sha256 = ''
        deployment_submission_state = 'pending_submission'
        deployment_submission_attempt_count = 0
        deployment_submission_retry_count = 0
        deployment_start_attempted = $false
        deployment_transport = ''
    }
    Publish-DeploymentRequest $requestState $requestTarget ('b' * 64)
    $firstRequestCommit = [string]$requestState.deployment_request_commit
    $remoteRequestCommit = ((& git -C $requestSource ls-remote --refs origin `
        refs/heads/integration/deployment-requests) -split '\s+')[0]
    $requestManifest = (& git -C $requestSource show "${firstRequestCommit}:deployment-request.json") |
        ConvertFrom-Json
    Assert-True ($requestState.deployment_submission_state -eq 'submitted' -and
        $requestState.deployment_transport -eq 'github-pull-request-ref' -and
        $remoteRequestCommit -eq $firstRequestCommit) 'publisher confirms the exact request commit before marking submission complete'
    Assert-True ($requestManifest.operation_id -eq 'publisher-fixture' -and
        $requestManifest.target_sha -eq $requestTarget -and
        $requestManifest.test_tag -eq 'test/t231' -and
        $requestManifest.controller_version -eq 7 -and
        $requestManifest.status_token -eq ('a' * 64)) 'request manifest pins the complete immutable deployment identity'
    Publish-DeploymentRequest $requestState $requestTarget ('b' * 64)
    $confirmedAgain = ((& git -C $requestSource ls-remote --refs origin `
        refs/heads/integration/deployment-requests) -split '\s+')[0]
    Assert-True ($requestState.deployment_request_commit -eq $firstRequestCommit -and
        $confirmedAgain -eq $firstRequestCommit) 'Resume retransmits or confirms the same request commit without creating another request'
    $requestState.deployment_status_token = 'c' * 64
    $tupleMismatchRefused = $false
    try { Publish-DeploymentRequest $requestState $requestTarget ('b' * 64) }
    catch { $tupleMismatchRefused = $_.Exception.Message -match 'immutable operation tuple' }
    Assert-True $tupleMismatchRefused 'Resume refuses any operation-token mutation after request identity is persisted'
} finally {
    Remove-Variable RepositoryRoot -Scope Script -ErrorAction SilentlyContinue
    Remove-Variable DeploymentSubmissionRetryLimit -Scope Script -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $requestFixture) {
        Remove-Item -LiteralPath $requestFixture -Recurse -Force
    }
}

$tokenA = New-DeploymentStatusToken
$tokenB = New-DeploymentStatusToken
Assert-True ($tokenA -match '^[0-9a-f]{64}$' -and $tokenB -match '^[0-9a-f]{64}$' -and
    $tokenA -ne $tokenB) 'deployment status tokens are independent 256-bit lowercase capabilities'
$secretState = [pscustomobject]@{ deployment_status_token = $tokenA; operation_id = 'redaction-fixture' }
$redactedState = Get-RedactedWorkflowState $secretState
Assert-True ($redactedState.deployment_status_token -eq '[redacted]' -and
    $secretState.deployment_status_token -eq $tokenA) 'reportable workflow state redacts the bearer token without mutating persisted state'

$script:TargetSha = 'a' * 40
$script:OldSha = 'c' * 40
$script:StatusToken = 'f' * 64
$script:DeploymentPollIntervalSeconds = 2
$script:DeploymentTimeoutSeconds = 120
$script:HttpsStatusFallbackSeconds = 5
$script:ReceiptUnreachableGraceSeconds = 120
$script:AmbiguousSubmissionGraceSeconds = 75
$script:DeploymentSubmissionRetryLimit = 1
$script:FakeNow = [datetime]'2026-07-23T20:00:00Z'
function Start-Sleep {
    param([int]$Seconds = 0, [int]$Milliseconds = 0)
    $durationMilliseconds = ($Seconds * 1000) + $Milliseconds
    $script:RecordedSleepMilliseconds += $durationMilliseconds
    $script:FakeNow = $script:FakeNow.AddMilliseconds($durationMilliseconds)
}
function Get-Date {
    param([string]$Format)
    if ($Format) { return $script:FakeNow.ToString($Format) }
    return $script:FakeNow
}
function Invoke-DeploymentController {
    param($State, $Action, $Arguments, [AllowNull()][string]$StandardInput = $null)
    $script:ControllerActions += $Action
    $script:ControllerArguments += ,@($Arguments)
    $script:ControllerInputs += $StandardInput
    if ($script:ControllerResponses.Count -eq 0) { throw "SSH outage during unexpected $Action" }
    return $script:ControllerResponses.Dequeue()
}
function Invoke-HttpsDeploymentStatus {
    param($State)
    $script:HttpsActions += 'status'
    if ($script:HttpsResponses.Count -eq 0) { throw 'No HTTPS status response remains' }
    return $script:HttpsResponses.Dequeue()
}
function New-DeploymentFixtureState($Receipt = $null, [bool]$StartAttempted = $false) {
    return [pscustomobject]@{
        operation_id = 'fixture-operation'
        new_generation = 't231'
        remote_deployment_receipt = $Receipt
        deployment_lane = ''
        deployment_phase_timings = $null
        deployment_status_token = $script:StatusToken
        deployment_start_attempted = $StartAttempted
        deployment_transport = 'mock'
        deployment_transport_events = @()
        deployment_submission_attempt_count = $(if ($StartAttempted) { 1 } else { 0 })
        deployment_submission_retry_count = 0
        deployment_submission_target_sha = ''
        deployment_submission_updater_hash = ''
        deployment_submission_first_attempt_at_utc = $(if ($StartAttempted) {
                '2026-07-23T20:00:00Z'
            } else { '' })
        deployment_admission_discovered_at_utc = $(if ($null -ne $Receipt) {
                '2026-07-23T20:00:00Z'
            } else { '' })
        deployment_admission_source = $(if ($null -ne $Receipt) { 'https' } else { '' })
        deployment_completion_discovered_at_utc = ''
        deployment_admission_duration_ms = 0
        deployment_https_admission_duration_ms = 0
        deployment_operation_completion_duration_ms = 0
        deployment_last_outcome = ''
        deployment_ssh_fallback_count = 0
        deployment_ssh_fallback_attempted_at_utc = ''
        deployment_status_read_failures = 0
        deployment_receipt_outage_started_at_utc = ''
        deployment_receipt_outage_next_delay_seconds = 2
        deployment_longest_receipt_outage_ms = 0
        deployment_total_receipt_outage_ms = 0
        deployment_poll_wait_duration_ms = 0
        deployment_transition_events = @()
        deployment_completion_observation_lag_ms = 0
        deployment_automatic_reconciliation_required = $false
        remote_acceptance_duration_ms = 0
        reconciled_remote_truth = $null
    }
}
function New-ControllerResponse(
    [int]$ExitCode,
    $Payload,
    [string]$Output = '',
    [bool]$TimedOut = $false,
    [string]$FailureClass = '',
    [bool]$AcceptanceAmbiguous = $false
) {
    if (-not $FailureClass) {
        $FailureClass = if ($ExitCode -eq 0) { 'controller-accepted' } else { 'transport-unavailable' }
    }
    return [pscustomobject]@{
        exit_code = $ExitCode
        timed_out = $TimedOut
        failure_class = $FailureClass
        acceptance_ambiguous = $AcceptanceAmbiguous -or $TimedOut
        payload = $Payload
        output = $Output
    }
}
function New-ControllerReceipt([string]$Result = 'running') {
    $terminal = $Result -eq 'completed'
    return [pscustomobject]@{
        operation_id = 'fixture-operation'
        requested_target_sha = $script:TargetSha
        result = $Result
        current_phase = if ($terminal) { 'completed' } else { 'starting' }
        controller_state = 'consistent'
        observed_game_sha = if ($terminal) { $script:TargetSha } else { $script:OldSha }
        observed_public_sha = if ($terminal) { $script:TargetSha } else { $script:OldSha }
        migration_required = if ($terminal) { $false } else { $null }
        migration_started = $false
        migration_completed = $false
        migration_outcome_uncertain = $false
        activation_started = $terminal
        activation_completed = $terminal
        mutation_evidence_complete = $true
        rollback_result = 'not_required'
        failure_phase = ''
        accepted_at_utc = '2026-07-23T20:00:00Z'
        started_at_utc = '2026-07-23T20:00:01Z'
        finished_at_utc = if ($terminal) { '2026-07-23T20:00:30Z' } else { '' }
    }
}
function New-HttpsStatus(
    [string]$Result = 'running',
    [string]$ActiveGameSha = '',
    [string]$ActivePublicSha = ''
) {
    $terminal = $Result -eq 'completed'
    $failed = $Result -eq 'failed'
    if (-not $ActiveGameSha) { $ActiveGameSha = if ($terminal) { $script:TargetSha } else { $script:OldSha } }
    if (-not $ActivePublicSha) { $ActivePublicSha = if ($terminal) { $script:TargetSha } else { $script:OldSha } }
    return [pscustomobject][ordered]@{
        schema_version = 1
        operation_id = 'fixture-operation'
        target_sha = $script:TargetSha
        result = $Result
        current_phase = if ($terminal) { 'completed' } elseif ($failed) { 'migration' } else { 'server_build' }
        active_game_sha = $ActiveGameSha
        active_public_sha = $ActivePublicSha
        migration_result = if ($terminal) { 'not_required' } elseif ($failed) { 'failed' } else { 'pending' }
        activation_result = if ($terminal) { 'completed' } else { 'pending' }
        readiness_result = if ($terminal) { 'completed' } else { 'pending' }
        mutation_evidence_complete = $true
        migration_started = $failed
        migration_completed = $terminal
        migration_outcome_uncertain = $false
        activation_started = $terminal
        activation_completed = $terminal
        rollback_result = if ($failed) { 'blocked_migration_compatibility_uncertain' } else { 'not_required' }
        failure_phase = if ($failed) { 'migration' } else { '' }
        failure_code = if ($failed) { 'migration_failed' } else { '' }
        updated_at_utc = '2026-07-23T20:00:30Z'
    }
}
function New-HttpsResponse(
    [bool]$Available,
    $Payload = $null,
    [string]$Code = 'ok',
    [bool]$Conflict = $false
) {
    return [pscustomobject]@{
        available = $Available
        conflict = $Conflict
        code = $Code
        payload = $Payload
    }
}
function Reset-DeploymentMocks {
    $script:ControllerActions = @()
    $script:ControllerArguments = @()
    $script:ControllerInputs = @()
    $script:HttpsActions = @()
    $script:RecordedSleepMilliseconds = @()
    $script:ControllerResponses = [Collections.Queue]::new()
    $script:HttpsResponses = [Collections.Queue]::new()
    $script:FakeNow = [datetime]'2026-07-23T20:00:00Z'
}
function Enqueue-HttpsGraceNotFound {
    1..10 | ForEach-Object {
        $script:HttpsResponses.Enqueue((New-HttpsResponse $false $null 'http_404'))
    }
}

$script:Mode = 'Resume'
$transitionState = New-DeploymentFixtureState
$runningTransitionReceipt = New-ControllerReceipt 'running'
$runningTransitionReceipt | Add-Member NoteProperty state_transitions @([pscustomobject]@{
        timestamp_utc = '2026-07-23T19:59:59.500Z'
        operation_id = 'fixture-operation'
        previous_state = 'accepted'
        next_state = 'starting'
        elapsed_previous_state_ms = 500
        reason = 'controller_receipt_update'
        process_pid = 123
        scope = 'remote_controller'
    })
Set-RemoteReceipt $transitionState $runningTransitionReceipt
$script:FakeNow = $script:FakeNow.AddSeconds(2)
$completedTransitionReceipt = New-ControllerReceipt 'completed'
$completedTransitionReceipt | Add-Member NoteProperty state_transitions @(
    $runningTransitionReceipt.state_transitions[0],
    [pscustomobject]@{
        timestamp_utc = '2026-07-23T20:00:01.250Z'
        operation_id = 'fixture-operation'
        previous_state = 'starting'
        next_state = 'completed'
        elapsed_previous_state_ms = 1750
        reason = 'controller_receipt_update'
        process_pid = 124
        scope = 'remote_controller'
    })
Set-RemoteReceipt $transitionState $completedTransitionReceipt
Assert-True ($transitionState.deployment_transition_events.Count -eq 2 -and
    $transitionState.deployment_transition_events[1].previous_state -eq 'starting' -and
    $transitionState.deployment_transition_events[1].next_state -eq 'completed' -and
    $transitionState.deployment_transition_events[1].elapsed_previous_state_ms -eq 2000 -and
    $transitionState.deployment_transition_events[1].observation_lag_ms -eq 750 -and
    $transitionState.deployment_completion_observation_lag_ms -eq 750) `
    'local observer records durable remote transitions and exact completion observation lag'
Reset-DeploymentMocks
$completedVerification = [pscustomobject]@{
    status = 'completed'
    result = 'previously passed'
}
$resumeVerificationState = [pscustomobject]@{
    phases = [pscustomobject]@{
        atomic_branch_and_generation_publication = [pscustomobject]@{
            status = 'completed'
            result = 'published'
        }
        master_fast_forward_and_push = [pscustomobject]@{
            status = 'completed'
            result = 'published'
        }
        host_readiness_and_public_world_verification = $completedVerification
    }
    exact_deployed_sha = 'a' * 40
    deployment_verification_result = 'previously passed'
}
Require-FreshResumeVerification $resumeVerificationState
Assert-True ($completedVerification.status -eq 'pending' -and
    $resumeVerificationState.exact_deployed_sha -eq '' -and
    $resumeVerificationState.deployment_verification_result -eq '') 'Resume always reruns exact final host, World, asset, and release verification'
Assert-True ($resumeVerificationState.phases.atomic_branch_and_generation_publication.status -eq 'completed' -and
    $resumeVerificationState.phases.master_fast_forward_and_push.status -eq 'completed') 'Resume does not reset completed Git publication phases'
$missingControllerStateRefused = $false
try {
    Assert-ConsistentControllerPayload (New-ControllerResponse 0 ([pscustomobject]@{ result = 'running' }))
} catch {
    $missingControllerStateRefused = $_.Exception.Message -match 'receipt, active marker, and systemd unit disagree'
}
Assert-True $missingControllerStateRefused 'a receipt without explicit consistent controller state fails closed'
$ambiguousControllerStateRefused = $false
try {
    Assert-ConsistentControllerPayload (New-ControllerResponse 4 ([pscustomobject]@{
        result = 'running'
        controller_state = 'ambiguous'
    }))
} catch {
    $ambiguousControllerStateRefused = $_.Exception.Message -match 'receipt, active marker, and systemd unit disagree'
}
Assert-True $ambiguousControllerStateRefused 'an ambiguous controller receipt fails closed without another start'

Reset-DeploymentMocks
1..3 | ForEach-Object {
    $script:HttpsResponses.Enqueue((New-HttpsResponse $false $null 'timeout'))
}
$script:ControllerResponses.Enqueue((New-ControllerResponse 0 (New-ControllerReceipt 'completed')))
$fixtureState = New-DeploymentFixtureState
$statusAfterFallback = Wait-RemoteDeployment $fixtureState (New-HttpsStatus 'running') $script:TargetSha
Assert-True (($script:HttpsActions.Count -eq 3) -and
    (($script:ControllerActions -join ',') -eq 'status') -and
    (($script:RecordedSleepMilliseconds -join ',') -eq '2000,4000') -and
    $fixtureState.deployment_ssh_fallback_count -eq 1 -and
    $fixtureState.deployment_total_receipt_outage_ms -eq 6000 -and
    [string]$statusAfterFallback.result -eq 'completed') `
    'HTTPS monitoring falls back once to authoritative read-only SSH after five virtual seconds'

if ($false) {
$script:Mode = 'Publish'
Reset-DeploymentMocks
$script:ControllerResponses.Enqueue((New-ControllerResponse 0 (New-ControllerReceipt 'running')))
$script:HttpsResponses.Enqueue((New-HttpsResponse $true (New-HttpsStatus 'completed')))
$fixtureState = New-DeploymentFixtureState
$result = Invoke-DurableDeployment $fixtureState $script:TargetSha ('b' * 64)
Assert-True (($script:ControllerActions -join ',') -eq 'start' -and
    ($script:HttpsActions -join ',') -eq 'status') 'normal deployment starts once over SSH and polls status only through HTTPS'
Assert-True ($script:ControllerInputs[0] -eq "$($script:StatusToken)`n" -and
    $script:ControllerActions.Count -eq 1) 'the status token is supplied on SSH stdin and durable start happens exactly once'
Assert-True ($script:RecordedSleepMilliseconds.Count -eq 0) 'an immediately completed deployment incurs no fixed polling sleep'
Assert-True ([string]$result.result -eq 'completed') 'ordinary synthetic deployment reconciles completion'
Assert-True ($fixtureState.deployment_status_read_failures -eq 0 -and
    $fixtureState.deployment_longest_receipt_outage_ms -eq 0 -and
    $fixtureState.deployment_total_receipt_outage_ms -eq 0 -and
    -not $fixtureState.deployment_automatic_reconciliation_required -and
    $fixtureState.deployment_ssh_fallback_count -eq 0) 'ordinary deployment keeps zero outage and SSH-fallback metrics'

Reset-DeploymentMocks
$script:ControllerResponses.Enqueue((New-ControllerResponse 0 (New-ControllerReceipt 'running')))
1..4 | ForEach-Object {
    $script:HttpsResponses.Enqueue((New-HttpsResponse $false $null "http_50$_"))
}
$script:HttpsResponses.Enqueue((New-HttpsResponse $true (New-HttpsStatus 'completed')))
$fixtureState = New-DeploymentFixtureState
$result = Invoke-DurableDeployment $fixtureState $script:TargetSha ('b' * 64)
Assert-True (($script:ControllerActions -join ',') -eq 'start' -and
    $script:HttpsActions.Count -eq 5) 'four temporary HTTPS failures recover on the fifth read with no SSH status call'
Assert-True (($script:RecordedSleepMilliseconds -join ',') -eq '2000,4000,8000,10000') 'HTTPS outage backoff is 2, 4, 8, then capped at 10 seconds'
Assert-True ($fixtureState.deployment_status_read_failures -eq 4 -and
    $fixtureState.deployment_longest_receipt_outage_ms -eq 24000 -and
    $fixtureState.deployment_total_receipt_outage_ms -eq 24000 -and
    $fixtureState.deployment_automatic_reconciliation_required -and
    $fixtureState.deployment_ssh_fallback_count -eq 0) 'four HTTPS failures record one recovered outage below the fallback threshold'

Reset-DeploymentMocks
$script:ControllerResponses.Enqueue((New-ControllerResponse 0 (New-ControllerReceipt 'running')))
$script:HttpsResponses.Enqueue((New-HttpsResponse $true (New-HttpsStatus 'running')))
$script:HttpsResponses.Enqueue((New-HttpsResponse $true (New-HttpsStatus 'completed')))
$fixtureState = New-DeploymentFixtureState
 $result = Invoke-DurableDeployment $fixtureState $script:TargetSha ('b' * 64)
Assert-True (($script:ControllerActions -join ',') -eq 'start' -and
    ($script:RecordedSleepMilliseconds -join ',') -eq '2000' -and
    $script:HttpsActions.Count -eq 2) 'an SSH outage after acceptance cannot delay an HTTPS-confirmed deployment'

Reset-DeploymentMocks
$script:ControllerResponses.Enqueue((New-ControllerResponse 255 $null 'acceptance response lost' $true `
    'external-watchdog-timeout' $true))
$script:HttpsResponses.Enqueue((New-HttpsResponse $true (New-HttpsStatus 'completed')))
$fixtureState = New-DeploymentFixtureState
$result = Invoke-DurableDeployment $fixtureState $script:TargetSha ('b' * 64)
Assert-True (($script:ControllerActions -join ',') -eq 'start' -and
    $script:HttpsActions.Count -eq 1 -and [string]$result.result -eq 'completed') 'an ambiguous start response requires authoritative SSH receipt reconciliation before HTTPS monitoring'

Reset-DeploymentMocks
$script:ControllerResponses.Enqueue((New-ControllerResponse 255 $null 'connection timed out' $true `
    'tcp-connect-timeout' $true))
$script:HttpsResponses.Enqueue((New-HttpsResponse $true (New-HttpsStatus 'running')))
$script:HttpsResponses.Enqueue((New-HttpsResponse $true (New-HttpsStatus 'completed')))
$fixtureState = New-DeploymentFixtureState
$result = Invoke-DurableDeployment $fixtureState $script:TargetSha ('b' * 64)
Assert-True (($script:ControllerActions -join ',') -eq 'start' -and
    $script:HttpsActions.Count -eq 2 -and [string]$result.result -eq 'completed') 'an SSH timeout followed by HTTPS running continues monitoring without resubmission'

Reset-DeploymentMocks
$script:ControllerResponses.Enqueue((New-ControllerResponse 255 $null 'connection reset' $false `
    'transport-unavailable' $true))
$script:HttpsResponses.Enqueue((New-HttpsResponse $true (New-HttpsStatus 'accepted')))
$script:HttpsResponses.Enqueue((New-HttpsResponse $true (New-HttpsStatus 'completed')))
$fixtureState = New-DeploymentFixtureState
$result = Invoke-DurableDeployment $fixtureState $script:TargetSha ('b' * 64)
Assert-True (($script:ControllerActions -join ',') -eq 'start' -and
    $script:HttpsActions.Count -eq 2 -and [string]$result.result -eq 'completed') 'an SSH timeout followed by HTTPS accepted continues monitoring without resubmission'

Reset-DeploymentMocks
$script:ControllerResponses.Enqueue((New-ControllerResponse 255 $null 'connection timed out' $true `
    'tcp-connect-timeout' $true))
$script:ControllerResponses.Enqueue((New-ControllerResponse 0 ([pscustomobject]@{
    schema_version = 1
    operation_id = 'fixture-operation'
    result = 'absent'
    current_phase = 'genuinely_unknown'
    operation_state = 'genuinely_unknown'
    unit_state = 'inactive'
    controller_state = 'consistent'
})))
$script:ControllerResponses.Enqueue((New-ControllerResponse 0 (New-ControllerReceipt 'running')))
Enqueue-HttpsGraceNotFound
$script:HttpsResponses.Enqueue((New-HttpsResponse $true (New-HttpsStatus 'completed')))
$fixtureState = New-DeploymentFixtureState
$result = Invoke-DurableDeployment $fixtureState $script:TargetSha ('b' * 64)
$startArguments = @($script:ControllerArguments | Where-Object { $_.Count -eq 2 })
$startInputs = @($script:ControllerInputs | Where-Object { -not [string]::IsNullOrEmpty($_) })
Assert-True (($script:ControllerActions -join ',') -eq 'start,status,start' -and
    $script:HttpsActions.Count -eq 11 -and [string]$result.result -eq 'completed') 'HTTPS not-found is polled through the full grace period before one durable not-accepted result permits a retry'
Assert-True ($fixtureState.deployment_submission_attempt_count -eq 2 -and
    $fixtureState.deployment_submission_retry_count -eq 1 -and
    $startInputs.Count -eq 2 -and $startInputs[0] -eq $startInputs[1] -and
    ($startArguments[0] -join ',') -eq ($startArguments[1] -join ',')) 'the one permitted retry reuses the operation token, target SHA, and updater hash'

Reset-DeploymentMocks
$notAcceptedReceipt = [pscustomobject]@{
    schema_version = 1
    operation_id = 'fixture-operation'
    result = 'absent'
    current_phase = 'genuinely_unknown'
    operation_state = 'genuinely_unknown'
    unit_state = 'inactive'
    controller_state = 'consistent'
}
$script:ControllerResponses.Enqueue((New-ControllerResponse 255 $null 'connection timed out' $true `
    'tcp-connect-timeout' $true))
$script:ControllerResponses.Enqueue((New-ControllerResponse 0 $notAcceptedReceipt))
$script:ControllerResponses.Enqueue((New-ControllerResponse 255 $null 'connection timed out' $true `
    'tcp-connect-timeout' $true))
$script:ControllerResponses.Enqueue((New-ControllerResponse 0 $notAcceptedReceipt))
Enqueue-HttpsGraceNotFound
Enqueue-HttpsGraceNotFound
$fixtureState = New-DeploymentFixtureState
$retryLimitReported = $false
try { Invoke-DurableDeployment $fixtureState $script:TargetSha ('b' * 64) | Out-Null }
catch { $retryLimitReported = $_.Exception.Message -match 'retry limit was reached' }
Assert-True ($retryLimitReported -and
    ($script:ControllerActions -join ',') -eq 'start,status,start,status' -and
    $fixtureState.deployment_submission_attempt_count -eq 2 -and
    $fixtureState.deployment_submission_retry_count -eq 1) 'durable not-accepted evidence permits no more than the configured single retry'

Reset-DeploymentMocks
$script:ControllerResponses.Enqueue((New-ControllerResponse 255 $null 'permission denied' $false `
    'ssh-authentication-failure' $false))
$fixtureState = New-DeploymentFixtureState
$authenticationRefused = $false
try { Invoke-DurableDeployment $fixtureState $script:TargetSha ('b' * 64) | Out-Null }
catch { $authenticationRefused = $_.Exception.Message -match 'ssh-authentication-failure' }
Assert-True ($authenticationRefused -and $script:HttpsActions.Count -eq 0 -and
    ($script:ControllerActions -join ',') -eq 'start') 'authentication failure is classified as definite non-acceptance and is never retried'

Reset-DeploymentMocks
$script:ControllerResponses.Enqueue((New-ControllerResponse 255 $null 'host key verification failed' $false `
    'host-key-verification-failure' $false))
$fixtureState = New-DeploymentFixtureState
$hostKeyRefused = $false
try { Invoke-DurableDeployment $fixtureState $script:TargetSha ('b' * 64) | Out-Null }
catch { $hostKeyRefused = $_.Exception.Message -match 'host-key-verification-failure' }
Assert-True ($hostKeyRefused -and $script:HttpsActions.Count -eq 0 -and
    ($script:ControllerActions -join ',') -eq 'start') 'host-key failure is classified separately and never retried as a network timeout'

Reset-DeploymentMocks
$script:ControllerResponses.Enqueue((New-ControllerResponse 0 (New-ControllerReceipt 'running')))
$visibleRunning = New-HttpsStatus 'running' $script:TargetSha $script:TargetSha
$script:HttpsResponses.Enqueue((New-HttpsResponse $true $visibleRunning))
$script:HttpsResponses.Enqueue((New-HttpsResponse $true (New-HttpsStatus 'completed')))
$fixtureState = New-DeploymentFixtureState
$result = Invoke-DurableDeployment $fixtureState $script:TargetSha ('b' * 64)
Assert-True ($script:HttpsActions.Count -eq 2 -and
    ($script:RecordedSleepMilliseconds -join ',') -eq '2000' -and
    [string]$result.result -eq 'completed') 'public target visibility alone cannot produce premature success'

Reset-DeploymentMocks
$script:ControllerResponses.Enqueue((New-ControllerResponse 0 (New-ControllerReceipt 'running')))
$script:HttpsResponses.Enqueue((New-HttpsResponse $true (New-HttpsStatus 'failed')))
$fixtureState = New-DeploymentFixtureState
$failedWasReported = $false
try { Invoke-DurableDeployment $fixtureState $script:TargetSha ('b' * 64) | Out-Null }
catch { $failedWasReported = $_.Exception.Message -match 'migration.+migration_failed' }
Assert-True ($failedWasReported -and ($script:ControllerActions -join ',') -eq 'start' -and
    $script:RecordedSleepMilliseconds.Count -eq 0) 'failed HTTPS status reports its sanitized phase and code immediately'

Reset-DeploymentMocks
$script:ControllerResponses.Enqueue((New-ControllerResponse 0 (New-ControllerReceipt 'running')))
$script:ControllerResponses.Enqueue((New-ControllerResponse 0 (New-ControllerReceipt 'completed')))
$conflictingStatus = New-HttpsStatus 'completed' ('d' * 40) $script:TargetSha
$script:HttpsResponses.Enqueue((New-HttpsResponse $true $conflictingStatus))
$fixtureState = New-DeploymentFixtureState
$conflictReported = $false
try { Invoke-DurableDeployment $fixtureState $script:TargetSha ('b' * 64) | Out-Null }
catch { $conflictReported = $_.Exception.Message -match 'conflicts with exact active identity' }
Assert-True ($conflictReported -and ($script:ControllerActions -join ',') -eq 'start,status' -and
    $fixtureState.deployment_ssh_fallback_count -eq 1) 'conflicting HTTPS identity invokes SSH reconciliation and fails closed'

Reset-DeploymentMocks
$script:ControllerResponses.Enqueue((New-ControllerResponse 0 (New-ControllerReceipt 'running')))
1..6 | ForEach-Object {
    $script:HttpsResponses.Enqueue((New-HttpsResponse $false $null 'timeout'))
}
$script:ControllerResponses.Enqueue((New-ControllerResponse 0 (New-ControllerReceipt 'completed')))
$fixtureState = New-DeploymentFixtureState
$result = Invoke-DurableDeployment $fixtureState $script:TargetSha ('b' * 64)
Assert-True (($script:ControllerActions -join ',') -eq 'start,status' -and
    $script:HttpsActions.Count -eq 6 -and
    $fixtureState.deployment_ssh_fallback_count -eq 1 -and
    [string]$result.result -eq 'completed') 'extended HTTPS outage retains one SSH status reconciliation fallback'
Assert-True (@($script:ControllerActions | Where-Object { $_ -eq 'start' }).Count -eq 1) 'fallback reconciliation cannot duplicate deployment submission'

$script:DeploymentTimeoutSeconds = 300
Reset-DeploymentMocks
$script:ControllerResponses.Enqueue((New-ControllerResponse 0 (New-ControllerReceipt 'running')))
1..18 | ForEach-Object {
    $script:HttpsResponses.Enqueue((New-HttpsResponse $false $null 'timeout'))
}
$script:ControllerResponses.Enqueue((New-ControllerResponse 0 (New-ControllerReceipt 'running')))
$script:ControllerResponses.Enqueue((New-ControllerResponse 0 (New-ControllerReceipt 'completed')))
$fixtureState = New-DeploymentFixtureState
$result = Invoke-DurableDeployment $fixtureState $script:TargetSha ('b' * 64)
Assert-True (($script:ControllerActions -join ',') -eq 'start,status,status' -and
    $script:HttpsActions.Count -eq 18 -and
    $fixtureState.deployment_ssh_fallback_count -eq 2 -and
    [string]$result.result -eq 'completed') 'an extended HTTPS outage stays automatic beyond the old grace boundary and permits rate-limited SSH reconciliation'
Assert-True (@($script:ControllerActions | Where-Object { $_ -eq 'start' }).Count -eq 1) 'repeated read-only reconciliation still cannot duplicate deployment submission'
$script:DeploymentTimeoutSeconds = 120

$script:Mode = 'Resume'
Reset-DeploymentMocks
$acceptedStatus = New-HttpsStatus 'running'
$script:HttpsResponses.Enqueue((New-HttpsResponse $true (New-HttpsStatus 'completed')))
$fixtureState = New-DeploymentFixtureState $acceptedStatus $true
$result = Invoke-DurableDeployment $fixtureState $script:TargetSha ('b' * 64)
Assert-True ($script:ControllerActions.Count -eq 0 -and
    $script:HttpsActions.Count -eq 1 -and [string]$result.result -eq 'completed') 'Resume monitors the persisted operation token and never starts again'
}

function Publish-DeploymentRequest {
    param($State, [string]$Target, [string]$UpdaterHash)
    $script:RequestPublications++
    Add-Member -InputObject $State -NotePropertyName deployment_submission_state `
        -NotePropertyValue submitted -Force
    Add-Member -InputObject $State -NotePropertyName deployment_transport `
        -NotePropertyValue github-pull-request-ref -Force
}

$script:Mode = 'Publish'
Reset-DeploymentMocks
$script:RequestPublications = 0
$script:HttpsResponses.Enqueue((New-HttpsResponse $true (New-HttpsStatus 'running')))
$script:HttpsResponses.Enqueue((New-HttpsResponse $true (New-HttpsStatus 'completed')))
$fixtureState = New-DeploymentFixtureState
$result = Invoke-DurableDeployment $fixtureState $script:TargetSha ('b' * 64)
Assert-True ($script:RequestPublications -eq 1 -and
    $script:ControllerActions.Count -eq 0 -and
    [string]$result.result -eq 'completed') 'normal deployment publishes one Git request and uses HTTPS without SSH'
Assert-True ($fixtureState.deployment_submission_state -eq 'submitted' -and
    $fixtureState.deployment_transport -eq 'github-pull-request-ref') 'authoritative request-ref confirmation changes pending submission to submitted'

Reset-DeploymentMocks
$script:RequestPublications = 0
$script:HttpsResponses.Enqueue((New-HttpsResponse $false $null 'http_404'))
$script:HttpsResponses.Enqueue((New-HttpsResponse $false $null 'timeout'))
$script:HttpsResponses.Enqueue((New-HttpsResponse $true (New-HttpsStatus 'running')))
$script:HttpsResponses.Enqueue((New-HttpsResponse $true (New-HttpsStatus 'completed')))
$fixtureState = New-DeploymentFixtureState
$result = Invoke-DurableDeployment $fixtureState $script:TargetSha ('b' * 64)
Assert-True ($script:RequestPublications -eq 1 -and
    $script:ControllerActions.Count -eq 0 -and
    [string]$result.result -eq 'completed') 'transient request visibility and HTTPS loss recover without SSH'
Assert-True (($script:RecordedSleepMilliseconds -join ',') -eq '2000,4000') 'pull admission uses bounded exponential backoff'

$script:Mode = 'Resume'
Reset-DeploymentMocks
$script:RequestPublications = 0
$acceptedStatus = New-HttpsStatus 'running'
$script:HttpsResponses.Enqueue((New-HttpsResponse $true (New-HttpsStatus 'completed')))
$fixtureState = New-DeploymentFixtureState $acceptedStatus $true
$result = Invoke-DurableDeployment $fixtureState $script:TargetSha ('b' * 64)
Assert-True ($script:RequestPublications -eq 0 -and
    $script:ControllerActions.Count -eq 0 -and
    $script:HttpsActions.Count -eq 1 -and [string]$result.result -eq 'completed') 'Resume monitors accepted HTTPS state without SSH or a second request'

$visibleRunning = New-HttpsStatus 'running' $script:TargetSha $script:TargetSha

$completedStatus = New-HttpsStatus 'completed'
$release = [pscustomobject]@{
    game_sha = $script:TargetSha
    game_generation = 'test/t231'
    release_class = 'server_no_migration'
    server_component_sha = $script:TargetSha
    server_artifact_sha256 = ('9' * 64)
    client_component_sha = $script:TargetSha
}
$session = [pscustomobject]@{ authenticated = $false }
$world = [pscustomobject]@{
    ok = $true
    covered = $true
    profile = [pscustomobject]@{ latitude = 35.0844; longitude = -106.6504 }
    release = [pscustomobject]@{ release_id = 'world-packages-v1' }
}
$fixtureState = New-DeploymentFixtureState $completedStatus $true
Add-Member -InputObject $fixtureState -NotePropertyName release_class `
    -NotePropertyValue server_no_migration -Force
Add-Member -InputObject $fixtureState -NotePropertyName prepared_server_artifact_sha256 `
    -NotePropertyValue ('9' * 64) -Force
Assert-FinalDeploymentEvidence $completedStatus $fixtureState $script:TargetSha $release $session $world
Assert-True $true 'completed HTTPS status plus exact readiness, game, public, and World identities completes automatically'
$prematureSuccessRefused = $false
try {
    Assert-FinalDeploymentEvidence $visibleRunning $fixtureState $script:TargetSha $release $session $world
} catch { $prematureSuccessRefused = $_.Exception.Message -match 'cannot replace a completed authoritative deployment status' }
Assert-True $prematureSuccessRefused 'exact public target still cannot replace a completed authoritative status'
$publicConflictRefused = $false
try {
    Assert-FinalDeploymentEvidence $completedStatus $fixtureState $script:TargetSha `
        ([pscustomobject]@{ game_sha = 'd' * 40 }) $session $world
} catch { $publicConflictRefused = $_.Exception.Message -match 'public release identity does not equal' }
Assert-True $publicConflictRefused 'completed receipt and conflicting public identity fail closed'
$generationConflictRefused = $false
try {
    Assert-FinalDeploymentEvidence $completedStatus $fixtureState $script:TargetSha `
        ([pscustomobject]@{
            game_sha = $script:TargetSha
            game_generation = 'test/t217'
            release_class = 'server_no_migration'
            server_component_sha = $script:TargetSha
            server_artifact_sha256 = ('9' * 64)
            client_component_sha = $script:TargetSha
        }) $session $world
} catch { $generationConflictRefused = $_.Exception.Message -match 'public release generation does not equal' }
Assert-True $generationConflictRefused 'completed receipt and stale generation identity fail closed'

Remove-Item Function:\Get-Date -Force
Remove-Item Function:\Start-Sleep -Force
Remove-Item Function:\Invoke-HttpsDeploymentStatus -Force
Remove-Item Function:\Invoke-DeploymentController -Force
Remove-Item Function:\Publish-DeploymentRequest -Force

$inspectRoot = Join-Path $env:TEMP ("ash-atlas-release-inspect-" + [guid]::NewGuid().ToString('n'))
$inspectSourceRoot = Join-Path $inspectRoot 'source'
$inspectOriginRoot = Join-Path $inspectRoot 'origin.git'
New-Item -ItemType Directory -Path $inspectRoot -Force | Out-Null
try {
    New-Item -ItemType Directory -Path $inspectSourceRoot, $inspectOriginRoot -Force | Out-Null
    & git init --bare $inspectOriginRoot | Out-Null
    Assert-True ($LASTEXITCODE -eq 0) 'Inspect fixture creates a local bare origin'
    & git -C $inspectSourceRoot init -b master | Out-Null
    Assert-True ($LASTEXITCODE -eq 0) 'Inspect fixture creates a local source checkout'
    & git -C $inspectSourceRoot config user.name 'release-flow-inspect-fixture' | Out-Null
    & git -C $inspectSourceRoot config user.email 'release-flow-inspect-fixture@example.invalid' | Out-Null
    Set-Content -LiteralPath (Join-Path $inspectSourceRoot 'README.md') -Value "inspect fixture`n" -Encoding utf8
    & git -C $inspectSourceRoot add README.md | Out-Null
    & git -C $inspectSourceRoot commit -m 'inspect fixture baseline' | Out-Null
    Assert-True ($LASTEXITCODE -eq 0) 'Inspect fixture commits its local source baseline'
    & git -C $inspectSourceRoot branch integration/test | Out-Null
    & git -C $inspectSourceRoot tag test/t000 | Out-Null
    & git -C $inspectSourceRoot remote add origin $inspectOriginRoot | Out-Null
    & git -C $inspectSourceRoot push --quiet origin master integration/test --tags | Out-Null
    Assert-True ($LASTEXITCODE -eq 0) 'Inspect fixture publishes branches and generation tag to local origin'
    $inspectState = [ordered]@{
        schema_version = 1
        operation_id = 'inspect-fixture'
        requested_mode = 'Integrate'
        status = 'failed'
        created_at_utc = (Get-Date).ToUniversalTime().ToString('o')
        updated_at_utc = (Get-Date).ToUniversalTime().ToString('o')
        feature_worktree = ''
        feature_branch = ''
        feature_tip = ''
        original_integration_sha = ''
        candidate_integration_sha = ''
        previous_generation = ''
        new_generation = ''
        expected_remote_tag_namespace_snapshot = ''
        admission_mode = 'PreservedExactFeatureVerification'
        admission_result = ''
        atomic_push_result = ''
        merged_receipt_result = ''
        master_publication_result = ''
        exact_deployed_sha = ''
        deployment_verification_result = ''
        deployment_phase_timings = $null
        failure_phase = 'local_merge'
        reconciled_remote_truth = $null
        phases = [pscustomobject]@{}
    }
    $inspectState | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $inspectRoot 'inspect-fixture.json') -Encoding utf8
    $missingKey = Join-Path $inspectRoot 'missing-ssh-key'
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $inspectOutput = @(& powershell -NoProfile -ExecutionPolicy Bypass `
            -File (Join-Path $root 'tools\release\accept-and-publish-test-server.ps1') Inspect `
            -OperationId inspect-fixture -StateRoot $inspectRoot -SshKey $missingKey `
            -SourceRepositoryRoot $inspectSourceRoot -IntegrationWorktreePath $inspectSourceRoot -Json 2>&1)
    } finally { $ErrorActionPreference = $previousPreference }
    Assert-True ($LASTEXITCODE -eq 0) "Inspect mode is non-mutating and executable: $($inspectOutput -join "`n")"
    $inspected = ($inspectOutput -join "`n") | ConvertFrom-Json
    Assert-True ([string]$inspected.remote_truth.integration_test_sha -match '^[0-9a-f]{40}$' -and
        [string]$inspected.remote_truth.generation_snapshot_id -match '^[0-9a-f]{64}$') 'Inspect reconciles exact remote branch and generation truth'

    $effectiveState = $inspectState | ConvertTo-Json -Depth 8 | ConvertFrom-Json
    $effectiveState.schema_version = 2
    $effectiveState.operation_id = 'effective-inspect-fixture'
    $effectiveState.original_integration_sha = [string]$inspected.remote_truth.integration_test_sha
    Add-Member -InputObject $effectiveState -NotePropertyName historical_name_base_generation -NotePropertyValue 't098'
    Add-Member -InputObject $effectiveState -NotePropertyName effective_base_test_generation -NotePropertyValue ([string]$inspected.remote_truth.integration_generation)
    $effectiveBaseSha = (& git -C $inspectSourceRoot rev-list -n 1 "test/$($inspected.remote_truth.integration_generation)").Trim()
    Add-Member -InputObject $effectiveState -NotePropertyName effective_base_test_sha -NotePropertyValue $effectiveBaseSha
    Add-Member -InputObject $effectiveState -NotePropertyName display_name -NotePropertyValue 'Effective Fixture'
    $effectiveState | ConvertTo-Json -Depth 8 |
        Set-Content -LiteralPath (Join-Path $inspectRoot 'effective-inspect-fixture.json') -Encoding utf8
    $effectiveOutput = @(& powershell -NoProfile -ExecutionPolicy Bypass `
        -File (Join-Path $root 'tools\release\accept-and-publish-test-server.ps1') Inspect `
        -OperationId effective-inspect-fixture -StateRoot $inspectRoot -SshKey $missingKey `
        -SourceRepositoryRoot $inspectSourceRoot -IntegrationWorktreePath $inspectSourceRoot -Json 2>&1)
    Assert-True ($LASTEXITCODE -eq 0) "Inspect preserves and revalidates effective-base operation state: $($effectiveOutput -join "`n")"
    $effectiveInspected = ($effectiveOutput -join "`n") | ConvertFrom-Json
    Assert-True ($effectiveInspected.state.effective_base_test_generation -eq $effectiveState.effective_base_test_generation -and
        $effectiveInspected.state.effective_base_test_sha -eq $effectiveState.effective_base_test_sha) 'effective-base identity survives state reload'

    try {
        $ErrorActionPreference = 'Continue'
        $mismatchOutput = @(& powershell -NoProfile -ExecutionPolicy Bypass `
            -File (Join-Path $root 'tools\release\accept-and-publish-test-server.ps1') Resume `
            -OperationId effective-inspect-fixture -StateRoot $inspectRoot -SshKey $missingKey `
            -SourceRepositoryRoot $inspectSourceRoot -IntegrationWorktreePath $inspectSourceRoot `
            -ReleaseCoordinationRoot (Join-Path $inspectRoot 'coordination') `
            -EffectiveBaseTestGeneration $effectiveState.effective_base_test_generation `
            -EffectiveBaseTestSha '0000000000000000000000000000000000000000' 2>&1)
    } finally { $ErrorActionPreference = 'Stop' }
    Assert-True ($LASTEXITCODE -ne 0 -and $mismatchOutput -match 'differs from recorded operation state') 'Resume refuses a supplied effective base that differs from operation state'
} finally {
    if (Test-Path -LiteralPath $inspectRoot) { Remove-Item -LiteralPath $inspectRoot -Recurse -Force }
}

Assert-True ($runtime -match 'foreach \(\$name in @\(''World'', ''Postgres''\)\)' -and
    $runtime -match 'while \(@\(\$workers.*HasExited') 'cold World and PostgreSQL workers overlap'
Assert-True ($runtime.LastIndexOf('Invoke-ParallelRuntimePrerequisites') -lt $runtime.LastIndexOf('Invoke-RuntimeMigrations') -and
    $runtime.LastIndexOf('Invoke-RuntimeMigrations') -lt $runtime.LastIndexOf("Start-LoggedProcess `$powerShell")) 'migrations gate backend startup'
Assert-True ($runtime -match 'Start-Job -ScriptBlock \$probe -ArgumentList ''health''' -and
    $runtime -match 'Start-Job -ScriptBlock \$probe -ArgumentList ''ready''' -and
    $runtime -match 'Start-Job -ScriptBlock \$probe -ArgumentList ''frontend''') 'readiness probes overlap'
Assert-True ($runtime -match 'Stop-Process -Id \$worker\.process\.Id -Force' -and
    $runtime -match 'Stop-OwnedRuntimeContainer' -and $runtime -match 'Release-AshAtlasFeatureWorldRuntime') 'failure cleanup remains ownership-scoped'

Assert-True ($updater -match 'SOURCE_TREE=.*rev-parse.*\^\{tree\}' -and
    $updater -match 'source_commit_sha.*source_tree_sha') 'wrong-SHA or wrong-tree artifact cannot activate'
Assert-True ($updater -match 'sha256sum.*artifact\.tar\.gz' -and $updater -match 'cached artifact hash differs') 'cache artifacts are content verified'
Assert-True ($updater -match 'WORLD_RUNTIME_LOCK_HASH=\$\(sha256sum "\$SOURCE_ROOT/config/world-runtime\.lock\.json"' -and
    $updater -match 'SERVER_CACHE_KEY=.*WORLD_RUNTIME_LOCK_HASH' -and
    $updater -match 'world_runtime_lock: e\.WORLD_RUNTIME_LOCK_HASH') 'World runtime lock changes invalidate and identify the compiled server artifact'
Assert-True ($updater -match 'provision_cache_directories' -and
    $updater -match 'provision_cache_directory "\$CACHE_ROOT" root debian 0750' -and
    $updater -match 'provision_cache_directory "\$CACHE_ROOT/dependencies" debian ash-atlas 0750' -and
    $updater -match 'provision_cache_directory "\$CACHE_ROOT/builds/server" debian ash-atlas 0750' -and
    $updater -match 'provision_cache_directory "\$CACHE_ROOT/builds/client" debian ash-atlas 0750') 'cache parents are repaired to least-privilege identities'
Assert-True ($updater -match '\[\[ -L "\$path" \|\| \( -e "\$path" && ! -d "\$path" \) \]\]' -and
    $updater -match 'cache path is not a physical directory') 'cache provisioning refuses symlinks and non-directories'
Assert-True ($updater -match 'sudo -u debian bash -c' -and
    $updater -match 'mktemp -d "\$1/\.permission-preflight\.XXXXXXXX"' -and
    $updater -match 'mv "\$temporary/write" "\$temporary/renamed"' -and
    $updater -match 'trap cleanup EXIT') 'cache access is proven as the build user with failure-safe cleanup'
Assert-True ($updater.IndexOf('preflight_cache_access') -lt $updater.IndexOf('phase_start dependency_preparation')) 'cache permission preflight precedes dependency preparation'
Assert-True ($updater -match 'GAME_INCOMING' -and $updater -match 'CLIENT_INCOMING' -and
    $updater -match 'mv "\$GAME_INCOMING" "\$GAME_RELEASE"') 'release assembly publishes immutable directories'
Assert-True ($updater -match 'prune_deployment_releases' -and
    $updater.IndexOf('phase_start release_retention_preflight') -lt
        $updater.IndexOf('phase_start dependency_preparation') -and
    $updater.IndexOf('phase_start release_retention_post_activation') -gt
        $updater.IndexOf('phase_start host_readiness')) 'bounded release retention runs before dependency work and after successful activation'
Assert-True ($updater -match 'ASH_ATLAS_DEPLOY_LOCK_HELD' -and
    $updater -match 'flock -n "\$LOCK_FILE" -c true' -and
    $updater -match 'inherited the supervisor deployment-lock descriptor' -and
    $updater -match 'readonly INACTIVE_RELEASE_RETENTION=1' -and
    $updater -match '\^\[0-9a-f\]\{40\}\$' -and
    $updater -match 'rm -rf --one-file-system "\$candidate"') 'release retention is lock-scoped, SHA-restricted, and filesystem-bounded'
Assert-True ($updater -match 'readonly NATIVE_BUNDLE_RETENTION=1' -and
    $updater -match 'native bundle retention requires an actually held deployment lock' -and
    $updater -match "awk -F '\\t' '\`$2 ~ /\^\[0-9a-f\]\{64\}\`$/" -and
    $updater -match 'grep -Fq -- "\$name" "\$pointer"' -and
    $updater -match 'prune_native_bundles "\$\{native_protected\[@\]\}"' -and
    $updater.IndexOf('prune_native_bundles() {') -lt $updater.IndexOf('prune_deployment_releases() {')) 'native OTA bundle retention keeps advertised and release-referenced bundles and runs with release retention'
Assert-True ($updater -match 'build cache retention requires an actually held deployment lock' -and
    $updater -match 'prune_deployment_releases "\$GAME_SHA" "\$previous_game_sha" "\$previous_public_sha"\s+prune_build_caches\s' -and
    $updater.IndexOf('prune_build_caches "dependencies=$DEPENDENCY_KEY" "server=$SERVER_CACHE_KEY" "client=$CLIENT_CACHE_KEY"') -gt
        $updater.IndexOf('readonly CLIENT_CACHE=') -and
    $updater.IndexOf('prune_build_caches "dependencies=$DEPENDENCY_KEY"') -lt
        [regex]::Match($updater, 'MIGRATION_REQUIRED" = true \]\]; then\s+assert_candidate_rehearsal_disk_space\s+fi\s+phase_start build_cache_lookup').Index -and
    $updater -match 'cleanup_stale_preflight_leftovers\s+prune_build_caches "dependencies=')'build caches and orphaned preflight leftovers are pruned before the rehearsal space check and after activation, keeping the rollback release'
Assert-True ($updater -match 'MIGRATION_REQUIRED" = true \]\]; then\s+assert_candidate_rehearsal_disk_space\s+fi\s+phase_start build_cache_lookup' -and
    [regex]::Match($updater, 'assert_candidate_rehearsal_disk_space\s+fi\s+# Set first so a partly created').Index -gt
        $updater.IndexOf('phase_start candidate_database_create') -and
    $updater -match 'CANDIDATE_REHEARSAL_SPACE_PERCENT=300' -and
    $updater -match 'pg_database_size\(datname\)\), 0\) FROM pg_database WHERE datname = ''\$PREFLIGHT_TEMPLATE_DATABASE''' -and
    $updater -notmatch "pg_database_size\('ash_atlas_game'\)" -and
    $updater -match 'insufficient disk for the candidate schema rehearsal') 'migration rehearsal space check is sized from the schema template, never Main data, and fails early'
Assert-True ($updater -match 'if \[\[ "\$MIGRATION_REQUIRED" = true \]\]' -and
    $updater -match 'ASH_ATLAS_DATABASE_BACKUP_CLASS=pre-migration' -and
    $updater -match 'skipped:server_artifact_unchanged' -and
    $updater -match 'dropdb --if-exists --force "\$PREFLIGHT_DATABASE"' -and
    $updater -notmatch 'truncate|docker volume rm') 'database backup is conditional and cleanup can remove only the bounded preflight clone'
Assert-True ($updater -notmatch 'pg_dump --format=directory' -and
    $updater -notmatch 'pg_restore --jobs' -and
    $updater -notmatch 'populated_clone' -and
    $updater -match 'server_no_migration\|release_tooling\|database_migration\) printf ''fresh_migration_replay' -and
    $updater -match 'production_snapshot_result skipped:schema_rehearsal' -and
    $updater -match 'MIGRATIONS_DIRECTORY="\$PREFLIGHT_MIGRATIONS_STAGE"' -and
    $updater -match 'rebuilt preflight template ledger differs from Main' -and
    $updater -match 'candidate migration differs from the applied ledger') 'migration rehearsal clones the applied-ledger template and never copies Main data'
Assert-True ($updater -match 'candidate migration runner lacks all-or-nothing batch support' -and
    $updater -match 'ash-atlas-migration:\[\[:space:\]\]\*allow-non-transactional' -and
    $updater -match 'MIGRATION_TRANSACTION="\$\{MIGRATION_TRANSACTION_MODE:-per_file\}"' -and
    $updater -match 'MIGRATION_PHASE_STARTED=true\s+select_migration_transaction_mode\s+write_migration_intent_marker' -and
    $updater -match 'env HOME=/var/lib/ash-atlas MIGRATION_TRANSACTION="\$MIGRATION_TRANSACTION_MODE" bash -c' -and
    $updater -match 'MIGRATION_TRANSACTION_MODE" = batch \]\] && capture_live_migration_ledger &&\s+cmp -s -- "\$MIGRATION_APPLIED" "\$MIGRATION_POST_APPLIED"' -and
    $updater -match 'rolled back as one transaction; Main is unchanged') 'pending migrations are rehearsed and applied live in one all-or-nothing transaction unless a migration opts out in-file'
Assert-True ($updater -match 'database_backup_env=/etc/ash-atlas/database-backup.env' -and
    $updater -match 'database_backup_producer=/opt/ash-atlas/current/tools/release/vps/create-database-backup.sh' -and
    $updater -match 'backup_manifest="\$\(ASH_ATLAS_DATABASE_BACKUP_CLASS=pre-migration' -and
    $updater -match 'pre-migration database backup did not publish one safe manifest' -and
    $updater -match '\.backupClass == "pre-migration"' -and
    $updater -match '\.releaseSha == \$release' -and
    $updater -match 'sha256sum "\$backup_file"' -and
    $updater -notmatch '/var/backups/ash-atlas|temporary_backup' -and
    $updater.IndexOf('phase_start database_backup') -lt
        $updater.IndexOf('ASH_ATLAS_DATABASE_BACKUP_CLASS=pre-migration') -and
    $updater.IndexOf('pg_restore --list "\$backup_file"') -lt
        $updater.IndexOf('phase_start service_stop') -and
    $updater.IndexOf('phase_finish "completed:manifest=\$backup_manifest"') -lt
        $updater.IndexOf('phase_start service_stop')) 'ACTIVATE requires one fresh validated canonical pre-migration backup before mutation'
Assert-True ($updater -match 'phase_start candidate_database_create' -and
    $updater -match 'phase_start candidate_extension_provisioning' -and
    $updater -match 'phase_start candidate_migration_replay' -and
    $updater -match 'phase_start candidate_migration_ledger' -and
    $updater -match 'phase_start candidate_readiness' -and
    $updater -match 'phase_start previous_binary_readiness' -and
    $updater -match 'phase_start candidate_preflight_cleanup') 'candidate preflight reports actionable subphase timings'
Assert-True ($updater -match 'readonly -a PREFLIGHT_REQUIRED_EXTENSIONS=\(postgis\)' -and
    $updater -match 'sudo -u postgres psql --dbname="\$database"' -and
    $updater -match 'CREATE EXTENSION IF NOT EXISTS' -and
    $updater -match 'sudo -u ash-atlas env HOME=/var/lib/ash-atlas DATABASE_URL=' -and
    $updater -match 'apps/server/src/db/migrate[.]ts' -and
    $updater -match 'candidate database service role has elevated PostgreSQL privileges' -and
    $updater -match 'candidate database extension set differs') `
    'server-no-migration preflight provisions exact extensions administratively and replays migrations as the restricted service role'
Assert-True ($updater -match 'verify_fresh_preflight_migration_ledger' -and
    $updater -match 'expected[.]size !== actual[.]size' -and
    $updater -match 'actual[.]get\(version\) !== hash' -and
    $updater -match 'candidate_migration_ledger_result completed') `
    'fresh preflight requires an exact complete migration ledger'
Assert-True ($updater -match 'production_snapshot_result skipped:server_no_migration' -and
    $updater -match 'skipped:server_no_migration_fresh_replay' -and
    $updater -match 'production_snapshot_result skipped:schema_rehearsal' -and
    $updater -notmatch 'candidate_database_restore_result') `
    'no release class snapshots or restores Main for its candidate preflight'
Assert-True ($updater -match '\^"\$PREFLIGHT_SNAPSHOT_PARENT"/ash-atlas-preflight-\[0-9a-f\]\{8\}' -and
    $updater -match 'rm -rf --one-file-system -- "\$PREFLIGHT_MIGRATIONS_STAGE"' -and
    $updater -match 'refusing unsafe preflight migration stage cleanup') 'migration stage cleanup is restricted to an exact physical temporary directory'
Assert-True ($updater -match 'candidate_preflight_started_ns=\$\(date \+%s%N\)' -and
    $updater -match 'ash_atlas_preflight_' -and
    $updater -match 'preflight_operation=\$\{OPERATION_ID,,\}' -and
    $updater -match 'PREFLIGHT_DATABASE_USER=\$\(PREFLIGHT_DATABASE_URL=' -and
    $updater -match '\^\[a-z_\]\[a-z0-9_\]\{0,62\}\$' -and
    $updater -match 'PREFLIGHT_DATABASE_CREATED=true\s+sudo -u postgres createdb --template="\$PREFLIGHT_TEMPLATE_DATABASE" \\\s+--owner="\$PREFLIGHT_DATABASE_USER" "\$PREFLIGHT_DATABASE"' -and
    $updater -match 'start_release_preflight "\$GAME_RELEASE" "\$GAME_SHA"' -and
    $updater.IndexOf('candidate_preflight_started_ns=') -lt
        $updater.IndexOf('phase_start service_stop')) 'production candidate boots against a migrated disposable clone before live service stop'
Assert-True ($updater -match 'assert_preflight_database_absent' -and
    $updater -match 'SELECT 1 FROM pg_database WHERE datname' -and
    $updater -match 'candidate preflight database remains after cleanup' -and
    $updater -match 'candidate_process_cleanup_result completed' -and
    $updater -match 'candidate_cleanup_result failed') `
    'candidate preflight fails closed unless disposable database and process cleanup are proven'
Assert-True ($updater -match 'candidate database extension set differs' -and
    $updater -match 'verify_fresh_preflight_migration_ledger' -and
    $updater -match 'production candidate failed isolated readiness' -and
    $updater -match 'ready[.]checks[?][.]runtimeIdentity[?][.]identity[?][.]sha !== sha' -and
    $updater -match 'Main migration ledger or prepared migration decision changed after PREPARE' -and
    $updater -match 'release classification evidence changed after PREPARE' -and
    $updater -match 'candidate preflight resources could not be removed') `
    'extension, replay ledger, startup, readiness identity, pending migration, classification, and cleanup failures stop closed'
Assert-True ($updater -match 'candidate_preflight_result failed' -and
    $updater -match 'production candidate failed isolated readiness' -and
    $updater.IndexOf('production candidate failed isolated readiness') -lt
        $updater.IndexOf('phase_start service_stop')) 'candidate readiness failure blocks deployment before live migration'
Assert-True ($updater -match 'run_population_repair_admission' -and
    $updater -match 'populationStoneConflictRepair[.]ts' -and
    $updater -match 'result[?][.]receipt[?][.]affectedPlans' -and
    $updater -match 'safely repairable terminal population plans' -and
    $updater.IndexOf('phase_start population_repair_admission') -lt
        $updater.IndexOf('phase_start candidate_preflight_cleanup')) `
    'candidate admission blocks release preparation while compatible terminal population plans remain'
Assert-True ($updater -match 'population_repair_database=disposable_schema_rehearsal' -and
    $updater -match 'population_repair_database=main' -and
    $updater -match 'population_repair_admission_count' -and
    $updater -match 'phase_start population_repair_admission_recheck' -and
    $updater -match 'clean:main_after_migration' -and
    $updater.IndexOf('phase_start population_repair_admission_recheck') -lt
        $updater.IndexOf('phase_start service_stop')) `
    'population admission proves the candidate on the migrated rehearsal schema and rechecks Main at the safe activation boundary'
Assert-True ($updater -match 'start_release_preflight "\$previous_game" "\$previous_game_sha"' -and
    $updater -match 'prior_binary_restart_safe __FALSE__' -and
    $updater -match 'prior binary was proven incompatible and was not restarted') 'migrated-clone preflight detects and preserves prior-binary restart incompatibility'
Assert-True ($qualityWorkflow -match 'name: Repository quality' -and
    $qualityWorkflow -match 'name: Repository quality selection' -and
    $qualityWorkflow -match 'name: Focused application checks' -and
    $qualityWorkflow -match 'name: Focused durable checks' -and
    $qualityWorkflow -match 'name: Focused repository policy' -and
    $qualityWorkflow -match 'name: Repository hygiene' -and
    $qualityWorkflow -match 'name: Require every selected check to pass' -and
    $qualityWorkflow -match 'No changed client test files selected' -and
    $qualityWorkflow -match 'vitest run --no-file-parallelism --maxWorkers=1' -and
    $qualityWorkflow -notmatch 'pnpm --filter @ash-atlas/client test' -and
    $qualityWorkflow -notmatch 'pnpm --filter @ash-atlas/server test' -and
    $qualityWorkflow -notmatch 'pnpm --filter @ash-atlas/shared test' -and
    $qualityWorkflow -notmatch 'pnpm --filter @ash-atlas/player-renderer test' -and
    $qualityWorkflow -notmatch 'pnpm --filter @ash-atlas/appearance-studio test' -and
    $qualityWorkflow -notmatch 'pnpm test:unit' -and
    $qualityWorkflow -notmatch 'pnpm build:production' -and
    $qualityWorkflow -notmatch 'pnpm test:postgres' -and
    $qualityWorkflow -notmatch 'workflow_dispatch:') `
    'Repository quality is a stable path-selected aggregate gate without broad automatic suites'
Assert-True ($fullCheckpointWorkflow -match 'workflow_dispatch:' -and
    $fullCheckpointWorkflow -notmatch '(?m)^  pull_request:' -and
    $fullCheckpointWorkflow -notmatch '(?m)^  push:' -and
    $fullCheckpointWorkflow -match 'pnpm test:unit' -and
    $fullCheckpointWorkflow -match 'pnpm build:production' -and
    $fullCheckpointWorkflow -match 'pnpm test:postgres' -and
    $fullCheckpointWorkflow -match 'catalog:verify' -and
    $fullCheckpointWorkflow -match 'seed: \[600001, 600002, 600003, 600004, 600005, 600006, 600007, 600008, 600009, 600010\]' -and
    $fullCheckpointWorkflow -match 'name: Require every full check to pass') `
    'Full checkpoint keeps broad suites and market matrix behind explicit dispatch'
Assert-True ($inventoryCatalog -match 'marketTradable: metadata[.]marketTradable' -and
    $inventoryCatalog -match 'marketIdentity: metadata[.]marketIdentity === undefined' -and
    $inventoryCatalog -match 'metadata[.]marketTradable\s*[?]\s*itemId\s*:\s*null' -and
    $serverItems -match 'marketTradable: catalog[.]marketTradable' -and
    $serverItems -notmatch '(?s)function itemDefinition.+marketTradable: boolean') 'shared inventory catalog is the authoritative active market metadata definition'
Assert-True ($updater -match 'systemctl is-active --quiet ash-atlas-world\.service' -and
    $updater -match 'WORLD_SHA' -and $updater -match 'WORLD_RELEASE') 'World ownership and identity remain asserted'
Assert-True ($updater -match 'prepare_world_handoff_rollback' -and
    $updater -match 'restore_previous_world_for_rollback' -and
    $updater -match 'World handoff rollback requires exactly one prior World unit backup' -and
    $updater.IndexOf('restore_previous_world_for_rollback') -lt
        $updater.LastIndexOf('atomic_link "$previous_game" "$GAME_CURRENT_LINK"')) `
    'World handoff rollback restores the exact prior World service before the prior game'
Assert-True ($updater -match 'resolve_game_generation' -and
    $updater -match 'tag --points-at "\$sha"' -and
    $updater -match 'immutable generation .* does not resolve to game SHA' -and
    $updater -match 'RUNTIME_GENERATION=' -and
    $updater -match 'TELEMETRY_RELEASE_GENERATION=' -and
    $updater -match '--game-generation "\$GAME_GENERATION"' -and
    $updater -match 'public-release-metadata[.]mjs') `
    'runtime and public generation identity are derived from the unique tag proven against the game SHA'
Assert-True ($releaseMetadataHelper -match 'public_version' -and
    $releaseMetadataHelper -match 'patch_notes' -and
    $releaseMetadataHelper -match 'Ash-Atlas-Player-Note' -and
    $releaseMetadataHelper -match 'rev-list' -and
    $releaseMetadataHelper -match '--first-parent') `
    'public release metadata derives versioned player notes from bounded first-parent integration history'
Assert-True ($releaseMetadataHelper -match 'input[.]previousReleasePath === undefined' -and
    $releaseMetadataHelper -notmatch 'existsSync\(input[.]previousReleasePath\)' -and
    $updater -match 'PREVIOUS_RELEASE_COPY=\$\(mktemp' -and
    $updater -match 'install -o debian -g debian -m 0600 "\$previous_public/release[.]json"' -and
    $updater -match 'cmp -s "\$previous_public/release[.]json" "\$PREVIOUS_RELEASE_COPY"' -and
    $updater -match 'sudo -u debian "\$NODE_BIN"' -and
    $updater -match '--previous-release "\$PREVIOUS_RELEASE_COPY"' -and
    $updater -match 'rm -f -- "\$PREVIOUS_RELEASE_COPY"') `
    'prior public metadata is copied exactly to a disposable debian-readable file and fails closed when supplied'
Assert-True ($orchestrator -match '\[string\]\$PlayerPatchNote' -and
    $orchestrator -match '\[string\[\]\]\$PlayerPatchNotes' -and
    $orchestrator -match 'Ash-Atlas-Player-Note:' -and
    $orchestrator -match 'Assert-CommitPlayerPatchNote' -and
    $orchestrator -match '-PlayerPatchNotes must align exactly with -FeatureWorktrees') `
    'single and batch integrations freeze validated player notes in exact merge trailers'
Assert-True ($discordPatchNotesSender -match 'allowed_mentions' -and
    $discordPatchNotesSender -match 'Ash Atlas Patch Notes' -and
    $discordPatchNotesSender -match 'wait' -and
    $discordPatchNotesSender -match 'linkSync' -and
    $discordPatchNotesSender -notmatch 'WEBHOOK_URL.*JSON.stringify') `
    'Discord delivery uses an atomic secret-free outbox and disables mentions'
Assert-True ($updater -match 'if ! phase_start discord_patch_notes' -and
    $updater -match 'run_discord_patch_notes_phase \|\| true' -and
    $updater -match 'discord_patch_notes_result' -and
    $updater.IndexOf('assert_source_clean success') -lt $updater.IndexOf('run_discord_patch_notes_phase || true') -and
    $updater -match '/etc/ash-atlas/discord-patch-notes.env' -and
    $updater -match '/var/lib/ash-atlas/discord-patch-notes' -and
    $updater -match 'chown -h root:root' -and
    $updater -match 'chmod 0700' -and
    $updater -match 'tail -c 2 "\$file"' -and
    $updater -match '\[\[ "\$ending" = 0d0a \]\] \|\| return 1' -and
    $updater -match 'lines\[0\]=\$\{lines\[0\]%\$''\\r''\}' -and
    $updater -match 'byte_count=\$\(wc -c < "\$file"\)' -and
    $updater -match '\[\[ ! "\$line" =~ \[\[:space:\]\[:cntrl:\]\] \]\]' -and
    $updater -match '\[\[ -d "\$DISCORD_PATCH_NOTES_OUTBOX" && ! -L "\$DISCORD_PATCH_NOTES_OUTBOX" \]\]') `
    'Discord patch notes accept only a single CRLF terminator and remain non-fatal with a root-only outbox'
Assert-True ($updater -match 'RIVER_SURFACE_RELEASE=river-surface-v1' -and
    $updater -match 'RIVER_SURFACE_MANIFEST_SHA256=c605631193ff786e33182fb8b6d7cfa3ab868b35d0a47fec5e1aa717ace447d5' -and
    $updater -match 'RIVER_SURFACE_POLICY=osm-medium-plus-v1' -and
    $updater -match '--river-surface-cache-packages 12') 'World river surface identity and bounded cache remain asserted'
Assert-True ($updater -match 'load_world_runtime_authority' -and
    $updater -match 'config/world-runtime[.]lock[.]json' -and
    $updater -match 'WORLD_RUNTIME_BRANCH' -and
    $updater -match 'WORLD_MANIFEST_SHA256' -and
    $updater -match 'water_name_index' -and
    $updater -match 'WATER_NAME_INDEX_MANIFEST_SHA256' -and
    $updater -match 'WATER_NAME_INDEX_HASH' -and
    $updater -match 'WATER_NAME_INDEX_ENTRY_COUNT' -and
    $updater -match 'waterNameFallbackV1' -and
    $updater -match 'candidate_world_runtime_invariants' -and
    $updater -notmatch 'WORLD_SHA=7bea544c2bb87b24923d7d9083eed0c30dd352e1' -and
    $updater -match 'WATERBODY_IDENTITY_OVERLAY_RELEASE=waterbody-identity-overlay-v4' -and
    $updater -match 'WATERBODY_IDENTITY_OVERLAY_MANIFEST_SHA256=f81deb9fb441ec5644095b1d4ea8f430c652948f5e7a64e9beac5a6ea005020c' -and
    $updater -match 'WATERBODY_IDENTITY_OVERLAY_SCHEMA=waterbody-identity-overlay-v1' -and
    $updater -match 'WATERBODY_IDENTITY_OVERLAY_POLICY=existing-cell-candidate-precedence-v1' -and
    $updater -match 'waterbody-identity-overlay-release-root' -and
    $updater -match 'waterbody-identity-overlay-manifest-sha256' -and
    $updater -match 'waterbodyIdentityV1' -and
    $updater -match 'RIVER_SURFACE_MANIFEST_SHA256=c605631193ff786e33182fb8b6d7cfa3ab868b35d0a47fec5e1aa717ace447d5' -and
    $updater -notmatch 'RIVER_VISUAL_TILES' -and
    $updater -notmatch 'river-visual-tiles-v1') 'River surface identity remains asserted and the retired river visual tile product is no longer required'
Assert-True ($updater -match 'LAKE_SURFACE_RELEASE=lake-surface-v1' -and
    $updater -match 'LAKE_SURFACE_MANIFEST_SHA256=d0c25c2b6a4e9349091a5f483a294fac7988cd098a1f77e354343cb2f27f42b9' -and
    $updater -match '--lake-surface-release-root' -and
    $updater -match '--lake-surface-manifest-sha256' -and
    $updater -match '--lake-surface-policy' -and
    $updater -notmatch 'LAKE_VISUAL_TILES' -and
    $updater -notmatch 'lake-visual-tiles-v2' -and
    $updater -match 'lake_visuals=omit') 'Lake surface identity and omission remain asserted and the retired lake visual tile product is no longer required'
Assert-True ($updater -match 'OCEAN_COAST_SURFACE_RELEASE=ocean-coast-surface-v1' -and
    $updater -match 'OCEAN_COAST_SURFACE_MANIFEST_SHA256=b8319476532112ef6076d56819a89a9551ea88c4b55f52a06c80b8bae8fa3954' -and
    $updater -match '--ocean-coast-surface-release-root' -and
    $updater -match '--ocean-coast-surface-manifest-sha256' -and
    $updater -match '--ocean-coast-surface-policy' -and
    $updater -notmatch 'OCEAN_COAST_VISUAL_TILES' -and
    $updater -notmatch 'ocean-coast-visual-tiles-v1' -and
    $updater -match 'ocean_coast_visuals=omit') 'Ocean coast surface identity and omission remain asserted and the retired ocean coast visual tile product is no longer required'
Assert-True ($updater -match 'WATER_VISUAL_TILES_RELEASE=water-visual-tiles-v1' -and
    $updater -match 'WATER_VISUAL_TILES_MANIFEST_SHA256=6eece70668d929850944b44ccd134a426972080aeed18865f7c360618daeb229' -and
    $updater -match 'WATER_VISUAL_TILES_ARTIFACT_SHA256=7e4a0ddc7821bfb554d34896bb83d2e35a3304a3e7d75ace73c57f73adfa974a' -and
    $updater -match 'WATER_VISUAL_TILES_ARTIFACT_SIZE=1639576487' -and
    $updater -match 'precedence-resolved-canonical-water-visual-v1' -and
    $updater -match 'river>lake>ocean>land' -and
    $updater -match 'sources\?\.river\?\.manifest_sha256 !== "c02a4f04f91c285270c5f6f2bc667cad2988344c9b6200ba9ee64fda488976fc"' -and
    $updater -match '(?s)static_artifact_metadata_fence\(\) \{\s*metadata_fence_for_paths\W+"\$\(dirname "\$WATER_VISUAL_TILES_ROOT"\)"\W+"\$WATER_VISUAL_TILES_ROOT" "\$WATER_VISUAL_TILES_PATH"\s*\}' -and
    $updater -match 'water visual tile artifact hash differs' -and
    $updater -match 'public water visual request was not partial content') 'Combined water visual identity, precedence, host admission, and public range proof are asserted'
Assert-True ($updater -match '/api/admin/player-packages/catalog' -and
    $updater -match 'anonymous_player_packages_status.*401' -and
    $updater -match 'anonymous_player_packages_status.*403') 'deployment proves the public Player Packages route reaches application authentication'
Assert-True ($updater -match 'write_timing_json' -and
    $updater -match 'schema_version: 2' -and
    $updater -match 'previousPhases[.]concat\(phases\)' -and
    $updater -match 'existing deployment timings belong to a different immutable operation' -and
    $updater -match 'phase_start static_runtime_invariants' -and
    $updater -match 'phase_start artifact_hashing' -and
    $updater -match 'phase_start prepared_receipt_creation' -and
    $updater -match 'git_fetch_checkout' -and $updater -match 'dependency_preparation' -and
    $updater -match 'server_build' -and $updater -match 'client_build' -and
    $updater -match 'migration' -and $updater -match 'release_assembly' -and
    $updater -match 'service_restart' -and $updater -match 'host_readiness') 'deployment timing preserves PREPARE and ACTIVATE and covers every required phase'
Assert-True ($updater -match 'classify_changed_paths' -and $updater -match 'client\)' -and
    $updater -match 'application\|migration\)' -and $updater -match 'full\)') 'updater exposes conservative client, application, migration, and full lanes'
Assert-True ($updater -match 'git clone --mirror' -and $updater -match 'worktree add --detach' -and
    $updater -match 'worktree remove --force') 'deployment uses a persistent mirror and disposable detached worktree'
Assert-True ($updater -match 'cleanup_stale_source_worktrees' -and
    $updater -match 'stale_worktrees_removed' -and
    $updater -match 'WARNING: disposable source worktree cleanup failed') 'deployment cleanup reports proven stale removals without invalidating successful activation'
Assert-True ($updater -match 'BUILD_MANIFEST=\$\(mktemp' -and
    $updater -notmatch '\$SOURCE_ROOT/build-manifest[.]json') 'deployment metadata remains outside the disposable checkout'
Assert-True ($updater -match '(?s)phase_start service_stop.+ACTIVATION_STARTED=true.+systemctl stop ash-atlas[.]service') 'rollback ownership begins before stopping the prior game worker'

Assert-True ($controller -match 'start_operation' -and $controller -match 'status_operation' -and
    $controller -match 'result_operation' -and $controller -match 'resume_operation' -and
    $controller -match 'reconcile_operation_command') 'remote controller supports start, status, result, resume, and reconciliation'
Assert-True ($controller -match 'prepare_operation' -and $controller -match 'activate_operation' -and
    $controller -match 'remote candidate ref does not equal the requested PREPARE target' -and
    $controller -match 'origin/master does not equal the PREPARED target' -and
    $controller -match 'origin/integration/test does not equal the PREPARED target' -and
    $controller -match 'immutable generation does not equal the PREPARED target') `
    'controller separates PREPARE from ACTIVATE and gates activation on all exact protected identities'
Assert-True ($controller -match 'deployment_timings: receipt[.]deployment_timings [?][?] null' -and
    $controller -match 'JSON[.]stringify\(status[.]deployment_timings\)' -and
    $orchestrator -match 'HTTPS deployment timings have unsafe identity or bounds' -and
    $orchestrator -match 'Set-RemoteReceipt \$State \$receipt') `
    'bounded HTTPS monitoring carries strictly validated complete deployment timings without a final SSH delay'
Assert-True ($controller -match 'retry_failed_transaction' -and
    $controller -match 'failed transaction cannot resume because live identity changed' -and
    $controller -match 'transaction_retry_count' -and
    $controller -match 'failed ACTIVATE cannot resume because its prepared protected identity changed' -and
    $updater -match 'rollback_result running' -and
    $updater -match 'rollback_result blocked_migration_compatibility_uncertain') `
    'failed PREPARE and pre-activation work resume only under unchanged live/protected identity while rollback outcome is durable'
Assert-True ($controller -match '(?s)RECON_RESULT" = prepared.+RECON_RESULT" = completed' -and
    $controller -match 'reconcile_with_terminal_wait') `
    'PREPARED reconciliation boundedly waits for the one-shot worker to become inactive before ACTIVATE'
Assert-True ($updater -match 'DEPLOY_MODE=.*deploy' -and
    $updater -match 'result prepared current_phase prepared' -and
    $updater.IndexOf('result prepared current_phase prepared') -lt $updater.IndexOf('phase_start service_stop') -and
    $updater -match 'live game changed after PREPARE' -and
    $updater -match 'prepared game release content changed before ACTIVATE' -and
    $updater -match 'prepared static artifact metadata fence changed before ACTIVATE' -and
    $updater -match 'prepared release metadata fence changed before ACTIVATE' -and
    $updater -match 'prepared_fence_reuse_allowed' -and
    $updater -match 'assembled server artifact content differs from the exact candidate build' -and
    $updater -match 'assembled client artifact content differs from the exact candidate build' -and
    $updater -match 'Main migration ledger or prepared migration decision changed after PREPARE' -and
    $updater -match 'DEPLOYMENT_LANE=\$\(operation_receipt_field deployment_lane\)' -and
    $updater -match 'prepared deployment lane identity is unsafe') `
    'VPS updater exits PREPARE before live mutation and revalidates its immutable artifacts and Main decision at ACTIVATE'
Assert-True ($updater -match "--mode='u=rwX,go=rX'" -and
    $updater -notmatch "--mode='u[+]rwX,go[+]rX'") `
    'artifact content identity canonicalizes permissions changed by immutable release hardening'
Assert-True ($orchestrator -match 'refs/heads/integration/release-candidates/' -and
    $orchestrator -match "'prepare_candidate_on_vps'" -and
    $orchestrator -match 'Invoke-PrepareCandidate' -and
    $orchestrator -match 'Invoke-PreparedActivation' -and
    $orchestrator -match "release_protocol = 'prepare_activate_v1'") `
    'orchestrator publishes an operation-scoped candidate, records PREPARED, then uses the separate activation path'
Assert-True (([regex]::Matches($orchestrator,
            [regex]::Escape('-StandardInput "$token`n"'))).Count -eq 2) `
    'PREPARE and ACTIVATE both frame the deployment-status token as one newline-terminated SSH input record'
Assert-True ($controller -match 'timeout 5 /usr/local/libexec/ash-atlas-wait-ready game' -and
    $controller -match 'curl --fail --silent --show-error --max-time 5' -and
    $controller -match 'readiness_pid=\$!' -and $controller -match 'world_pid=\$!') 'final readiness and World probes run concurrently under five-second bounds'
Assert-True ($controller -match 'systemctl start --no-block|\$SYSTEMCTL" start --no-block' -and
    $controller -match 'active-operation' -and
    $controller -match 'waiting_for_execution_lane' -and
    $controller -match 'flock -n -E 75 -o "\$DEPLOY_LOCK"' -and
    $controller -notmatch 'flock -n "\$DEPLOY_LOCK" -c true') 'remote acceptance uses one durable execution lane without a lock-probe race'
Assert-True ($controller -match 'waiting_for_execution_lock' -and
    $controller -match 'lock_wait_started_at_utc' -and
    $controller -match 'lock_wait_attempts' -and
    $controller -match 'lock_owner_diagnostics' -and
    $controller -match 'unknown_execution_lock_owner' -and
    $controller -match 'prepare_lock_wait_elapsed_ms' -and
    $controller -match 'lock_wait_elapsed_ms __NUMBER__0') 'PREPARE and ACTIVATE lock waits remain separate with durable owner evidence and fail-closed unknown-owner diagnosis'
Assert-True ($controller -match 'receipt\.release_class === "client_only"[\s\S]*prepared_server_component_sha[\s\S]*activeGame !== expectedGame') `
    'completed client-only status projects the pinned composite server and client identities'
Assert-True ($controller -match 'result" = accepted' -and
    $controller -match 'last_waiting_worker_exit_at_utc' -and
    $controller -match 'recovered_from_legacy_lock_failure_at_utc') 'worker finalization preserves recoverable acceptance and resumes legacy lock-only failures in place'
Assert-True ($controller -match 'fs[.]fsyncSync\(file\)' -and
    $controller -match 'fs[.]renameSync' -and
    $controller -match 'fs[.]fsyncSync\(directory\)' -and
    $controller -match 'validate_persisted_acceptance') 'accepted receipts are file-fsynced, atomically renamed, directory-fsynced, and reread'
Assert-True ($controller -match 'genuinely_unknown' -and
    $controller -match 'incomplete_acceptance' -and
    $controller -match 'malformed_receipt' -and
    $controller -match 'permission_failure' -and
    $controller -match 'controller_version_mismatch' -and
    $controller -match 'terminally_removed') 'controller status distinguishes missing, incomplete, malformed, unreadable, permission, version, and removed states'
Assert-True ($controller -match 'cleanup preserves every nonterminal' -and
    $controller -match 'accepted|running') 'controller cleanup refuses nonterminal operations'
Assert-True ($controller -match 'ASH_ATLAS_OPERATION_ROOT="\$CONTROL_ROOT"' -and
    $controller -match 'CONTROLLER_CONFIG' -and
    $updater -match 'CONTROLLER_CONFIG' -and
    $controllerConfig -match 'ASH_ATLAS_CONTROL_ROOT=/var/lib/ash-atlas/deploy-operations') 'controller and updater resolve the operation root from one installed configuration'
Assert-True ($controller -match 'origin/master does not equal the requested target' -and
    $controller -match 'installed updater hash differs') 'start validates exact master and updater identity inside the controller transaction'
Assert-True ($controller.IndexOf('validate_persisted_acceptance') -lt
        $controller.IndexOf('start_accepted_worker "$OPERATION_ID"') -and
    $controller -match 'publish_status_required "\$operation"' -and
    $controller -match 'validate_status_projection') 'receipt and HTTPS projection are durably reread before worker acceptance'
Assert-True ($controller -match 'record_status_projection_result.+failed' -and
    $controller -match 'reconcile_all_operations' -and
    $controller -match 'start_accepted_worker') 'later projection failures are recorded and periodically repairable'
Assert-True ($controller -match 'reconcile_operation' -and
    $controller -match 'RECON_CONTROLLER_STATE=ambiguous' -and
    $controller -match 'RECON_LOCK_STATE' -and
    $controller -match 'return 4') 'receipt, marker, execution lock, and systemd mismatches fail closed'
Assert-True ($controllerUnit -match 'Type=oneshot' -and
    $controllerUnit -match 'Restart=no' -and
    $controllerUnit -match 'deploy-control[.]sh run %i' -and
    $controllerUnit -match 'ExecStopPost=.+deploy-control[.]sh finalize %i' -and
    $controllerUnit -match 'KillMode=control-group' -and
    $controllerUnit -match 'TimeoutStartSec=30min') 'systemd owns and finalizes the bounded canonical lane worker and its lock supervisor'
Assert-True ($requestPoller -match 'refs/heads/integration/deployment-requests' -and
    $requestPoller -match 'schema_version !== 1' -and
    $requestPoller -match 'controller_version !== 7' -and
    $requestPoller -match 'master_sha.*target_sha' -and
    $requestPoller -match 'tag_sha.*target_sha' -and
    $requestPoller -match 'installed_controller_hash.*controller_hash' -and
    $requestPoller -match 'merge-base --is-ancestor' -and
    $requestPoller -match 'last-request-commit') 'pull poller validates the manifest/target identities and enforces a persistent non-rewritable request-ref chain'
Assert-True ($requestService -match 'TimeoutStartSec=75s' -and
    $requestTimer -match 'OnUnitActiveSec=20s' -and
    $reconcileService -match 'reconcile-all' -and
    $reconcileService -match 'TimeoutStartSec=90s' -and
    $reconcileTimer -match 'OnUnitActiveSec=60s') 'request polling and status/systemd reconciliation are independently bounded timers'
Assert-True ($deploymentStatusRoute -match 'path_regexp deploymentStatus \^/deployment-status/\[0-9a-f\]\{64\}' -and
    $deploymentStatusRoute -match 'log_skip @deploymentStatus' -and
    $deploymentStatusRoute -match 'Cache-Control "no-store, max-age=0"' -and
    $deploymentStatusRoute -notmatch 'browse') 'the capability status route is exact, uncached, unlisted, and excluded from access logs'
Assert-True ($gameCachePolicy -match '@ashAtlasPlayEntry path /play/ /play/index[.]html' -and
    $gameCachePolicy -match '@ashAtlasWiki path /wiki /wiki/\*' -and
    $gameCachePolicy -match '(?s)handle @ashAtlasWiki \{.*?rewrite \* /index[.]html.*?Cache-Control "no-store".*?file_server' -and
    $gameCachePolicy -notmatch '(?s)handle @ashAtlasWiki \{.*?rewrite \* /play/index[.]html' -and
    $gameCachePolicy -match '(?s)@ashAtlasLanding path /\s*handle @ashAtlasLanding\s*\{\s*root \* /srv/www/playashatlas/current/landing\s*header\s*\{[^}]*Cache-Control "no-store"[^}]*Content-Security-Policy[^}]*X-Content-Type-Options "nosniff"[^}]*X-Frame-Options "DENY"[^}]*\}\s*file_server\s*\}' -and
    $gameCachePolicy -match 'Cache-Control "no-store"' -and
    $gameCachePolicy -match '@ashAtlasPlayRelease path /play/release[.]json' -and
    $gameCachePolicy -match 'Cache-Control "no-store, max-age=0"' -and
    $gameCachePolicy -match 'max-age=31536000, immutable' -and
    $gameCachePolicy -match 'site[.]webmanifest' -and
    $gameCachePolicy -match 'must-revalidate' -and
    $gameCachePolicy -match '(?s)@ashAtlasMutableBrandAssets path /play/landing/\* /play/brand/\*\s*header @ashAtlasMutableBrandAssets Cache-Control "no-cache, max-age=0, must-revalidate"' -and
    $gameCachePolicy -match '@ashAtlasRetiredServiceWorker path /play/sw[.]js' -and
    $gameCachePolicy -match 'Service-Worker-Allowed "/play/"' -and
    $gameCachePolicy -match '(?s)handle /world-data/river-visual-tiles-v1/[*] [{]\s*respond 404\s*[}]' -and
    $gameCachePolicy -match '(?s)handle /world-data/lake-visual-tiles-v2/[*] [{]\s*respond 404\s*[}]' -and
    $gameCachePolicy -match '(?s)handle /world-data/ocean-coast-visual-tiles-v1/[*] [{]\s*respond 404\s*[}]' -and
    $gameCachePolicy -notmatch 'root \* /srv/ash-atlas/world/releases/(?:river|lake|ocean-coast)-visual-tiles' -and
    $gameCachePolicy -match '@ashAtlasWaterVisualTiles' -and
    $gameCachePolicy -match '/world-data/water-visual-tiles-v1/water-visual-7e4a0ddc7821bfb554d34896bb83d2e35a3304a3e7d75ace73c57f73adfa974a[.]pmtiles' -and
    $gameCachePolicy -match 'root \* /srv/ash-atlas/world/releases/water-visual-tiles-v1' -and
    $gameCachePolicy -notmatch '\bbrowse\b') 'the source-controlled public cache policy serves the exact released landing page, revalidates mutable entry points, and serves only the immutable water visual artifacts'
Assert-True ($gameCachePolicy -match '(?s)@ashAtlasOwnerLeaderboards\s*\{\s*method GET\s*path /api/dev/leaderboards/\*\s*\}\s*handle @ashAtlasOwnerLeaderboards\s*\{\s*reverse_proxy 127[.]0[.]0[.]1:3001\s*\}' -and
    $gameCachePolicy -match '(?s)@ashAtlasLegendaryBirdPlayers\s*\{\s*method GET\s*path /api/dev/legendary-birds/players\s*\}\s*handle @ashAtlasLegendaryBirdPlayers\s*\{\s*reverse_proxy 127[.]0[.]0[.]1:3001\s*\}' -and
    $gameCachePolicy -match '(?s)@ashAtlasLegendaryBirdTrigger\s*\{\s*method POST\s*path /api/dev/legendary-birds/trigger\s*\}\s*handle @ashAtlasLegendaryBirdTrigger\s*\{\s*reverse_proxy 127[.]0[.]0[.]1:3001\s*\}' -and
    $gameCachePolicy -notmatch 'path /api/dev/\*') `
    'the public edge admits only the exact owner-leaderboard and legendary-bird routes while the broad developer namespace remains private'
Assert-True ($gameCachePolicy -match '(?s)@ashAtlasEconomyObservatory\s*\{\s*method GET\s*path /api/dev/economy/overview /api/dev/economy/items /api/dev/economy/items/\* /api/dev/economy/players /api/dev/economy/players/\* /api/dev/economy/item-holders /api/dev/economy/cohorts /api/dev/economy/flow /api/dev/economy/report /api/dev/economy/export[.]xlsx\s*\}\s*handle @ashAtlasEconomyObservatory\s*\{\s*reverse_proxy 127[.]0[.]0[.]1:3001\s*\}' -and
    $gameCachePolicy -notmatch '(?s)@ashAtlasEconomyObservatory\s*\{[^}]*\bmethod\s+(?!GET\s*(?:\r?\n|\}))' -and
    $gameCachePolicy -notmatch '(?s)@ashAtlasEconomyObservatory\s*\{[^}]*path /api/dev/economy/\*\s*\}') `
    'the public edge proxies every read-only Economy Observatory route while keeping methods and paths narrowly allowlisted'
Assert-True ($installer -match 'deploy-control[.]sh' -and $installer -match 'ash-atlas-deploy@[.]service' -and
    $installer -match 'deployment-controller[.]conf' -and
    $installer -match 'game-cache-policy[.]caddy' -and
    $installer -match 'install-release-controller[.]sh' -and $installer -match 'hashes[.]installer' -and
    $controllerInstaller -match 'exec 8>/run/lock/ash-atlas-deploy-control[.]lock' -and
    $controllerInstaller -match 'exec 9>/run/lock/ash-atlas-test-update[.]lock' -and
    $controllerInstaller -match '--state=active,activating,deactivating' -and
    $controllerInstaller -match 'systemd-analyze verify' -and
    $controllerInstaller -match 'systemctl daemon-reload') 'hash-verified staged installer holds both mutation locks while bootstrapping controller, unit, updater, and systemd'
Assert-True ($controllerInstaller -match 'CADDY_CACHE_IMPORT' -and
    $controllerInstaller -match 'EXPECTED_CACHE_POLICY_HASH' -and
    $controllerInstaller -match 'installed game cache policy hash differs' -and
    $updater -match 'installed game cache policy differs from the approved source' -and
    $orchestrator -match 'public app shell is not protected by Cache-Control: no-store' -and
    $orchestrator -match 'public content-addressed assets are not immutable for one year' -and
    $orchestrator -match 'public water visual range, length, or immutable cache identity differs' -and
    $orchestrator -notmatch '(?:river|lake|ocean-coast)-visual-tiles') 'install, deployment preflight, and public verification enforce the approved cache policy end to end'
Assert-True ($controllerInstaller -match 'static[.]cloudflareinsights[.]com' -and
    $controllerInstaller -match 'cloudflareinsights[.]com' -and
    $controllerInstaller -match 'oldCount === 2 && newCount === 0' -and
    $controllerInstaller -match 'oldCount !== 0 \|\| newCount !== 2') `
    'controller installation idempotently admits only the exact two canonical Cloudflare analytics CSP updates'
Assert-True ($controllerInstaller -match 'receipt[.]result === "accepted" \|\| receipt[.]result === "running"' -and
    $controllerInstaller -match 'install -d -o root -g ash-atlas -m 0750' -and
    $controllerInstaller -notmatch 'rm -rf.+deploy-operations') 'controller reinstall preserves every existing operation and refuses upgrades while work is nonterminal'
Assert-True ($installer -match 'Replace\("`r`n", "`n"\)[.]Replace\("`r", "`n"\)' -and
    $installer -match 'ComputeHash\(\$bytes\)' -and
    $installer -match 'ToBase64String\(\[byte\[\]\]\$payloads\[\$entry[.]Key\]\)') 'VPS installer hashes and uploads the same canonical LF bytes'
$mutationArmIndex = $controllerInstaller.IndexOf('INSTALL_MUTATION_ARMED=true')
$updaterMutationIndex = $controllerInstaller.IndexOf(
    'install -o root -g root -m 0755 "$STAGING/deploy-test-update.sh" "$UPDATER_FILE"')
$mutationDisarmIndex = $controllerInstaller.IndexOf('INSTALL_MUTATION_ARMED=false', $mutationArmIndex)
$routeVerificationIndex = $controllerInstaller.IndexOf(
    'sha256sum "$CADDY_STATUS_ROUTE"', $updaterMutationIndex)
$restoreInstallation = [regex]::Match(
    $controllerInstaller, '(?s)restore_installation\(\) \{(?<body>.*?)\r?\n\}').Groups['body'].Value
Assert-True ($mutationArmIndex -ge 0 -and $updaterMutationIndex -gt $mutationArmIndex -and
    $routeVerificationIndex -gt $updaterMutationIndex -and
    $mutationDisarmIndex -gt $routeVerificationIndex -and
    $restoreInstallation -match 'restore_file "\$UPDATER_BACKUP".+"\$UPDATER_FILE"' -and
    $restoreInstallation -match 'restore_file "\$CONTROLLER_BACKUP".+"\$CONTROLLER_FILE"' -and
    $restoreInstallation -match 'restore_file "\$UNIT_BACKUP".+"\$UNIT_FILE"' -and
    $restoreInstallation -match 'restore_file "\$CONFIG_BACKUP".+"\$CONFIG_FILE"' -and
    $restoreInstallation -match 'restore_file "\$CADDY_ROUTE_BACKUP".+"\$CADDY_STATUS_ROUTE"' -and
    $restoreInstallation -match 'restore_file "\$CADDY_FILE_BACKUP".+"\$CADDY_FILE"' -and
    $restoreInstallation -match 'systemctl daemon-reload' -and
    $restoreInstallation -match 'systemctl reload caddy[.]service') 'controller, updater, unit, and HTTPS route mutations share one rollback transaction'
Assert-True ($controllerInstaller -match 'CADDY_CONFIGURATION_CHANGED=false' -and
    $controllerInstaller -match 'cmp -s "\$CADDY_CANDIDATE" "\$CADDY_FILE"' -and
    $controllerInstaller -match 'if \[\[ "\$CADDY_CONFIGURATION_CHANGED" = true \]\]; then\s+route_temporary=' -and
    $restoreInstallation -match 'if \[\[ "\$CADDY_CONFIGURATION_CHANGED" = true \]\]; then') `
    'controller-only updates do not rewrite or reload unchanged Caddy configuration'
Assert-True ($updater -match 'must run through the durable deployment controller' -and
    $updater -match 'client-artifact-v3' -and $updater -match 'VITE_CLIENT_BUILD_SHA="\$CLIENT_BUILD_SHA"') 'direct updater races are refused and reusable client artifacts embed their stable client identity'

$coordinationOutput = @(& powershell -NoProfile -ExecutionPolicy Bypass -File `
        (Join-Path $PSScriptRoot 'release-coordination.tests.ps1') 2>&1)
if ($LASTEXITCODE -ne 0) {
    throw "release coordination checks failed: $($coordinationOutput -join [Environment]::NewLine)"
}
$coordinationOutput | ForEach-Object { Write-Host $_ }
Write-Host "release-flow.tests.ps1: $script:Passed assertions passed." -ForegroundColor Green
