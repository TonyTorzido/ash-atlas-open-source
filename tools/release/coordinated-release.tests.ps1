Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:Passed = 0
. (Join-Path $PSScriptRoot 'coordinated-release.ps1')

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
    $script:Passed++
}

function Assert-Throws([scriptblock]$Action, [string]$Message) {
    $thrown = $false
    try { & $Action | Out-Null } catch { $thrown = $true }
    Assert-True $thrown $Message
}

$serverSha = 'a' * 40
$masterSha = 'b' * 40
$oldServerSha = 'c' * 40
$artifactSha = 'd' * 64
$toolSha = 'e' * 40
$metadataSha = 'f' * 64

function New-AppFixture([string]$Platform, [string]$ChildOperationId, [string]$StoreStatus,
    [bool]$ManagedPublishing, [bool]$FirstPublish = $false) {
    $kind = if ($FirstPublish) { 'first-publish' } else { 'update' }
    $mode = if ($Platform -eq 'android' -and $FirstPublish) { 'full' } else { 'full' }
    return [pscustomobject][ordered]@{
        release_id = "release-$Platform"
        source_sha = $serverSha
        generation = 't1250'
        marketing_version = '1.2.3'
        build = if ($Platform -eq 'ios') { 17 } else { 23 }
        store_build_id = "store-$Platform"
        artifact_sha256 = $artifactSha
        tooling_sha = $toolSha
        metadata_sha256 = $metadataSha
        countries = @('CA', 'US')
        rollout = [pscustomobject]@{ kind = $kind; mode = $mode }
        child_operation_id = $ChildOperationId
        submitted = $false
        store_status = $StoreStatus
        managed_publishing = $ManagedPublishing
        first_publication_bootstrap_verified = $false
        approval = [pscustomobject]@{
            approved = $false
            fingerprint = ''
            candidate_fingerprint = ''
        }
    }
}

function New-DailyTesterAppFixture([string]$Platform, [string]$ChildOperationId) {
    $entry = New-AppFixture $Platform $ChildOperationId 'TESTER_PREPARED' $false
    $destination = if ($Platform -eq 'ios') {
        [pscustomobject][ordered]@{ kind = 'testflight'; group_type = 'internal'; group_id = 'qa-internal' }
    } else {
        [pscustomobject][ordered]@{ kind = 'google-play-internal'; track = 'internal' }
    }
    $entry | Add-Member -NotePropertyName tester_destination -NotePropertyValue $destination
    $entry | Add-Member -NotePropertyName ready -NotePropertyValue $true
    $entry.submitted = $false
    return $entry
}

$apps = [pscustomobject]@{
    ios = New-AppFixture 'ios' 'coord-fixture-1:ios' 'pending_submission' $false
    android = New-AppFixture 'android' 'coord-fixture-1:android' 'pending_submission' $true
}
$manifest = New-CoordinatedReleaseManifest -OperationId 'coord-fixture-1' `
    -PinnedGeneration 't1250' -PinnedServerSha $serverSha -AcceptedMasterSha $masterSha `
    -CurrentServerSha $oldServerSha -Apps $apps
Assert-True ([string]$manifest.current_phase -eq 'manifest_created') 'new coordinator starts at manifest_created'
Assert-True ([string]$manifest.server.old_server_sha -eq $oldServerSha) 'old server identity is retained in the manifest'
Assert-True (-not (Test-CoordinatedReleaseAppsSubmitted $manifest)) 'submission gate is closed before both child receipts'
Assert-True (-not (Get-CoordinatedReleaseGate $manifest).allowed) 'server gate is closed before both app submissions'

