$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$controllerPath = Join-Path $PSScriptRoot 'coordinated-release-controller.ps1'
$controllerText = Get-Content -Raw -LiteralPath $controllerPath
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($controllerText, [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw "controller parse failed: $($errors -join '; ')" }

function Stop-CoordinatedController([string]$Message) { throw $Message }
function Assert-ControllerTest([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
}

foreach ($name in @(
        'ConvertTo-ControllerCanonicalJson', 'Get-ControllerSha256', 'Get-FullPath',
        'Get-RequiredProperty', 'Get-OptionalProperty', 'Read-BatchRequest', 'Read-BatchRequestFile',
        'New-BatchAdmissionManifest', 'Read-BatchAdmissionManifest')) {
    $definitions = @($ast.FindAll({
            param($node)
            $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
        }, $true))
    Assert-ControllerTest ($definitions.Count -eq 1) "controller defines $name once"
    Invoke-Expression $definitions[0].Extent.Text
}

$valid = '[{"branch":"feature/one","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","player_patch_note":"First player note."},{"branch":"fix/two","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","player_patch_note":"Second player note."}]'
$parsed = @(Read-BatchRequest $valid)
Assert-ControllerTest ($parsed.Count -eq 2 -and $parsed[0].branch -eq 'feature/one' -and
    $parsed[1].sha -eq ('b' * 40)) 'batch request preserves ordered branch and SHA identities'
Assert-ControllerTest ((ConvertTo-ControllerCanonicalJson @($parsed)) -eq
    '[{"branch":"feature/one","player_patch_note":"First player note.","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},{"branch":"fix/two","player_patch_note":"Second player note.","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}]') `
    'batch request canonical JSON sorts object keys while preserving array order'

foreach ($bad in @(
        '[{"branch":"feature/one","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","player_patch_note":"First player note."}]',
        '[{"branch":"feature/one","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","player_patch_note":"First player note."},{"branch":"feature/one","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","player_patch_note":"Second player note."}]',
        '[{"branch":"feature/one","sha":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","player_patch_note":"First player note."},{"branch":"fix/two","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","player_patch_note":"Second player note."}]'
    )) {
    $rejected = $false
    try { Read-BatchRequest $bad | Out-Null } catch { $rejected = $true }
    Assert-ControllerTest $rejected 'invalid batch request is rejected before source mutation'
}

Assert-ControllerTest ($controllerText -match 'Resolve-RegisteredBatchWorktrees' -and
    $controllerText -match 'batch-admission-operation-id' -or
    $controllerText -match 'batch_admission_operation_id') 'controller persists a child admission operation identity'
Assert-ControllerTest ($controllerText -match 'Write-ControlJson \$initialDispatchPath' -and
    ($controllerText -match 'Invoke-BatchAdmissionCoordinator ''Start''' -or
        $controllerText -match 'Invoke-BatchAdmissionCoordinator -BatchAction ''Start''')) `
    'controller persists the initial dispatch before invoking canonical batch admission'
Assert-ControllerTest ($controllerText -match 'batch_request' -and
    $controllerText -match 'BatchAdmissionManifestPath' -and
    $controllerText -match 'New-BatchAdmissionManifest' -and
    $controllerText -notmatch "arguments \+= '-FeatureWorktrees'" -and
    $controllerText -notmatch "arguments \+= '-FeatureBranches'" -and
    $controllerText -notmatch "arguments \+= '-FeatureTipShas'") `
    'controller forwards the durable ordered batch manifest as one scalar input to canonical admission'
Assert-ControllerTest ($controllerText -match 'SourceRepositoryRoot' -and
    $controllerText -match 'IntegrationWorktreePath' -and
    $controllerText -match 'integration_worktree_root') `
    'controller binds the pinned tooling process to the explicit game source and integration worktree'
Assert-ControllerTest ($controllerText -match 'BatchRequestPath' -and
    $controllerText -match 'Read-BatchRequestFile') `
    'controller accepts workflow JSON through a UTF-8 file to avoid nested PowerShell argument stripping'
Assert-ControllerTest ($controllerText -match '\$durableBatchRequestPath\s*=\s*Join-Path' -and
    $controllerText -notmatch '\$batchRequestPath\s*=\s*Join-Path') `
    'controller keeps the caller batch-request path distinct from its durable output path'
Assert-ControllerTest ($controllerText -match 'schema_version = 2' -and
    $controllerText -match 'dispatch_nonce = \$dispatchNonce' -and
    $controllerText -match 'dispatch_name = Get-DispatchName' -and
    $controllerText -match 'expected_delivery_mode = \$ExpectedDeliveryMode') `
    'controller writes the transport-compatible immutable tester-only dispatch record before Mac bootstrap'
Assert-ControllerTest ($controllerText -match 'Claim-CoordinatedStart' -and
    $controllerText -match 'Write-ExclusiveControlJson' -and
    $controllerText -match 'Get-PendingCoordinatedOperations') `
    'controller claims one pending coordinated operation per exact generation and source SHA'

$repositoryRoot = 'C:\trusted-game-source'
$integrationWorktree = 'C:\trusted-game-worktrees\integration-test'
$manifestFeatures = @(
    [pscustomobject]@{ branch = 'feature/one'; sha = ('a' * 40); player_patch_note = 'First player note.'; worktree = 'C:\feature-one' },
    [pscustomobject]@{ branch = 'fix/two'; sha = ('b' * 40); player_patch_note = 'Second player note.'; worktree = 'C:\feature-two' }
)
$manifest = New-BatchAdmissionManifest 'operation-admission' $manifestFeatures
Assert-ControllerTest ([string]$manifest.kind -ceq 'ash-atlas-batch-admission-manifest' -and
    [string]$manifest.source_repository_root -ceq $repositoryRoot -and
    @($manifest.features).Count -eq 2) `
    'batch admission manifest freezes the source checkout and ordered feature packet'
$manifestPath = Join-Path ([IO.Path]::GetTempPath()) ('ash-atlas-controller-manifest-' + [guid]::NewGuid().ToString('n') + '.json')
try {
    [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    $readManifest = Read-BatchAdmissionManifest $manifestPath 'operation-admission' $manifestFeatures
    Assert-ControllerTest ([string]$readManifest.request_sha256 -match '^[0-9a-f]{64}$') `
        'batch admission manifest round-trips with its ordered request hash'
} finally {
    Remove-Item -LiteralPath $manifestPath -Force -ErrorAction SilentlyContinue
}

# Exercise the actual script boundary with disposable source, tooling, and server
# fixtures.  The two-entry Start path is the regression guard for PowerShell's
# case-insensitive parameter/local variable binding; Resume proves the original
# durable operation ID is accepted without a new request packet.
$boundaryRoot = Join-Path ([IO.Path]::GetTempPath()) ('ash-atlas-controller-boundary-' + [guid]::NewGuid().ToString('n'))
$sourceRoot = Join-Path $boundaryRoot 'source'
$originRoot = Join-Path $boundaryRoot 'origin.git'
$integrationRoot = Join-Path $boundaryRoot 'integration'
$featureOneRoot = Join-Path $boundaryRoot 'feature-one'
$featureTwoRoot = Join-Path $boundaryRoot 'feature-two'
$toolingRoot = Join-Path $boundaryRoot 'tooling'
$stateRoot = Join-Path $boundaryRoot 'state'
$serverRoot = Join-Path $boundaryRoot 'server'
$serverProcess = $null
$interleavingProcess = $null
$previousBoundaryPending = $env:ASH_ATLAS_CONTROLLER_BOUNDARY_PENDING
$previousBoundaryAdmissionPre = $env:ASH_ATLAS_CONTROLLER_BOUNDARY_ADMISSION_PRE
$previousBoundaryAdmissionPost = $env:ASH_ATLAS_CONTROLLER_BOUNDARY_ADMISSION_POST

function Invoke-BoundaryGit {
    param(
        [Parameter(Mandatory = $true)][string]$Repository,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $result = @(& git -C $Repository @Arguments 2>&1)
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($LASTEXITCODE -ne 0) {
        throw "fixture git $($Arguments -join ' ') failed in ${Repository}: $($result -join ' ')"
    }
    return (($result -join "`n").Trim())
}

function Invoke-ControllerBoundary {
    param(
        [Parameter(Mandatory = $true)][string]$PinnedController,
        [Parameter(Mandatory = $true)][string]$ControlConfig,
        [Parameter(Mandatory = $true)][ValidateSet('Start', 'Resume')][string]$Action,
        [bool]$DryRun = $true,
        [string[]]$ExtraArguments = @()
    )
    $arguments = @('-Action', $Action, '-ConfigPath', $ControlConfig)
    if ($DryRun) { $arguments += '-DryRun' }
    $arguments += @($ExtraArguments)
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = @(& powershell -NoProfile -ExecutionPolicy Bypass -File $PinnedController @arguments 2>&1)
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    return [pscustomobject]@{
        exit_code = $exitCode
        output = ($output -join "`n")
    }
}

try {
    New-Item -ItemType Directory -Path $boundaryRoot -Force | Out-Null
    New-Item -ItemType Directory -Path $sourceRoot, $toolingRoot, $stateRoot, $serverRoot -Force | Out-Null

    Invoke-BoundaryGit $sourceRoot @('init', '-b', 'master') | Out-Null
    Invoke-BoundaryGit $sourceRoot @('config', 'user.name', 'controller-boundary-fixture') | Out-Null
    Invoke-BoundaryGit $sourceRoot @('config', 'user.email', 'controller-boundary-fixture@example.invalid') | Out-Null
    Invoke-BoundaryGit $sourceRoot @('config', 'core.autocrlf', 'false') | Out-Null
    [IO.File]::WriteAllText((Join-Path $sourceRoot 'README.md'), "fixture`n", [Text.UTF8Encoding]::new($false))
    Invoke-BoundaryGit $sourceRoot @('add', 'README.md') | Out-Null
    Invoke-BoundaryGit $sourceRoot @('commit', '-m', 'fixture baseline') | Out-Null
    $masterSha = Invoke-BoundaryGit $sourceRoot @('rev-parse', 'HEAD')
    Invoke-BoundaryGit $sourceRoot @('branch', 'integration/test') | Out-Null
    Invoke-BoundaryGit $sourceRoot @('branch', 'feature/one') | Out-Null
    Invoke-BoundaryGit $sourceRoot @('branch', 'fix/two') | Out-Null
    Invoke-BoundaryGit $sourceRoot @('worktree', 'add', $integrationRoot, 'integration/test') | Out-Null
    Invoke-BoundaryGit $sourceRoot @('worktree', 'add', $featureOneRoot, 'feature/one') | Out-Null
    [IO.File]::WriteAllText((Join-Path $featureOneRoot 'feature-one.txt'), "one`n", [Text.UTF8Encoding]::new($false))
    Invoke-BoundaryGit $featureOneRoot @('config', 'user.name', 'controller-boundary-fixture') | Out-Null
    Invoke-BoundaryGit $featureOneRoot @('config', 'user.email', 'controller-boundary-fixture@example.invalid') | Out-Null
    Invoke-BoundaryGit $featureOneRoot @('add', 'feature-one.txt') | Out-Null
    Invoke-BoundaryGit $featureOneRoot @('commit', '-m', 'fixture feature one') | Out-Null
    $featureOneSha = Invoke-BoundaryGit $featureOneRoot @('rev-parse', 'HEAD')
    Invoke-BoundaryGit $sourceRoot @('worktree', 'add', $featureTwoRoot, 'fix/two') | Out-Null
    [IO.File]::WriteAllText((Join-Path $featureTwoRoot 'feature-two.txt'), "two`n", [Text.UTF8Encoding]::new($false))
    Invoke-BoundaryGit $featureTwoRoot @('config', 'user.name', 'controller-boundary-fixture') | Out-Null
    Invoke-BoundaryGit $featureTwoRoot @('config', 'user.email', 'controller-boundary-fixture@example.invalid') | Out-Null
    Invoke-BoundaryGit $featureTwoRoot @('add', 'feature-two.txt') | Out-Null
    Invoke-BoundaryGit $featureTwoRoot @('commit', '-m', 'fixture feature two') | Out-Null
    $featureTwoSha = Invoke-BoundaryGit $featureTwoRoot @('rev-parse', 'HEAD')
    New-Item -ItemType Directory -Path $originRoot -Force | Out-Null
    Invoke-BoundaryGit $originRoot @('init', '--bare') | Out-Null
    Invoke-BoundaryGit $sourceRoot @('remote', 'add', 'origin', $originRoot) | Out-Null
    Invoke-BoundaryGit $sourceRoot @('push', '--quiet', 'origin', 'master', 'integration/test', 'feature/one', 'fix/two') | Out-Null
    $integrationSha = Invoke-BoundaryGit $integrationRoot @('rev-parse', 'HEAD')

    New-Item -ItemType Directory -Path (Join-Path $toolingRoot 'tools\release'),
        (Join-Path $toolingRoot 'tools\dev') -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'coordinated-release-controller.ps1') `
        -Destination (Join-Path $toolingRoot 'tools\release\coordinated-release-controller.ps1')
    $fakeCanonical = @'
param(
    [string]$Mode, [string]$OperationId, [string]$StateRoot,
    [string]$CoordinatedManifestPath, [string]$CoordinatedMobileReceiptPath,
    [string]$CoordinatedServerEvidencePath, [string]$CoordinatedSeedPath,
    [string]$SourceRepositoryRoot, [string]$IntegrationWorktreePath,
    [string]$MobileRegistryRemote, [switch]$Json, [switch]$ConfirmCoordinatedRelease
)
$statePath = Join-Path $StateRoot "$OperationId.json"
New-Item -ItemType Directory -Path $StateRoot -Force | Out-Null
$state = [ordered]@{
    operation_id = $OperationId
    coordinated_manifest = [ordered]@{
        current_phase = if ($env:ASH_ATLAS_CONTROLLER_BOUNDARY_PENDING -eq '1') { 'server_healthy' } else { 'completed' }
        server = [ordered]@{ healthy = $false }
    }
}
if ($Mode -eq 'IntegrateBatchAdmission') {
    $state.requested_mode = 'IntegrateBatchAdmission'
    $state.batch_admission_accepted = $true
    $state.accepted_integration_sha = '__FIXTURE_ACCEPTED_INTEGRATION_SHA__'
    $state.accepted_generation = 't1251'
    $state.original_integration_sha = '__FIXTURE_ORIGINAL_INTEGRATION_SHA__'
    $state.original_integration_generation = 't1250'
    $state.original_master_sha = '__FIXTURE_MASTER_SHA__'
}
if ($Mode -eq 'IntegrateBatchAdmission' -and $env:ASH_ATLAS_CONTROLLER_BOUNDARY_ADMISSION_PRE -eq '1') {
    [IO.File]::WriteAllText((Join-Path $StateRoot 'fixture-admission-remote-published.marker'),
        'published', [Text.UTF8Encoding]::new($false))
    while (-not (Test-Path -LiteralPath (Join-Path $StateRoot 'fixture-admission-pre-release.marker') -PathType Leaf)) {
        Start-Sleep -Milliseconds 25
    }
}
if ($env:ASH_ATLAS_CONTROLLER_BOUNDARY_PENDING -eq '1') { Start-Sleep -Milliseconds 1200 }
[IO.File]::WriteAllText($statePath, ($state | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
if ($Mode -eq 'IntegrateBatchAdmission' -and $env:ASH_ATLAS_CONTROLLER_BOUNDARY_ADMISSION_POST -eq '1') {
    [IO.File]::WriteAllText((Join-Path $StateRoot 'fixture-admission-accepted.marker'),
        'accepted', [Text.UTF8Encoding]::new($false))
    while (-not (Test-Path -LiteralPath (Join-Path $StateRoot 'fixture-admission-post-release.marker') -PathType Leaf)) {
        Start-Sleep -Milliseconds 25
    }
}
'{"status":"completed"}'
'@
    $fakeCanonical = $fakeCanonical.Replace('__FIXTURE_ACCEPTED_INTEGRATION_SHA__', ('e' * 40)).
        Replace('__FIXTURE_ORIGINAL_INTEGRATION_SHA__', $integrationSha).
        Replace('__FIXTURE_MASTER_SHA__', $masterSha)
    [IO.File]::WriteAllText((Join-Path $toolingRoot 'tools\release\accept-and-publish-test-server.ps1'),
        $fakeCanonical, [Text.UTF8Encoding]::new($false))
    $fakeTransport = @'
param(
    [string]$Action, [string]$OperationId, [string]$Generation,
    [string]$ServerSha, [string]$AcceptedMasterSha, [string]$CurrentServerSha,
    [string]$OutputSeedPath, [string]$OutputReceiptPath, [string]$DispatchRecordPath,
    [string]$ControlRepository, [string]$ControlWorkflow, [string]$ControlRef,
    [string]$ControlSha, [string]$ToolingSha, [string]$SourceRepository
)
$dispatch = Get-Content -Raw -LiteralPath $DispatchRecordPath -Encoding utf8 | ConvertFrom-Json
if ([int]$dispatch.schema_version -ne 2 -or
    [string]$dispatch.dispatch_nonce -notmatch '^[0-9a-f]{32}$' -or
    [string]$dispatch.dispatch_name -cne "ash-atlas-mobile-$OperationId-$($dispatch.dispatch_nonce)") {
    throw 'controller handoff did not provide the transport schema-2 dispatch record'
}
$seed = [ordered]@{
    schema_version = 1
    kind = 'ash-atlas-coordinated-release-seed'
    operation_id = $OperationId
    delivery_mode = 'daily-testers'
    apps = [ordered]@{
        ios = [ordered]@{ candidate = [ordered]@{
                tester_destination = [ordered]@{ kind = 'testflight'; group_type = 'internal'; group_id = 'qa-internal' }
            } }
        android = [ordered]@{ candidate = [ordered]@{
                tester_destination = [ordered]@{ kind = 'google-play-internal'; track = 'qa' }
            } }
    }
}
$receipt = [ordered]@{
    schemaVersion = 1
    kind = 'ash-atlas-coordinated-mobile-result'
    coordinated_operation_id = $OperationId
}
[IO.File]::WriteAllText($OutputSeedPath, ($seed | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText($OutputReceiptPath, ($receipt | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
'@
    [IO.File]::WriteAllText((Join-Path $toolingRoot 'tools\release\coordinated-mobile-bootstrap-transport.example.ps1'),
        $fakeTransport, [Text.UTF8Encoding]::new($false))
    $generationScript = @"
param([string]`$Command, [string]`$RepositoryPath, [switch]`$Json)
`$accepted = `$env:ASH_ATLAS_CONTROLLER_BOUNDARY_GENERATION -eq 't1251'
`$generation = if (`$accepted) { 't1251' } else { 't1250' }
`$integration = if (`$accepted) { ('e' * 40) } else { '$integrationSha' }
`$next = if (`$accepted) { 't1252' } else { 't1251' }
([ordered]@{ generation = `$generation; integration_test_sha = `$integration; master_sha = '$masterSha'; next_generation = `$next } | ConvertTo-Json -Compress)
"@
    [IO.File]::WriteAllText((Join-Path $toolingRoot 'tools\dev\test-generation.ps1'),
        $generationScript, [Text.UTF8Encoding]::new($false))
    Invoke-BoundaryGit $toolingRoot @('init', '-b', 'main') | Out-Null
    Invoke-BoundaryGit $toolingRoot @('config', 'user.name', 'controller-boundary-fixture') | Out-Null
    Invoke-BoundaryGit $toolingRoot @('config', 'user.email', 'controller-boundary-fixture@example.invalid') | Out-Null
    Invoke-BoundaryGit $toolingRoot @('config', 'core.autocrlf', 'false') | Out-Null
    Invoke-BoundaryGit $toolingRoot @('add', '.') | Out-Null
    Invoke-BoundaryGit $toolingRoot @('commit', '-m', 'fixture trusted tooling') | Out-Null
    $toolingSha = Invoke-BoundaryGit $toolingRoot @('rev-parse', 'HEAD')

    [IO.File]::WriteAllText((Join-Path $serverRoot 'release.json'),
        ('{"game_sha":"' + $masterSha + '"}'), [Text.UTF8Encoding]::new($false))
    $portProbe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $portProbe.Start()
    $port = ([Net.IPEndPoint]$portProbe.LocalEndpoint).Port
    $portProbe.Stop()
    $python = (Get-Command python.exe -ErrorAction Stop).Source
    $serverProcess = Start-Process -FilePath $python -ArgumentList @(
        '-m', 'http.server', [string]$port, '--bind', '127.0.0.1', '--directory', $serverRoot
    ) -WindowStyle Hidden -PassThru
    $statusUri = "http://127.0.0.1:$port/release.json"
    $serverReady = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        try {
            $probe = Invoke-RestMethod -Uri $statusUri -TimeoutSec 2
            if ([string]$probe.game_sha -ceq $masterSha) { $serverReady = $true; break }
        } catch { Start-Sleep -Milliseconds 100 }
    }
    Assert-ControllerTest $serverReady 'boundary status fixture is reachable'

    $config = [ordered]@{
        schema_version = 1
        kind = 'ash-atlas-coordinated-release-control-config'
        status = 'ready'
        trusted_controller = [ordered]@{
            runner_account = [Environment]::UserName
            source_checkout_root = $sourceRoot
            integration_worktree_root = $integrationRoot
            tooling_checkout_root = $toolingRoot
            controller_script = Join-Path $toolingRoot 'tools\release\coordinated-release-controller.ps1'
            state_root = $stateRoot
        }
        source_policy = [ordered]@{ allowed_tooling_sha = $toolingSha }
        batch_admission = [ordered]@{ validator_adapter_path = Join-Path $boundaryRoot 'validator.ps1' }
        server = [ordered]@{
            canonical_script = Join-Path $toolingRoot 'tools\release\accept-and-publish-test-server.ps1'
            public_status_uri = $statusUri
        }
        mobile = [ordered]@{
            bootstrap_script = Join-Path $toolingRoot 'tools\release\coordinated-mobile-bootstrap-transport.example.ps1'
            control_repository = 'fixture/control'
            workflow = 'fixture.yml'
            workflow_ref = 'refs/tags/fixture'
            workflow_sha = ('c' * 40)
            tooling_sha = ('d' * 40)
            source_repository = 'fixture/game'
        }
        bootstrap_contract = [ordered]@{ operation_id = 'fixture' }
    }
    $configPath = Join-Path $boundaryRoot 'control.json'
    [IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
    $pinnedController = Join-Path $toolingRoot 'tools\release\coordinated-release-controller.ps1'

    $startNoBatch = Invoke-ControllerBoundary $pinnedController $configPath 'Start'
    Assert-ControllerTest ($startNoBatch.exit_code -eq 0 -and
        $startNoBatch.output -match '"action":"Start"' -and
        $startNoBatch.output -match [Regex]::Escape($integrationSha)) `
        'script-boundary Start without batch request resolves the pinned generation'

    $expectedCandidateStart = Invoke-ControllerBoundary $pinnedController $configPath 'Start' `
        -ExtraArguments @('-ExpectedGeneration', 't1250', '-ExpectedCandidateSha', $integrationSha,
            '-ExpectedDeliveryMode', 'daily-testers')
    Assert-ControllerTest ($expectedCandidateStart.exit_code -eq 0 -and
        $expectedCandidateStart.output -match [Regex]::Escape($integrationSha)) `
        'script-boundary Start accepts the exact generation and candidate binding'
    $mismatchedCandidateStart = Invoke-ControllerBoundary $pinnedController $configPath 'Start' `
        -ExtraArguments @('-ExpectedGeneration', 't1250', '-ExpectedCandidateSha', ('f' * 40))
    Assert-ControllerTest ($mismatchedCandidateStart.exit_code -ne 0 -and
        $mismatchedCandidateStart.output -match 'expected candidate') `
        'script-boundary Start refuses a candidate that changed after the Mac request'

    $batchPath = Join-Path $boundaryRoot 'batch-request.json'
    $batchJson = '[{"branch":"feature/one","sha":"' + $featureOneSha + '","player_patch_note":"First fixture patch note."},{"branch":"fix/two","sha":"' + $featureTwoSha + '","player_patch_note":"Second fixture patch note."}]'
    [IO.File]::WriteAllText($batchPath, $batchJson, [Text.UTF8Encoding]::new($false))
    $startTwoEntries = Invoke-ControllerBoundary $pinnedController $configPath 'Start' -ExtraArguments @('-BatchRequestPath', $batchPath)
    Assert-ControllerTest ($startTwoEntries.exit_code -eq 0 -and
        $startTwoEntries.output -match '"action":"Start"' -and
        $startTwoEntries.output -match 'batch_admission_manifest_path') `
        'script-boundary Start reads and preserves an ordered two-entry batch file'

    # Hold the child after its simulated remote t1251 publication but before
    # it writes accepted state.  The reservation in the parent claim must fence
    # a second Start even though the accepted child state is not present yet.
    $env:ASH_ATLAS_CONTROLLER_BOUNDARY_PENDING = '0'
    $env:ASH_ATLAS_CONTROLLER_BOUNDARY_ADMISSION_PRE = '1'
    Remove-Item Env:ASH_ATLAS_CONTROLLER_BOUNDARY_ADMISSION_POST -ErrorAction SilentlyContinue
    $env:ASH_ATLAS_CONTROLLER_BOUNDARY_GENERATION = 't1250'
    $preInterleavingOut = Join-Path $boundaryRoot 'admission-pre-interleaving.out.txt'
    $preInterleavingErr = Join-Path $boundaryRoot 'admission-pre-interleaving.err.txt'
    $interleavingArguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $pinnedController,
        '-Action', 'Start', '-ConfigPath', $configPath, '-BatchRequestPath', $batchPath)
    $interleavingProcess = Start-Process -FilePath 'powershell.exe' -ArgumentList $interleavingArguments `
        -RedirectStandardOutput $preInterleavingOut -RedirectStandardError $preInterleavingErr -WindowStyle Hidden -PassThru
    $prePublished = $false
    for ($attempt = 0; $attempt -lt 120 -and -not $prePublished; $attempt++) {
        $prePublished = Test-Path -LiteralPath (Join-Path $stateRoot 'fixture-admission-remote-published.marker') -PathType Leaf
        if (-not $prePublished) { Start-Sleep -Milliseconds 25 }
    }
    Assert-ControllerTest $prePublished `
        'batch admission publishes its simulated remote candidate before accepted state'
    $env:ASH_ATLAS_CONTROLLER_BOUNDARY_GENERATION = 't1251'
    $preInterleavedDuplicate = Invoke-ControllerBoundary $pinnedController $configPath 'Start' $false
    Assert-ControllerTest ($preInterleavedDuplicate.exit_code -ne 0 -and
        $preInterleavedDuplicate.output -match 'already owns generation t1251') `
        'Start is fenced after remote publication and before accepted child state'
    [IO.File]::WriteAllText((Join-Path $stateRoot 'fixture-admission-pre-release.marker'),
        'release', [Text.UTF8Encoding]::new($false))
    Assert-ControllerTest ($interleavingProcess.WaitForExit(30000)) `
        'pre-acceptance interleaved batch parent completes after the duplicate source check'
    $preInterleavingOutput = @(
        (Get-Content -Raw -LiteralPath $preInterleavingOut -ErrorAction SilentlyContinue),
        (Get-Content -Raw -LiteralPath $preInterleavingErr -ErrorAction SilentlyContinue)
    ) -join "`n"
    Assert-ControllerTest ($preInterleavingOutput -match '"status":"completed"' -and
        @((Get-ChildItem -LiteralPath $stateRoot -Filter '*.coordinated-mobile-dispatch.json' -File)).Count -eq 1) `
        'pre-acceptance interleaving leaves one durable parent dispatch'
    $interleavingProcess = $null
    Get-ChildItem -LiteralPath $stateRoot -File | Remove-Item -Force

    # Hold the parent after the admission child writes its accepted t1251
    # state.  A second Start at that exact accepted source must see the child
    # identity projected through the parent dispatch and be fenced before the
    # parent migrates its claim.
    Remove-Item Env:ASH_ATLAS_CONTROLLER_BOUNDARY_ADMISSION_PRE -ErrorAction SilentlyContinue
    $env:ASH_ATLAS_CONTROLLER_BOUNDARY_ADMISSION_POST = '1'
    $env:ASH_ATLAS_CONTROLLER_BOUNDARY_GENERATION = 't1250'
    $interleavingOut = Join-Path $boundaryRoot 'admission-post-interleaving.out.txt'
    $interleavingErr = Join-Path $boundaryRoot 'admission-post-interleaving.err.txt'
    $interleavingProcess = Start-Process -FilePath 'powershell.exe' -ArgumentList $interleavingArguments `
        -RedirectStandardOutput $interleavingOut -RedirectStandardError $interleavingErr -WindowStyle Hidden -PassThru
    $acceptedAdmissionState = $null
    for ($attempt = 0; $attempt -lt 120 -and $null -eq $acceptedAdmissionState; $attempt++) {
        $acceptedMarker = Test-Path -LiteralPath (Join-Path $stateRoot 'fixture-admission-accepted.marker') -PathType Leaf
        foreach ($admissionFile in @(Get-ChildItem -LiteralPath $stateRoot -Filter '*-admission.json' -File -ErrorAction SilentlyContinue)) {
            try { $candidateAdmissionState = Get-Content -Raw -LiteralPath $admissionFile.FullName -Encoding utf8 | ConvertFrom-Json }
            catch { continue }
            if ($acceptedMarker -and
                [string](Get-OptionalProperty $candidateAdmissionState 'requested_mode' '') -ceq 'IntegrateBatchAdmission' -and
                [bool](Get-OptionalProperty $candidateAdmissionState 'batch_admission_accepted' $false)) {
                $acceptedAdmissionState = $candidateAdmissionState
                break
            }
        }
        if ($null -eq $acceptedAdmissionState) { Start-Sleep -Milliseconds 25 }
    }
    Assert-ControllerTest ($null -ne $acceptedAdmissionState -and
        [string](Get-OptionalProperty $acceptedAdmissionState 'accepted_generation' '') -ceq 't1251') `
        'batch admission child durably records the accepted generation before parent claim migration'
    $acceptedParentDispatchPath = @(Get-ChildItem -LiteralPath $stateRoot `
        -Filter '*.coordinated-mobile-dispatch.json' -File)[0].FullName
    $acceptedParentDispatch = Get-Content -Raw -LiteralPath $acceptedParentDispatchPath -Encoding utf8 | ConvertFrom-Json
    $acceptedParentOperation = [string]$acceptedParentDispatch.operation_id
    $env:ASH_ATLAS_CONTROLLER_BOUNDARY_GENERATION = 't1251'
    $interleavedDuplicate = Invoke-ControllerBoundary $pinnedController $configPath 'Start' $false
    Assert-ControllerTest ($interleavedDuplicate.exit_code -ne 0 -and
        $interleavedDuplicate.output -match 'already owns generation t1251') `
        'Start fences an accepted batch child during the parent claim migration window'

    # An accepted child is only reusable when it retains the exact protected
    # source identity reserved by the parent.  Exercise both an empty field
    # and a missing field through the real Resume boundary.
    $acceptedAdmissionPath = Join-Path $stateRoot "$($acceptedAdmissionState.operation_id).json"
    $acceptedAdmissionOriginalSource = [string]$acceptedAdmissionState.original_integration_sha
    $acceptedAdmissionState.original_integration_sha = ''
    [IO.File]::WriteAllText($acceptedAdmissionPath,
        ($acceptedAdmissionState | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
    $emptySourceResume = Invoke-ControllerBoundary $pinnedController $configPath 'Resume' $false `
        -ExtraArguments @('-OperationId', $acceptedParentOperation)
    Assert-ControllerTest ($emptySourceResume.exit_code -ne 0 -and
        $emptySourceResume.output -match 'original source identity changed') `
        'Resume rejects an accepted child whose original source identity is empty'
    $acceptedAdmissionState.original_integration_sha = $null
    $acceptedAdmissionState.PSObject.Properties.Remove('original_integration_sha')
    [IO.File]::WriteAllText($acceptedAdmissionPath,
        ($acceptedAdmissionState | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
    $missingSourceResume = Invoke-ControllerBoundary $pinnedController $configPath 'Resume' $false `
        -ExtraArguments @('-OperationId', $acceptedParentOperation)
    Assert-ControllerTest ($missingSourceResume.exit_code -ne 0 -and
        $missingSourceResume.output -match 'original source identity changed') `
        'Resume rejects an accepted child missing its original source identity'
    $acceptedAdmissionState | Add-Member -NotePropertyName original_integration_sha `
        -NotePropertyValue $acceptedAdmissionOriginalSource -Force
    [IO.File]::WriteAllText($acceptedAdmissionPath,
        ($acceptedAdmissionState | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $stateRoot 'fixture-admission-post-release.marker'),
        'release', [Text.UTF8Encoding]::new($false))
    Assert-ControllerTest ($interleavingProcess.WaitForExit(30000)) `
        'interleaved batch parent completes after the duplicate source check'
    $interleavingProcess.Refresh()
    $interleavingOutput = @(
        (Get-Content -Raw -LiteralPath $interleavingOut -ErrorAction SilentlyContinue),
        (Get-Content -Raw -LiteralPath $interleavingErr -ErrorAction SilentlyContinue)
    ) -join "`n"
    Assert-ControllerTest ($interleavingOutput -match '"status":"completed"' -and
        @((Get-ChildItem -LiteralPath $stateRoot -Filter '*.coordinated-mobile-dispatch.json' -File)).Count -eq 1) `
        'interleaved batch leaves one durable parent dispatch'
    $interleavingProcess = $null
    Get-ChildItem -LiteralPath $stateRoot -File | Remove-Item -Force
    Remove-Item Env:ASH_ATLAS_CONTROLLER_BOUNDARY_ADMISSION_POST -ErrorAction SilentlyContinue

    $env:ASH_ATLAS_CONTROLLER_BOUNDARY_PENDING = '1'
    $env:ASH_ATLAS_CONTROLLER_BOUNDARY_GENERATION = 't1250'
    $batchLive = Invoke-ControllerBoundary $pinnedController $configPath 'Start' $false `
        -ExtraArguments @('-BatchRequestPath', $batchPath)
    $batchDispatchFiles = @(Get-ChildItem -LiteralPath $stateRoot -Filter '*.coordinated-mobile-dispatch.json' -File)
    $batchDispatch = if ($batchDispatchFiles.Count -eq 1) {
        Get-Content -Raw -LiteralPath $batchDispatchFiles[0].FullName -Encoding utf8 | ConvertFrom-Json
    } else { $null }
    Assert-ControllerTest ($batchLive.exit_code -eq 0 -and $null -ne $batchDispatch -and
        [string]$batchDispatch.batch_admission_status -ceq 'accepted' -and
        [string]$batchDispatch.generation -ceq 't1251' -and
        [string]$batchDispatch.source_sha -eq ('e' * 40)) `
        'batch admission advances the durable dispatch to the accepted generation'
    $env:ASH_ATLAS_CONTROLLER_BOUNDARY_GENERATION = 't1251'
    $batchDuplicate = Invoke-ControllerBoundary $pinnedController $configPath 'Start' $false
    Assert-ControllerTest ($batchDuplicate.exit_code -ne 0 -and
        $batchDuplicate.output -match 'already owns generation t1251' -and
        @((Get-ChildItem -LiteralPath $stateRoot -Filter '*.coordinated-mobile-dispatch.json' -File)).Count -eq 1) `
        'a new Start at the accepted batch generation is fenced by the migrated claim'
    Get-ChildItem -LiteralPath $stateRoot -File | Remove-Item -Force
    Remove-Item Env:ASH_ATLAS_CONTROLLER_BOUNDARY_GENERATION -ErrorAction SilentlyContinue

    $env:ASH_ATLAS_CONTROLLER_BOUNDARY_PENDING = '1'
    $liveStart = Invoke-ControllerBoundary $pinnedController $configPath 'Start' $false `
        -ExtraArguments @('-ExpectedGeneration', 't1250', '-ExpectedCandidateSha', $integrationSha,
            '-ExpectedDeliveryMode', 'daily-testers')
    $liveDispatchFiles = @(Get-ChildItem -LiteralPath $stateRoot -Filter '*.coordinated-mobile-dispatch.json' -File)
    $liveDispatch = if ($liveDispatchFiles.Count -eq 1) {
        Get-Content -Raw -LiteralPath $liveDispatchFiles[0].FullName -Encoding utf8 | ConvertFrom-Json
    } else { $null }
    $liveSeedPath = if ($null -ne $liveDispatchFiles -and $liveDispatchFiles.Count -eq 1) {
        Join-Path $stateRoot ($liveDispatchFiles[0].Name -replace '\.coordinated-mobile-dispatch\.json$', '.coordinated-seed.json')
    } else { '' }
    $liveReceiptPath = if ($null -ne $liveDispatchFiles -and $liveDispatchFiles.Count -eq 1) {
        Join-Path $stateRoot ($liveDispatchFiles[0].Name -replace '\.coordinated-mobile-dispatch\.json$', '.coordinated-mobile-receipt.json')
    } else { '' }
    Assert-ControllerTest ($liveStart.exit_code -eq 0 -and $null -ne $liveDispatch -and
        [int]$liveDispatch.schema_version -eq 2 -and
        [string]$liveDispatch.dispatch_nonce -match '^[0-9a-f]{32}$' -and
        [string]$liveDispatch.dispatch_name -eq
            "ash-atlas-mobile-$($liveDispatch.operation_id)-$($liveDispatch.dispatch_nonce)" -and
        [string]$liveDispatch.expected_delivery_mode -ceq 'daily-testers' -and
        [string]$liveDispatch.delivery_mode -ceq 'daily-testers' -and
        [string]$liveDispatch.delivery_policy_sha256 -match '^[0-9a-f]{64}$' -and
        [string]$liveDispatch.tester_destinations.android.track -ceq 'qa' -and
        [string]$liveDispatch.tester_destinations.ios.group_id -ceq 'qa-internal' -and
        (Test-Path -LiteralPath $liveSeedPath -PathType Leaf) -and
        (Test-Path -LiteralPath $liveReceiptPath -PathType Leaf)) `
        'non-DryRun controller handoff gives the transport an immutable schema-2 dispatch record'

    $duplicateStart = Invoke-ControllerBoundary $pinnedController $configPath 'Start' $false
    Assert-ControllerTest ($duplicateStart.exit_code -ne 0 -and
        $duplicateStart.output -match 'already owns generation' -and
        $duplicateStart.output -match 'Resume' -and
        @((Get-ChildItem -LiteralPath $stateRoot -Filter '*.coordinated-mobile-dispatch.json' -File)).Count -eq 1) `
        'script-boundary duplicate Start rejects the pending exact source and points to Resume'

    $completedState = [ordered]@{
        operation_id = [string]$liveDispatch.operation_id
        coordinated_status = 'completed'
        coordinated_manifest = [ordered]@{ current_phase = 'completed' }
    }
    [IO.File]::WriteAllText((Join-Path $stateRoot "$($liveDispatch.operation_id).json"),
        ($completedState | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    $env:ASH_ATLAS_CONTROLLER_BOUNDARY_PENDING = '0'
    $releasedStart = Invoke-ControllerBoundary $pinnedController $configPath 'Start' $false
    Assert-ControllerTest ($releasedStart.exit_code -eq 0 -and
        @((Get-ChildItem -LiteralPath $stateRoot -Filter '*.coordinated-mobile-dispatch.json' -File)).Count -eq 2) `
        'script-boundary Start can claim the exact source again after the prior operation is terminal'

    $env:ASH_ATLAS_CONTROLLER_BOUNDARY_PENDING = '1'
    $controllerArguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $pinnedController,
        '-Action', 'Start', '-ConfigPath', $configPath)
    $terminalConcurrentOutOne = Join-Path $boundaryRoot 'terminal-concurrent-one.out.txt'
    $terminalConcurrentErrOne = Join-Path $boundaryRoot 'terminal-concurrent-one.err.txt'
    $terminalConcurrentOutTwo = Join-Path $boundaryRoot 'terminal-concurrent-two.out.txt'
    $terminalConcurrentErrTwo = Join-Path $boundaryRoot 'terminal-concurrent-two.err.txt'
    $terminalConcurrentOne = Start-Process -FilePath 'powershell.exe' -ArgumentList $controllerArguments `
        -RedirectStandardOutput $terminalConcurrentOutOne -RedirectStandardError $terminalConcurrentErrOne -WindowStyle Hidden -PassThru
    Start-Sleep -Milliseconds 100
    $terminalConcurrentTwo = Start-Process -FilePath 'powershell.exe' -ArgumentList $controllerArguments `
        -RedirectStandardOutput $terminalConcurrentOutTwo -RedirectStandardError $terminalConcurrentErrTwo -WindowStyle Hidden -PassThru
    Assert-ControllerTest ($terminalConcurrentOne.WaitForExit(30000) -and $terminalConcurrentTwo.WaitForExit(30000)) `
        'terminal-claim concurrent Start fixtures finish within the bounded test window'
    $terminalConcurrentOutputs = @(
        (Get-Content -Raw -LiteralPath $terminalConcurrentOutOne -ErrorAction SilentlyContinue),
        (Get-Content -Raw -LiteralPath $terminalConcurrentErrOne -ErrorAction SilentlyContinue),
        (Get-Content -Raw -LiteralPath $terminalConcurrentOutTwo -ErrorAction SilentlyContinue),
        (Get-Content -Raw -LiteralPath $terminalConcurrentErrTwo -ErrorAction SilentlyContinue)
    )
    $terminalConcurrentOutput = $terminalConcurrentOutputs -join "`n"
    $terminalConcurrentSuccesses = @($terminalConcurrentOutputs | Where-Object { $_ -match '"status":"completed"' }).Count
    Assert-ControllerTest ($terminalConcurrentSuccesses -eq 1 -and
        $terminalConcurrentOutput -match 'ACTION_REQUIRED: coordinated operation' -and
        @((Get-ChildItem -LiteralPath $stateRoot -Filter '*.coordinated-mobile-dispatch.json' -File)).Count -eq 3) `
        'terminal claim replacement is compare-and-swap fenced under concurrent Start'

    Get-ChildItem -LiteralPath $stateRoot -File | Remove-Item -Force
    $unrelatedClaimHash = Get-ControllerSha256 (ConvertTo-ControllerCanonicalJson ([ordered]@{
            generation = 't1299'; source_sha = ('f' * 40)
        }))
    [IO.File]::WriteAllText((Join-Path $stateRoot "coordinated-source-$unrelatedClaimHash.claim.json"),
        '{"schema_version":1', [Text.UTF8Encoding]::new($false))
    $unrelatedMalformedStart = Invoke-ControllerBoundary $pinnedController $configPath 'Start' $false
    Assert-ControllerTest ($unrelatedMalformedStart.exit_code -eq 0 -and
        @((Get-ChildItem -LiteralPath $stateRoot -Filter '*.coordinated-mobile-dispatch.json' -File)).Count -eq 1) `
        'malformed claim for another source does not block an unrelated coordinated Start'
    Get-ChildItem -LiteralPath $stateRoot -File | Remove-Item -Force
    $currentClaimHash = Get-ControllerSha256 (ConvertTo-ControllerCanonicalJson ([ordered]@{
            generation = 't1250'; source_sha = $integrationSha
        }))
    [IO.File]::WriteAllText((Join-Path $stateRoot "coordinated-source-$currentClaimHash.claim.json"),
        '{"schema_version":1', [Text.UTF8Encoding]::new($false))
    $currentMalformedStart = Invoke-ControllerBoundary $pinnedController $configPath 'Start' $false
    Assert-ControllerTest ($currentMalformedStart.exit_code -ne 0 -and
        $currentMalformedStart.output -match 'claim is unreadable for generation\s+t1250') `
        'malformed claim for the requested source remains operation-bound and actionable'
    Get-ChildItem -LiteralPath $stateRoot -File | Remove-Item -Force
    $env:ASH_ATLAS_CONTROLLER_BOUNDARY_PENDING = '1'
    $concurrentOutOne = Join-Path $boundaryRoot 'concurrent-one.out.txt'
    $concurrentErrOne = Join-Path $boundaryRoot 'concurrent-one.err.txt'
    $concurrentOutTwo = Join-Path $boundaryRoot 'concurrent-two.out.txt'
    $concurrentErrTwo = Join-Path $boundaryRoot 'concurrent-two.err.txt'
    $concurrentOne = Start-Process -FilePath 'powershell.exe' -ArgumentList $controllerArguments `
        -RedirectStandardOutput $concurrentOutOne -RedirectStandardError $concurrentErrOne -WindowStyle Hidden -PassThru
    Start-Sleep -Milliseconds 100
    $concurrentTwo = Start-Process -FilePath 'powershell.exe' -ArgumentList $controllerArguments `
        -RedirectStandardOutput $concurrentOutTwo -RedirectStandardError $concurrentErrTwo -WindowStyle Hidden -PassThru
    Assert-ControllerTest ($concurrentOne.WaitForExit(30000) -and $concurrentTwo.WaitForExit(30000)) `
        'concurrent Start fixtures finish within the bounded test window'
    $concurrentOne.Refresh()
    $concurrentTwo.Refresh()
    $concurrentOutputs = @(
        (Get-Content -Raw -LiteralPath $concurrentOutOne -ErrorAction SilentlyContinue),
        (Get-Content -Raw -LiteralPath $concurrentErrOne -ErrorAction SilentlyContinue),
        (Get-Content -Raw -LiteralPath $concurrentOutTwo -ErrorAction SilentlyContinue),
        (Get-Content -Raw -LiteralPath $concurrentErrTwo -ErrorAction SilentlyContinue)
    )
    $concurrentOutput = $concurrentOutputs -join "`n"
    $concurrentSuccesses = @($concurrentOutputs | Where-Object { $_ -match '"status":"completed"' }).Count
    Assert-ControllerTest ($concurrentSuccesses -eq 1 -and
        $concurrentOutput -match 'ACTION_REQUIRED: coordinated operation' -and
        $concurrentOutput -match 'already owns generation' -and
        @((Get-ChildItem -LiteralPath $stateRoot -Filter '*.coordinated-mobile-dispatch.json' -File)).Count -eq 1) `
        'script-boundary concurrent Start creates one atomic claim and rejects the losing caller'

    $resumeOperation = 'coordinated-resume-fixture'
    $resumeNonce = '1' * 32
    $resumeDispatch = [ordered]@{
        schema_version = 2
        kind = 'ash-atlas-coordinated-mobile-dispatch-request'
        operation_id = $resumeOperation
        requested_mode = 'CoordinatedRelease'
        action = 'start'
        dispatch_nonce = $resumeNonce
        dispatch_name = "ash-atlas-mobile-$resumeOperation-$resumeNonce"
        pinned = [ordered]@{
            generation = 't1250'
            server_sha = $integrationSha
            accepted_master_sha = $masterSha
            current_server_sha = $masterSha
        }
    }
    $resumePath = Join-Path $stateRoot "$resumeOperation.coordinated-mobile-dispatch.json"
    [IO.File]::WriteAllText($resumePath, ($resumeDispatch | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    $resume = Invoke-ControllerBoundary $pinnedController $configPath 'Resume' -ExtraArguments @('-OperationId', $resumeOperation)
    Assert-ControllerTest ($resume.exit_code -eq 0 -and
        $resume.output -match '"action":"Resume"' -and
        $resume.output -match [Regex]::Escape($resumeOperation)) `
        'script-boundary Resume reuses the original durable operation identity'
} finally {
    if ($null -eq $previousBoundaryPending) {
        Remove-Item Env:ASH_ATLAS_CONTROLLER_BOUNDARY_PENDING -ErrorAction SilentlyContinue
    } else {
        $env:ASH_ATLAS_CONTROLLER_BOUNDARY_PENDING = $previousBoundaryPending
    }
    if ($null -eq $previousBoundaryAdmissionPre) {
        Remove-Item Env:ASH_ATLAS_CONTROLLER_BOUNDARY_ADMISSION_PRE -ErrorAction SilentlyContinue
    } else {
        $env:ASH_ATLAS_CONTROLLER_BOUNDARY_ADMISSION_PRE = $previousBoundaryAdmissionPre
    }
    if ($null -eq $previousBoundaryAdmissionPost) {
        Remove-Item Env:ASH_ATLAS_CONTROLLER_BOUNDARY_ADMISSION_POST -ErrorAction SilentlyContinue
    } else {
        $env:ASH_ATLAS_CONTROLLER_BOUNDARY_ADMISSION_POST = $previousBoundaryAdmissionPost
    }
    if ($null -ne $serverProcess) {
        try {
            if (-not $serverProcess.HasExited) { Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue }
            $serverProcess.WaitForExit(5000) | Out-Null
        } catch { }
    }
    if ($null -ne $interleavingProcess) {
        try {
            if (-not $interleavingProcess.HasExited) { Stop-Process -Id $interleavingProcess.Id -Force -ErrorAction SilentlyContinue }
            $interleavingProcess.WaitForExit(5000) | Out-Null
        } catch { }
    }
    if (Test-Path -LiteralPath $sourceRoot -PathType Container) {
        foreach ($worktree in @($featureTwoRoot, $featureOneRoot, $integrationRoot)) {
            if (Test-Path -LiteralPath $worktree -PathType Container) {
                try { Invoke-BoundaryGit $sourceRoot @('worktree', 'remove', '--force', $worktree) | Out-Null } catch { }
            }
        }
    }
    if (Test-Path -LiteralPath $boundaryRoot) {
        Remove-Item -LiteralPath $boundaryRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Output 'coordinated-release-controller.tests.ps1: focused checks passed'