$seed = [pscustomobject][ordered]@{
    schema_version = 1
    kind = 'ash-atlas-coordinated-release-seed'
    operation_id = 'coord-seed-1'
    source = 'mobile-bootstrap'
    pinned = [pscustomobject][ordered]@{
        generation = 't1250'
        server_sha = $serverSha
        accepted_integration_sha = $serverSha
        accepted_master_sha = $masterSha
        current_server_sha = $oldServerSha
    }
    apps = [pscustomobject]@{
        ios = New-AppFixture 'ios' 'coord-seed-1:ios' 'pending_submission' $false
        android = New-AppFixture 'android' 'coord-seed-1:android' 'pending_submission' $true
    }
}
$seedManifest = New-CoordinatedReleaseManifestFromSeed $seed
Assert-True ([string]$seedManifest.operation_id -eq 'coord-seed-1' -and
    [string]$seedManifest.apps.android.child_operation_id -eq 'coord-seed-1:android') `
    'bootstrap seed derives the exact durable operation and child IDs'

$iosFingerprint = Get-CoordinatedReleaseExpectedApprovalFingerprint $manifest.apps.ios 'ios'
$androidFingerprint = Get-CoordinatedReleaseExpectedApprovalFingerprint $manifest.apps.android 'android'
$manifest.apps.ios.submitted = $true
$manifest.apps.ios.store_status = 'SUBMITTED_FOR_REVIEW'
$manifest.apps.android.submitted = $true
$manifest.apps.android.store_status = 'SUBMITTED_FOR_REVIEW'
Assert-True (Test-CoordinatedReleaseAppsSubmitted $manifest) 'both exact submissions open the submission phase'
Advance-CoordinatedReleasePhase $manifest 'apps_submitted' | Out-Null
Assert-Throws { Advance-CoordinatedReleasePhase $manifest 'server_published' } `
    'server publication cannot skip the exact app readiness phase'

Set-CoordinatedReleaseAppEvidence $manifest 'ios' ([pscustomobject]@{
        operation_id = 'coord-fixture-1:ios'; candidate = $manifest.apps.ios.candidate; submitted = $true
        store_status = 'PENDING_DEVELOPER_RELEASE'; approval = [pscustomobject]@{
            approved = $true; fingerprint = $iosFingerprint; candidate_fingerprint = $iosFingerprint
            metadata_sha256 = $metadataSha
        }
    }) | Out-Null
Set-CoordinatedReleaseAppEvidence $manifest 'android' ([pscustomobject]@{
        operation_id = 'coord-fixture-1:android'; candidate = $manifest.apps.android.candidate; submitted = $true
        store_status = 'RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED'; managed_publishing = $true
        approval = [pscustomobject]@{
            approved = $true; fingerprint = $androidFingerprint; candidate_fingerprint = $androidFingerprint
            metadata_sha256 = $metadataSha
        }
    }) | Out-Null
$earlyPublic = $manifest | ConvertTo-Json -Depth 30 | ConvertFrom-Json
$earlyPublic.apps.android.public_available = $true
$earlyPublic.apps.android.public_status = 'RELEASE_LIFECYCLE_STATE_PUBLISHED'
Assert-True (-not (Test-CoordinatedReleasePrePublicationAppsReady $earlyPublic) -and
    -not (Get-CoordinatedReleaseGate $earlyPublic).allowed -and
    [string](Get-CoordinatedReleaseGate $earlyPublic).next_phase -eq 'apps_ready') `
    'pre-publication server gate rejects an early public Android state'
Assert-True (Test-CoordinatedReleaseAppsReady $manifest) `
    'both exact Apple and Google approval/readiness states open server publication'
Advance-CoordinatedReleasePhase $manifest 'apps_ready' | Out-Null
$manifest.server.published = $true
Advance-CoordinatedReleasePhase $manifest 'server_published' | Out-Null
$manifest.server.activated = $true
Advance-CoordinatedReleasePhase $manifest 'server_activated' | Out-Null
$manifest.server.healthy = $true
Advance-CoordinatedReleasePhase $manifest 'server_healthy' | Out-Null

$manifest.apps.ios.release_requested = $true
$manifest.apps.android.release_requested = $true
Advance-CoordinatedReleasePhase $manifest 'apps_release_requested' | Out-Null
Assert-True (-not (Test-CoordinatedReleaseAppsPublic $manifest)) `
    'release requests alone do not prove public availability'
$manifest.apps.ios.public_available = $true
$manifest.apps.ios.public_status = 'READY_FOR_SALE'
$manifest.apps.android.public_available = $true
$manifest.apps.android.public_status = 'RELEASE_LIFECYCLE_STATE_PUBLISHED'
Assert-True (Test-CoordinatedReleaseAppsPublic $manifest) 'both exact public availability states are required'
Advance-CoordinatedReleasePhase $manifest 'completed' | Out-Null
Assert-True ([string]$manifest.completion.status -eq 'completed') 'completion is durable after both public receipts'

$bootstrapApps = [pscustomobject]@{
    ios = New-AppFixture 'ios' 'coord-first-1:ios' 'PENDING_DEVELOPER_RELEASE' $false $true
    android = New-AppFixture 'android' 'coord-first-1:android' 'RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED' $true $true
}
$bootstrap = New-CoordinatedReleaseManifest -OperationId 'coord-first-1' `
    -PinnedGeneration 't1250' -PinnedServerSha $serverSha -AcceptedMasterSha $masterSha `
    -CurrentServerSha $oldServerSha -Apps $bootstrapApps
foreach ($platform in @('ios', 'android')) {
    $entry = $bootstrap.apps.$platform
    $entry.submitted = $true
    $entry.approval.approved = $true
    $fingerprint = Get-CoordinatedReleaseExpectedApprovalFingerprint $entry $platform
    $entry.approval.fingerprint = $fingerprint
    $entry.approval.candidate_fingerprint = $fingerprint
}
Assert-True (-not (Test-CoordinatedReleaseAppsReady $bootstrap)) `
    'first-publication Google bootstrap remains blocked until its explicit hold proof'
$bootstrap.apps.ios.first_publication_bootstrap_verified = $true
$bootstrap.apps.android.first_publication_bootstrap_verified = $true
Assert-True (Test-CoordinatedReleaseAppsReady $bootstrap) `
    'first-publication readiness opens only after bootstrap proof'

$onePublicApps = [pscustomobject]@{
    ios = New-AppFixture 'ios' 'coord-public-1:ios' 'PENDING_DEVELOPER_RELEASE' $false
    android = New-AppFixture 'android' 'coord-public-1:android' 'RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED' $true
}
$onePublic = New-CoordinatedReleaseManifest -OperationId 'coord-public-1' `
    -PinnedGeneration 't1250' -PinnedServerSha $serverSha -AcceptedMasterSha $masterSha `
    -CurrentServerSha $oldServerSha -Apps $onePublicApps
foreach ($platform in @('ios', 'android')) {
    $entry = $onePublic.apps.$platform
    $entry.submitted = $true
    $entry.approval.approved = $true
    $fingerprint = Get-CoordinatedReleaseExpectedApprovalFingerprint $entry $platform
    $entry.approval.fingerprint = $fingerprint
    $entry.approval.candidate_fingerprint = $fingerprint
    $entry.first_publication_bootstrap_verified = $true
}
Advance-CoordinatedReleasePhase $onePublic 'apps_submitted' | Out-Null
Advance-CoordinatedReleasePhase $onePublic 'apps_ready' | Out-Null
$onePublic.server.published = $true
Advance-CoordinatedReleasePhase $onePublic 'server_published' | Out-Null
$onePublic.server.activated = $true
Advance-CoordinatedReleasePhase $onePublic 'server_activated' | Out-Null
$onePublic.server.healthy = $true
$onePublic.server.public_release_sha = $serverSha
Advance-CoordinatedReleasePhase $onePublic 'server_healthy' | Out-Null
$activationRecheck = $onePublic | ConvertTo-Json -Depth 30 | ConvertFrom-Json
$activationRecheck.current_phase = 'server_published'
$activationRecheck.server.activated = $false
$activationRecheck.server.healthy = $false
$activationRecheck.apps.android.store_status = 'DRAFT'
$activationRecheck.apps.android.approval.approved = $false
Assert-Throws { Assert-CoordinatedReleaseActivationReadiness $activationRecheck } `
    'new activation is blocked when a published candidate loses exact app readiness'
$activationRecheck.apps.android.store_status = 'RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED'
$activationRecheck.apps.android.approval.approved = $true
Assert-CoordinatedReleaseActivationReadiness $activationRecheck | Out-Null
Assert-True (-not [bool]$activationRecheck.server.activated) `
    'activation readiness recheck leaves a not-yet-activated operation pending'
$onePublic.apps.ios.release_requested = $true
$onePublic.apps.ios.public_available = $true
$onePublic.apps.ios.public_status = 'READY_FOR_SALE'
Assert-True (Test-CoordinatedReleaseAppsReady $onePublic) `
    'a public iOS child remains ready on a later coordinated Resume'
Assert-True ((Get-CoordinatedReleaseGate $onePublic).next_phase -eq 'apps_release_requested') `
    'one-platform-public state continues at the app release request gate'
$onePublic.apps.android.store_status = 'DRAFT'
$onePublic.apps.android.approval.approved = $false
$laterGate = Get-CoordinatedReleaseGate $onePublic
Assert-True ($laterGate.allowed -and $laterGate.next_phase -eq 'apps_release_requested') `
    'post-publication Resume does not reapply the pre-publication store readiness gate'

$evidenceState = [pscustomobject][ordered]@{
    coordinated_manifest = $onePublic
    remote_deployment_receipt = [pscustomobject][ordered]@{ result = 'completed'; active_game_sha = $serverSha }
    deployment_verification_result = 'fixture health proof'
}
$evidence = New-CoordinatedServerEvidencePayload $evidenceState
Assert-CoordinatedServerEvidencePayload $evidence $onePublic | Out-Null
Assert-True ([string]$evidence.nonce -match '^[0-9a-f]{32}$' -and
    [string]$evidence.candidates.ios.child_operation_id -eq 'coord-public-1:ios') `
    'server health evidence binds the durable operation and both child identities'

$canonicalVector = [pscustomobject][ordered]@{ a = 'x'; b = 2; n = @($true, $null) }
Assert-True ((ConvertTo-CoordinatedCanonicalJson $canonicalVector) -ceq '{"a":"x","b":2,"n":[true,null]}') `
    'cross-language evidence canonical JSON sorts keys and preserves arrays'
$knownKey = [byte[]](0..31)
Assert-True ((Get-CoordinatedHmacSha256Text '{"a":"x","b":2,"n":[true,null]}' $knownKey) -ceq
    'cd5f98f09d7136559555dde956242d5b3641833f8c984721cc9a3278c1e1d525') `
    'cross-language HMAC known-answer vector matches'
Assert-True ((Get-CoordinatedSha256Text '{"a":"x","b":2,"n":[true,null]}') -ceq
    'b61e0e4a982f500d546709094316af966397b3fbb733447888bc600b8cd94057') `
    'cross-language unsigned payload hash known-answer vector matches'
$receiptVector = '{"a":"x","b":2,"hmac_sha256":"cd5f98f09d7136559555dde956242d5b3641833f8c984721cc9a3278c1e1d525","n":[true,null]}'
Assert-True ((Get-CoordinatedSha256Text $receiptVector) -ceq
    '7fd3ca49814ace17063a68290955832479a10743c120bc7aba452174036b70d3') `
    'cross-language authenticated receipt hash known-answer vector matches'
$transportEnvelope = $receiptVector.TrimEnd('}') + ',"receipt_sha256":"' + (('0' * 64) -join '') + '"}'
$transportEnvelopeB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($transportEnvelope))
$nodeHashScript = "const crypto=require('crypto'); process.stdout.write(crypto.createHash('sha256').update(Buffer.from(process.argv[1],'base64')).digest('hex'))"
$nodeTransportHash = ((& node -e $nodeHashScript -- $transportEnvelopeB64) -join '').Trim()
$powershellTransportHash = Get-CoordinatedSha256Text $transportEnvelope
Assert-True ($powershellTransportHash -ceq $nodeTransportHash -and
    $powershellTransportHash -cne '7fd3ca49814ace17063a68290955832479a10743c120bc7aba452174036b70d3') `
    'transport hash covers the exact authenticated evidence bytes separately from receipt fingerprint'

$controlConfig = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'coordinated-release-control.example.json') |
    ConvertFrom-Json
$controllerScript = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'coordinated-release-controller.ps1')
$mobileTransport = Get-Content -Raw -LiteralPath (
    Join-Path $PSScriptRoot 'coordinated-mobile-bootstrap-transport.example.ps1')
$controlWorkflow = Get-Content -Raw -LiteralPath (
    Join-Path $PSScriptRoot '..\..\docs\release\coordinated-release-control-workflow.example.yml')
Assert-True ([string]$controlConfig.trusted_controller.controller_script -match
    '[\\/]tools[\\/]release[\\/]coordinated-release-controller[.]ps1$' -and
    [string]$controlConfig.trusted_controller.source_checkout_root -and
    [string]$controlConfig.trusted_controller.integration_worktree_root -and
    [string]$controlConfig.trusted_controller.tooling_checkout_root -and
    [string]$controlConfig.trusted_controller.source_checkout_root -cne
        [string]$controlConfig.trusted_controller.tooling_checkout_root -and
    $controlWorkflow.Contains('$controlConfig.trusted_controller.controller_script') -and
    -not $controlWorkflow.Contains('.\\tools\\release\\coordinated-release-controller.ps1')) `
    'private control workflow invokes the ACL-protected configured immutable tooling checkout'
Assert-True ($controlWorkflow.Contains("if (`$env:INPUT_OPERATION_ID) { `$controllerArgs += @('-OperationId', `$env:INPUT_OPERATION_ID) };") -and
    -not $controlWorkflow.Contains("'-OperationId', `$env:INPUT_OPERATION_ID, '-ConfigPath'")) `
    'private control workflow omits an empty operation ID so ResumeActive reaches the controller with valid arguments'
Assert-True ([string]$controlConfig.mobile.control_repository -eq 'example-org/release-control' -and
    [string]$controlConfig.mobile.source_repository -eq [string]$controlConfig.repository -and
    [string]$controlConfig.mobile.workflow_ref -match '^refs/tags/' -and
    [string]$controlConfig.mobile.workflow_sha -match '^[A-Z_]+$' -and
    [string]$controlConfig.mobile.tooling_sha -match '^[A-Z_]+$' -and
    [string]$controlConfig.mobile.bootstrap_script -match
        '[\\/]tools[\\/]release[\\/]coordinated-mobile-bootstrap-transport[.]example[.]ps1$' -and
    [string]$controlConfig.mobile.server_evidence_file -match 'LOCAL_TRUSTED') `
    'private mobile transport pins separate control/source identities and a trusted evidence handoff'
Assert-True ($controllerScript -match 'expectedMobileBootstrapScript' -and
    $controllerScript -match 'mobile bootstrap script must be the pinned transport inside tooling_checkout_root' -and
    $controllerScript -match "'-ControlRepository'" -and
    $controllerScript -match "'-ControlSha'" -and
    $controllerScript -match "'-ToolingSha'" -and
    $controllerScript -match 'source_ref = "refs/tags/test/' -and
    $controllerScript -match 'artifact_name = "ash-atlas-private-mobile-') `
    'controller persists and forwards the separate private control identity before mobile dispatch'
Assert-True ($mobileTransport -match 'Get-FileSha256Text' -and
    $mobileTransport -match 'evidenceTransportSha = Get-FileSha256Text \$ServerEvidenceFile' -and
    $mobileTransport -match 'UTF8Encoding]::new\(\$false\)' -and
    $mobileTransport -match 'WriteAllText\(\$temporary' -and
    $mobileTransport -match 'ControlSha' -and $mobileTransport -match 'ToolingSha' -and
    $mobileTransport -match 'ash-atlas-private-mobile-') `
    'mobile transport journals the exact shared evidence bytes and private control artifact identity'

Assert-Throws { Set-CoordinatedReleaseAppEvidence $manifest 'ios' ([pscustomobject]@{
        operation_id = 'wrong-child'; candidate = $manifest.apps.ios.candidate
    }) } 'child operation identity changes are refused'

$tamperedManifest = $manifest | ConvertTo-Json -Depth 20 | ConvertFrom-Json
$tampered = [pscustomobject]@{
    operation_id = 'coord-fixture-1:ios'; candidate = $manifest.apps.ios.candidate; submitted = $true
    store_status = 'PENDING_DEVELOPER_RELEASE'; approval = [pscustomobject]@{
        approved = $true; fingerprint = ('0' * 64); metadata_sha256 = $metadataSha
    }
}
Assert-Throws { Set-CoordinatedReleaseAppEvidence $tamperedManifest 'ios' $tampered } `
    'approval fingerprints must be derived from the exact candidate identity'

# A failed server PREPARE may be retried with new deployment tooling, but the
# already-submitted store candidates remain bound to the original build 8.
$build8Apps = [pscustomobject]@{
    ios = New-DailyTesterAppFixture 'ios' 'coord-build8:ios'
    android = New-DailyTesterAppFixture 'android' 'coord-build8:android'
}
foreach ($platform in @('ios', 'android')) {
    $build8Apps.$platform.marketing_version = '1.1.0'
    $build8Apps.$platform.build = 8
}
$build8Manifest = New-CoordinatedReleaseManifest -OperationId 'coord-build8' `
    -PinnedGeneration 't1250' -PinnedServerSha $serverSha -AcceptedMasterSha $masterSha `
    -CurrentServerSha $oldServerSha -Apps $build8Apps -DeliveryMode 'daily-testers'
foreach ($case in @(
        @{ platform = 'ios'; field = 'build'; value = 9 },
        @{ platform = 'ios'; field = 'artifact_sha256'; value = ('0' * 64) },
        @{ platform = 'android'; field = 'store_build_id'; value = 'other-upload' },
        @{ platform = 'android'; field = 'source_sha'; value = ('1' * 40) }
    )) {
    $platform = [string]$case.platform
    $changedCandidate = $build8Manifest.apps.$platform.candidate |
        ConvertTo-Json -Depth 20 | ConvertFrom-Json
    $changedCandidate.($case.field) = $case.value
    Assert-Throws { Set-CoordinatedReleaseAppEvidence $build8Manifest $platform ([pscustomobject]@{
                operation_id = "coord-build8:$platform"
                candidate = $changedCandidate
                submitted = $true
                ready = $true
            }) } "build 8 $platform submission change in $($case.field) blocks server publication"
}
Assert-True ((Get-CoordinatedReleaseGate $build8Manifest).apps_ready -and
    -not [bool]$build8Manifest.server.published) `
    'rejected build 8 submission evidence cannot publish the server'

$stateRoot = Join-Path $env:TEMP ('ash-atlas-coordinated-fixture-' + [guid]::NewGuid().ToString('n'))
try {
    New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
    Write-CoordinatedReleaseManifest $manifest $stateRoot | Out-Null
    $journal = @(Add-CoordinatedReleaseJournalEntry $manifest 'fixture' 'round trip' @())
    Write-CoordinatedReleaseJournal $stateRoot $manifest.operation_id $journal | Out-Null
    $roundTrip = Read-CoordinatedReleaseManifest (Get-CoordinatedReleaseManifestPath $stateRoot $manifest.operation_id)
    $journalRoundTrip = @(Read-CoordinatedReleaseJournal $stateRoot $manifest.operation_id)
    Assert-True ([string]$roundTrip.pinned.server_sha -eq $serverSha) 'manifest sidecar round trips exact pinned identity'
    Assert-True ($journalRoundTrip.Count -eq 1 -and [string]$journalRoundTrip[0].event -eq 'fixture') `
        'journal sidecar round trips append-only event evidence'
} finally {
    Remove-Item -LiteralPath $stateRoot -Recurse -Force -ErrorAction SilentlyContinue
}

$dailyApps = [pscustomobject]@{
    ios = New-DailyTesterAppFixture 'ios' 'coord-daily-1:ios'
    android = New-DailyTesterAppFixture 'android' 'coord-daily-1:android'
}
$dailyManifest = New-CoordinatedReleaseManifest -OperationId 'coord-daily-1' `
    -PinnedGeneration 't1250' -PinnedServerSha $serverSha -AcceptedMasterSha $masterSha `
    -CurrentServerSha $oldServerSha -Apps $dailyApps -DeliveryMode 'daily-testers'
$dailySeed = [pscustomobject][ordered]@{
    schema_version = 1
    kind = 'ash-atlas-coordinated-release-seed'
    operation_id = 'coord-daily-seed-1'
    delivery_mode = 'daily-testers'
    source = 'mobile-bootstrap'
    pinned = [pscustomobject][ordered]@{
        generation = 't1250'
        server_sha = $serverSha
        accepted_integration_sha = $serverSha
        accepted_master_sha = $masterSha
        current_server_sha = $oldServerSha
    }
    apps = [pscustomobject]@{
        ios = New-DailyTesterAppFixture 'ios' 'coord-daily-seed-1:ios'
        android = New-DailyTesterAppFixture 'android' 'coord-daily-seed-1:android'
    }
}
$dailySeedManifest = New-CoordinatedReleaseManifestFromSeed $dailySeed
Assert-True ([string]$dailySeedManifest.delivery_mode -ceq 'daily-testers' -and
    [bool]$dailySeedManifest.apps.ios.ready -and
    [string]$dailySeedManifest.apps.android.candidate.tester_destination.track -ceq 'internal') `
    'generated daily tester seed delivery mode, destinations, and ready flags survive Start manifest creation'
Assert-True ([string]$dailyManifest.delivery_mode -ceq 'daily-testers' -and
    [string]$dailyManifest.apps.android.candidate.tester_destination.track -ceq 'internal' -and
    [string]$dailyManifest.apps.ios.candidate.tester_destination.group_id -ceq 'qa-internal') `
    'daily tester seed destinations are copied into the durable manifest'
Assert-True ((Get-CoordinatedReleaseGate $dailyManifest).apps_ready -and
    (Test-CoordinatedReleaseAppsReady $dailyManifest)) `
    'prepared daily tester candidates open the pre-publication server gate'
foreach ($platform in @('ios', 'android')) {
    $entry = $dailyManifest.apps.$platform
    $fingerprint = Get-CoordinatedReleaseExpectedApprovalFingerprint $entry $platform
    Set-CoordinatedReleaseAppEvidence $dailyManifest $platform ([pscustomobject]@{
            operation_id = "coord-daily-1:$platform"
            candidate = $entry.candidate
            submitted = $true
            ready = $true
            store_status = 'TESTER_AVAILABLE'
            tester_destination = $entry.candidate.tester_destination
            tester_available = $true
            tester_status = if ($platform -eq 'android') { 'completed' } else { 'IN_BETA_TESTING' }
            release_requested = $true
            public_available = $false
            approval = [pscustomobject]@{
                approved = $true
                fingerprint = $fingerprint
                candidate_fingerprint = $fingerprint
                metadata_sha256 = $metadataSha
            }
            candidate_fingerprint = $fingerprint
            receipt_sha256 = ('1' * 64)
        }) | Out-Null
}
Assert-True (-not (Test-CoordinatedReleaseAppsPublic $dailyManifest) -and
    -not $dailyManifest.apps.ios.tester_available -and
    -not $dailyManifest.apps.android.tester_available) `
    'pre-health tester observations never authorize daily completion'
Advance-CoordinatedReleasePhase $dailyManifest 'apps_submitted' | Out-Null
Advance-CoordinatedReleasePhase $dailyManifest 'apps_ready' | Out-Null
$dailyManifest.server.published = $true
Advance-CoordinatedReleasePhase $dailyManifest 'server_published' | Out-Null
$dailyManifest.server.activated = $true
Advance-CoordinatedReleasePhase $dailyManifest 'server_activated' | Out-Null
$dailyManifest.server.healthy = $true
Advance-CoordinatedReleasePhase $dailyManifest 'server_healthy' | Out-Null
foreach ($platform in @('ios', 'android')) {
    $entry = $dailyManifest.apps.$platform
    $fingerprint = Get-CoordinatedReleaseExpectedApprovalFingerprint $entry $platform
    Set-CoordinatedReleaseAppEvidence $dailyManifest $platform ([pscustomobject]@{
            operation_id = "coord-daily-1:$platform"
            candidate = $entry.candidate
            submitted = $true
            ready = $true
            store_status = 'TESTER_AVAILABLE'
            tester_destination = $entry.candidate.tester_destination
            tester_available = $true
            tester_status = if ($platform -eq 'android') { 'completed' } else { 'IN_BETA_TESTING' }
            release_requested = $true
            public_available = $false
            approval = [pscustomobject]@{
                approved = $true
                fingerprint = $fingerprint
                candidate_fingerprint = $fingerprint
                metadata_sha256 = $metadataSha
            }
            candidate_fingerprint = $fingerprint
            receipt_sha256 = ('2' * 64)
        }) | Out-Null
}
Advance-CoordinatedReleasePhase $dailyManifest 'apps_release_requested' | Out-Null
Assert-True (Test-CoordinatedReleaseAppsPublic $dailyManifest) `
    'post-health TestFlight group and Google Play internal observations open daily completion'
Advance-CoordinatedReleasePhase $dailyManifest 'completed' | Out-Null
Assert-True ([string]$dailyManifest.completion.status -ceq 'completed') `
    'daily tester completion requires the post-health exact availability observations'
$dailyTampered = $dailyManifest | ConvertTo-Json -Depth 30 | ConvertFrom-Json
$dailyTampered.apps.android.candidate.tester_destination.track = 'qa'
Assert-Throws { Assert-CoordinatedReleaseManifest $dailyTampered } `
    'daily tester destination changes are rejected from the durable manifest'

# Exercise the canonical caller's journal argument contract without deployment I/O.
$journalTokens = $null
$journalErrors = $null
$callerAst = [Management.Automation.Language.Parser]::ParseFile(
    (Join-Path $PSScriptRoot 'accept-and-publish-test-server.ps1'),
    [ref]$journalTokens, [ref]$journalErrors)
$journalCalls = @($callerAst.FindAll({ param($node)
    $node -is [Management.Automation.Language.CommandAst] -and
        $node.GetCommandName() -eq 'Add-CoordinatedReleaseJournalEntry'
}, $true))
$manifest = $dailyManifest
$State = [pscustomobject]@{ coordinated_manifest = $manifest; coordinated_journal = @();
    coordinated_server_evidence_nonce = 'fixture-nonce' }
$platform = 'ios'; $target = $serverSha; $generation = 't1250'; $fingerprint = '1' * 64
Assert-True ($journalErrors.Count -eq 0 -and $journalCalls.Count -gt 0) 'canonical journal callers parse'
foreach ($call in $journalCalls) {
    $entries = @(Invoke-Expression $call.Extent.Text)
    Assert-True ($entries.Count -eq 1 -and $entries[0].phase -ceq $manifest.current_phase -and
        $entries[0].sequence -eq 1) 'canonical journal call binds and retains manifest phase'
}

# Run the canonical entry through its read-only preflight with an exact-SHA observation.
foreach ($name in @('Get-StateValue', 'Invoke-CoordinatedReleaseWorkflow')) {
    $definition = $callerAst.Find({ param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }, $false)
    Invoke-Expression $definition.Extent.Text
}
function Initialize-CoordinatedReleaseState($State) { }
function Import-CoordinatedMobileReceipt($State) { }
function Sync-CoordinatedReleaseServerPhases($State) { }
function Write-CoordinatedReleaseState($State) { }
function Assert-LiveProductionIntegrity($State) { }
function Assert-InstalledDeploymentIdentity($State) { }
function Reconcile-RemoteTruth($State) {
    Assert-True ($State.candidate_integration_sha -ceq $serverSha -and $State.new_generation -ceq 't1250') `
        'canonical preflight receives the exact pinned target before status reconciliation'
    return [pscustomobject]@{ deployed_sha = $serverSha; public_release_sha = $serverSha }
}
function Invoke-Phase($State, $Name, $Action) {
    if ($Name -ceq 'coordinated_installed_deployment_identity_preflight') { & $Action; return }
    if ($Name -ceq 'coordinated_prepare_pinned_server') { throw 'TEST_PREPARE_BOUNDARY' }
    throw 'Unexpected canonical preflight phase'
}
$entryState = [pscustomobject]@{ coordinated_manifest = (New-CoordinatedReleaseManifestFromSeed $dailySeed);
    coordinated_journal = @(); candidate_integration_sha = ''; new_generation = '' }
$reachedPrepare = $false
try { Invoke-CoordinatedReleaseWorkflow $entryState | Out-Null }
catch { if ($_.Exception.Message -cne 'TEST_PREPARE_BOUNDARY') { throw }; $reachedPrepare = $true }
Assert-True $reachedPrepare 'one unique exact deployed/public SHA passes preflight before deployment'

# The controller's real pre-submission response has no target or accepted receipt.
foreach ($name in @('Reconcile-RemoteTruth', 'Assert-ConsistentControllerPayload')) {
    $definition = $callerAst.Find({ param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }, $false)
    Invoke-Expression $definition.Extent.Text
}
$absentResponse = [pscustomobject]@{ schema_version = 1; operation_id = 'absent-fixture';
    result = 'absent'; current_phase = 'genuinely_unknown'; operation_state = 'genuinely_unknown';
    unit_state = 'inactive'; controller_state = 'consistent' }
function Stop-Workflow([string]$Message) { throw $Message }
function Get-GenerationStatus { return [pscustomobject]@{ integration_test_sha=$serverSha; generation='t1250'; snapshot_id='fixture' } }
function Get-GameRepositoryRoot { return $PSScriptRoot }
function Get-GitText($Path, $Arguments) { return "$serverSha refs/heads/master" }
function Get-ReceiptOutageStart($State) { return $null }
function Write-State($State) { }
function Invoke-DeploymentController($State, $Action, $Arguments) { return [pscustomobject]@{ payload=$absentResponse; exit_code=0 } }
function Invoke-RestMethod { return [pscustomobject]@{ game_sha=$serverSha } }
$Mode = 'Resume'; $SshKey = $PSCommandPath
$absentState = [pscustomobject]@{ operation_id='absent-fixture'; remote_deployment_receipt=$null;
    candidate_integration_sha=$serverSha; deployment_status_token=''; deployment_start_attempted=$false;
    remote_side_effect_intent=$null; activation_intent=$null; reconciled_remote_truth=$null }
$absenceTruth = Reconcile-RemoteTruth $absentState
Assert-True ($absenceTruth.public_release_sha -ceq $serverSha -and
    $absenceTruth.last_known_receipt_result -ceq 'absent' -and $null -eq $absentState.remote_deployment_receipt) `
    'pre-submission absence observes live identity without manufacturing an accepted receipt'
$absentState.remote_deployment_receipt = [pscustomobject]@{ result='accepted'; target_sha=$serverSha }
Assert-Throws { Reconcile-RemoteTruth $absentState } 'accepted remote deployment may not disappear'
$absentState.remote_deployment_receipt = $null
$absentState.deployment_start_attempted = $true
Assert-Throws { Reconcile-RemoteTruth $absentState } 'attempted deployment absence remains blocked'
$absentState.deployment_start_attempted = $false
$absentState.remote_side_effect_intent = [pscustomobject]@{ kind='vps_activation'; status='pending' }
Assert-Throws { Reconcile-RemoteTruth $absentState } 'unresolved mutation absence remains blocked'

Write-Host "coordinated release fixtures passed: $script:Passed"
