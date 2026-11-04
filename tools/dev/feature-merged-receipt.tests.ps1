$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
. (Join-Path $PSScriptRoot 'runtime-lib.ps1')
$script:Passed = 0

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
    $script:Passed++
}

$precisionTimestamp = '2026-09-10T07:48:12.4600440Z'
$roundTrippedTimestamp = ('{"merged_at_utc":"' + $precisionTimestamp + '"}' | ConvertFrom-Json).merged_at_utc
Assert-True (Test-AshAtlasUtcTimestampEquivalent $roundTrippedTimestamp '2026-09-10T07:48:12.460044Z') `
    'UTC timestamp comparison accepts equivalent fractional precision after JSON roundtrip'
Assert-True (Test-AshAtlasUtcTimestampEquivalent $precisionTimestamp '2026-09-10T07:48:12.460044Z') `
    'UTC timestamp comparison accepts equivalent fractional precision in strings'
Assert-True (-not (Test-AshAtlasUtcTimestampEquivalent $precisionTimestamp '2026-09-10T07:48:12.4600441Z')) `
    'UTC timestamp comparison rejects a genuinely different instant'
Assert-True (-not (Test-AshAtlasUtcTimestampEquivalent $precisionTimestamp 'not-a-utc-timestamp')) `
    'UTC timestamp comparison rejects an invalid timestamp'

function Invoke-TestGit([string]$Repository, [string[]]$Arguments) {
    $result = Invoke-AshAtlasNative git (@('-C', $Repository) + $Arguments)
    if ($result.ExitCode -ne 0) { throw "git $($Arguments -join ' ') failed: $($result.StdErr)" }
    return $result.StdOut.Trim()
}

function Invoke-TestMarkMerged(
    [string]$ScriptPath,
    [string]$Worktree,
    [string]$Generation,
    [string]$Sha,
    [string]$EffectiveGeneration = '',
    [string]$EffectiveSha = '',
    [string]$DisplayName = '',
    [string]$BatchOperationId = ''
) {
    $arguments = @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ScriptPath, 'mark-merged',
        '-WorktreePath', $Worktree, '-MergedTestGeneration', $Generation,
        '-MergedTestSha', $Sha, '-ConfirmAcceptedIntegration'
    )
    if ($EffectiveGeneration) { $arguments += @('-EffectiveBaseTestGeneration', $EffectiveGeneration) }
    if ($EffectiveSha) { $arguments += @('-EffectiveBaseTestSha', $EffectiveSha) }
    if ($DisplayName) { $arguments += @('-DisplayName', $DisplayName) }
    if ($BatchOperationId) { $arguments += @('-BatchOperationId', $BatchOperationId) }
    return Invoke-AshAtlasNative powershell.exe $arguments
}

$tempRoot = Join-Path $env:TEMP ("ash-atlas-merged-receipt-tests-" + [guid]::NewGuid().ToString('n'))
$remote = Join-Path $tempRoot 'origin.git'
$supervisor = Join-Path $tempRoot 'supervisor'
$worktreeRoot = Join-Path $tempRoot 'worktrees'
$integration = Join-Path $worktreeRoot 'integration-test'
$registered = Join-Path $worktreeRoot 'registered-receipt__t000'
$unregistered = Join-Path $worktreeRoot 'unregistered-receipt__t000'
$batch = Join-Path $worktreeRoot 'batch-receipt__t000'
$explicit = Join-Path $worktreeRoot 'explicit-effective-receipt'
$unproven = Join-Path $worktreeRoot 'unproven-receipt__t000'
$effective = Join-Path $worktreeRoot 'effective-receipt__t000'
$launcherRoot = Join-Path $tempRoot 'launchers'
$leasePath = Join-Path $tempRoot 'state\dev-runtimes.json'
$oldLeasePath = $env:ASH_ATLAS_DEV_RUNTIME_LEASE_PATH
$oldTestMode = $env:ASH_ATLAS_RUNTIME_TEST_MODE

New-Item -ItemType Directory -Path $tempRoot, $worktreeRoot -Force | Out-Null
try {
    & git init --bare $remote | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not initialize receipt-test remote.' }
    & git clone $remote $supervisor | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not clone receipt-test supervisor.' }
    Invoke-TestGit $supervisor @('config', 'user.name', 'Ash Atlas Tests') | Out-Null
    Invoke-TestGit $supervisor @('config', 'user.email', 'tests@ash-atlas.invalid') | Out-Null
    Invoke-TestGit $supervisor @('checkout', '-b', 'master') | Out-Null

    New-Item -ItemType Directory -Path (Join-Path $supervisor 'tools\dev'), (Join-Path $supervisor 'config') -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $root 'tools\dev\runtime-lib.ps1') -Destination (Join-Path $supervisor 'tools\dev\runtime-lib.ps1')
    Copy-Item -LiteralPath (Join-Path $root 'tools\dev\world-runtime-groups.ps1') -Destination (Join-Path $supervisor 'tools\dev\world-runtime-groups.ps1')
    Copy-Item -LiteralPath (Join-Path $root 'tools\dev\feature-runtime.ps1') -Destination (Join-Path $supervisor 'tools\dev\feature-runtime.ps1')
    Copy-Item -LiteralPath (Join-Path $root 'tools\dev\test-generation.ps1') -Destination (Join-Path $supervisor 'tools\dev\test-generation.ps1')
    $config = Get-Content -Raw -LiteralPath (Join-Path $root 'config\dev-runtime.defaults.json') | ConvertFrom-Json
    $config.permanent_checkout = $supervisor
    $config.feature_worktree_root = $worktreeRoot
    $config.feature_launcher_root = $launcherRoot
    $config | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $supervisor 'config\dev-runtime.defaults.json') -Encoding utf8
    Invoke-TestGit $supervisor @('add', 'tools/dev', 'config/dev-runtime.defaults.json') | Out-Null
    Invoke-TestGit $supervisor @('commit', '-m', 'test fixture') | Out-Null
    $baseSha = Invoke-TestGit $supervisor @('rev-parse', 'HEAD')
    Invoke-TestGit $supervisor @('branch', 'integration/test', $baseSha) | Out-Null
    Invoke-TestGit $supervisor @('tag', 'test/t000', $baseSha) | Out-Null
    Invoke-TestGit $supervisor @('push', 'origin', 'master', 'integration/test', 'test/t000') | Out-Null

    Invoke-TestGit $supervisor @('worktree', 'add', $integration, 'integration/test') | Out-Null
    Invoke-TestGit $supervisor @('worktree', 'add', '-b', 'fix/registered-receipt--from-t000', $registered, $baseSha) | Out-Null
    Invoke-TestGit $registered @('commit', '--allow-empty', '-m', 'registered feature') | Out-Null
    $registeredTip = Invoke-TestGit $registered @('rev-parse', 'HEAD')
    Invoke-TestGit $registered @('push', '-u', 'origin', 'fix/registered-receipt--from-t000') | Out-Null
    Invoke-TestGit $supervisor @('worktree', 'add', '-b', 'feature/unregistered-receipt--from-t000', $unregistered, $baseSha) | Out-Null
    Invoke-TestGit $unregistered @('commit', '--allow-empty', '-m', 'unregistered feature') | Out-Null
    $unregisteredTip = Invoke-TestGit $unregistered @('rev-parse', 'HEAD')
    Invoke-TestGit $unregistered @('push', '-u', 'origin', 'feature/unregistered-receipt--from-t000') | Out-Null
    Invoke-TestGit $supervisor @('worktree', 'add', '-b', 'feature/batch-receipt--from-t000', $batch, $baseSha) | Out-Null
    Invoke-TestGit $batch @('commit', '--allow-empty', '-m', 'batch feature') | Out-Null
    $batchTip = Invoke-TestGit $batch @('rev-parse', 'HEAD')
    Invoke-TestGit $batch @('push', '-u', 'origin', 'feature/batch-receipt--from-t000') | Out-Null
    Invoke-TestGit $supervisor @('checkout', '-b', 'infrastructure-head', $baseSha) | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $supervisor 'tools\release') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $supervisor 'tools\release\release-flow.tests.ps1') -Value 'infrastructure'
    Invoke-TestGit $supervisor @('add', 'tools/release/release-flow.tests.ps1') | Out-Null
    Invoke-TestGit $supervisor @('commit', '-m', 'approved infrastructure head') | Out-Null
    $infrastructureHead = Invoke-TestGit $supervisor @('rev-parse', 'HEAD')
    Invoke-TestGit $supervisor @('checkout', 'master') | Out-Null
    Invoke-TestGit $supervisor @('worktree', 'add', '-b', 'fix/explicit-effective-receipt', $explicit, $infrastructureHead) | Out-Null
    Invoke-TestGit $explicit @('commit', '--allow-empty', '-m', 'explicit effective-base feature') | Out-Null
    $explicitTip = Invoke-TestGit $explicit @('rev-parse', 'HEAD')
    Invoke-TestGit $explicit @('push', '-u', 'origin', 'fix/explicit-effective-receipt') | Out-Null
    Invoke-TestGit $supervisor @('worktree', 'add', '-b', 'fix/unproven-receipt--from-t000', $unproven, $baseSha) | Out-Null
    Invoke-TestGit $unproven @('commit', '--allow-empty', '-m', 'unproven feature') | Out-Null
    Invoke-TestGit $unproven @('push', '-u', 'origin', 'fix/unproven-receipt--from-t000') | Out-Null

    Invoke-TestGit $integration @('merge', '--no-ff', '--no-edit', $infrastructureHead) | Out-Null
    Invoke-TestGit $integration @('merge', '--no-ff', '--no-edit', $registeredTip) | Out-Null
    Invoke-TestGit $integration @('merge', '--no-ff', '--no-edit', $unregisteredTip) | Out-Null
    Invoke-TestGit $integration @('merge', '--no-ff', '--no-edit', $batchTip) | Out-Null
    Invoke-TestGit $integration @('merge', '--no-ff', '--no-edit', $explicitTip) | Out-Null
    $mergedSha = Invoke-TestGit $integration @('rev-parse', 'HEAD')
    Invoke-TestGit $integration @('push', 'origin', 'integration/test') | Out-Null
    Invoke-TestGit $supervisor @('tag', 'test/t001', $mergedSha) | Out-Null
    Invoke-TestGit $supervisor @('push', 'origin', 'test/t001') | Out-Null
    Invoke-TestGit $supervisor @('worktree', 'add', '-b', 'chore/effective-receipt--from-t000', $effective, $mergedSha) | Out-Null
    Invoke-TestGit $effective @('commit', '--allow-empty', '-m', 'historically mislabeled feature') | Out-Null
    $effectiveTip = Invoke-TestGit $effective @('rev-parse', 'HEAD')
    Invoke-TestGit $effective @('push', '-u', 'origin', 'chore/effective-receipt--from-t000') | Out-Null
    Invoke-TestGit $integration @('merge', '--no-ff', '--no-edit', $effectiveTip) | Out-Null
    $mergedSha2 = Invoke-TestGit $integration @('rev-parse', 'HEAD')
    Invoke-TestGit $integration @('push', 'origin', 'integration/test') | Out-Null
    Invoke-TestGit $supervisor @('tag', 'test/t002', $mergedSha2) | Out-Null
    Invoke-TestGit $supervisor @('push', 'origin', 'test/t002') | Out-Null

    $env:ASH_ATLAS_DEV_RUNTIME_LEASE_PATH = $leasePath
    $env:ASH_ATLAS_RUNTIME_TEST_MODE = '1'
    $fixtureConfig = Read-AshAtlasRuntimeDefaults (Join-Path $supervisor 'config\dev-runtime.defaults.json')
    $registeredIdentity = New-AshAtlasFeatureIdentity $fixtureConfig $registered 'fix/registered-receipt--from-t000' $baseSha
    $registeredIdentity.ports = [pscustomobject]@{ frontend = 41000; backend = 41001; postgres = 41002; world_api = 41900 }
    Add-Member -InputObject $registeredIdentity -NotePropertyName display_name -NotePropertyValue 'Registered Receipt'
    $activeLauncher = Get-AshAtlasFeatureLauncherPath $launcherRoot 'Registered Receipt' 't000'
    Add-Member -InputObject $registeredIdentity -NotePropertyName launcher_path -NotePropertyValue $activeLauncher
    New-Item -ItemType Directory -Path (Split-Path -Parent $activeLauncher) -Force | Out-Null
    New-AshAtlasFeatureLauncherContent $fixtureConfig $registeredIdentity 'Registered Receipt' $supervisor |
        Set-Content -LiteralPath $activeLauncher -Encoding ascii -NoNewline
    $store = [pscustomobject]@{ schema_version = 2; runtimes = @() }
    Set-AshAtlasLease $store $registeredIdentity | Out-Null
    Write-AshAtlasLeaseStore $store $leasePath

    $featureRuntime = Join-Path $supervisor 'tools\dev\feature-runtime.ps1'
    $registeredResult = Invoke-TestMarkMerged $featureRuntime $registered 't001' $mergedSha
    if ($registeredResult.ExitCode -ne 0) { throw "Registered mark-merged failed: $($registeredResult.StdErr)" }
    Assert-True ($registeredResult.ExitCode -eq 0) 'registered feature receipt succeeds'
    $registeredReceipt = Get-AshAtlasMergedLauncherPath $launcherRoot 'Registered Receipt' 't000' 't001'
    Assert-True ((Test-Path -LiteralPath $registeredReceipt) -and -not (Test-Path -LiteralPath $activeLauncher)) 'registered feature archives its receipt and removes its active launcher'
    $registeredStore = Read-AshAtlasLeaseStore $leasePath
    Assert-True (@($registeredStore.runtimes).Count -eq 0) 'registered feature retires its runtime reservation after preserving the receipt'

    $repeatResult = Invoke-TestMarkMerged $featureRuntime $registered 't001' $mergedSha
    Assert-True ($repeatResult.ExitCode -eq 0 -and $repeatResult.StdOut -match 'already marked merged') `
        "repeating the exact registered operation is idempotent: $($repeatResult.StdErr)"
    Assert-True (@(Get-ChildItem -LiteralPath (Join-Path $launcherRoot 'Merged') -Filter '*.cmd').Count -eq 1) 'idempotent registered operation creates no duplicate'

    $priorRegisteredReceiptContent = Get-Content -Raw -LiteralPath $registeredReceipt
    Invoke-TestGit $registered @('commit', '--allow-empty', '-m', 'continued registered feature') | Out-Null
    $continuedRegisteredTip = Invoke-TestGit $registered @('rev-parse', 'HEAD')
    Invoke-TestGit $registered @('push', 'origin', 'fix/registered-receipt--from-t000') | Out-Null
    Invoke-TestGit $integration @('merge', '--no-ff', '--no-edit', $continuedRegisteredTip) | Out-Null
    $mergedSha3 = Invoke-TestGit $integration @('rev-parse', 'HEAD')
    Invoke-TestGit $integration @('push', 'origin', 'integration/test') | Out-Null
    Invoke-TestGit $supervisor @('tag', 'test/t003', $mergedSha3) | Out-Null
    Invoke-TestGit $supervisor @('push', 'origin', 'test/t003') | Out-Null

    $continuedResult = Invoke-TestMarkMerged $featureRuntime $registered 't003' $mergedSha3
    if ($continuedResult.ExitCode -ne 0) { throw "Continued registered mark-merged failed: $($continuedResult.StdErr)" }
    $continuedReceipt = Get-AshAtlasMergedLauncherPath $launcherRoot 'Registered Receipt' 't000' 't003'
    $continuedMarker = Get-Content -Raw -LiteralPath (Join-Path $registered '__MERGED_TO_TEST__.md')
    $continuedStore = Read-AshAtlasLeaseStore $leasePath
    Assert-True ((Get-Content -Raw -LiteralPath $registeredReceipt) -ceq $priorRegisteredReceiptContent) `
        'continued acceptance preserves the earlier immutable receipt'
    Assert-True ((Test-Path -LiteralPath $continuedReceipt) -and
        (Get-Content -Raw -LiteralPath $continuedReceipt) -match [regex]::Escape($continuedRegisteredTip)) `
        'continued acceptance creates a receipt for the new exact feature tip'
    Assert-True ($continuedMarker -match 'Included in generation: t003' -and
        $continuedMarker -match [regex]::Escape($mergedSha3) -and
        @($continuedStore.runtimes).Count -eq 0) `
        'continued acceptance advances the marker without recreating a retired runtime reservation'
    $continuedRepeat = Invoke-TestMarkMerged $featureRuntime $registered 't003' $mergedSha3
    Assert-True ($continuedRepeat.ExitCode -eq 0 -and $continuedRepeat.StdOut -match 'already marked merged') `
        'continued acceptance remains idempotent at its new exact generation'

    $unregisteredResult = Invoke-TestMarkMerged $featureRuntime $unregistered 't001' $mergedSha
    Assert-True ($unregisteredResult.ExitCode -eq 0) 'unregistered feature receipt succeeds'
    $unregisteredReceipt = Get-AshAtlasMergedLauncherPath $launcherRoot 'Unregistered Receipt' 't000' 't001'
    $unregisteredContent = Get-Content -Raw -LiteralPath $unregisteredReceipt
    Assert-True ($unregisteredContent -match [regex]::Escape($unregisteredTip) -and
        $unregisteredContent -match 'Source branch: feature/unregistered-receipt--from-t000' -and
        $unregisteredContent -match [regex]::Escape($baseSha)) 'unregistered receipt records branch, feature tip, and base SHA'
    Assert-True ((Read-AshAtlasLeaseStore $leasePath).runtimes.Count -eq 0) 'unregistered feature leaves no fake runtime lease'

    $priorUnregisteredContent = Get-Content -Raw -LiteralPath $unregisteredReceipt
    Invoke-TestGit $unregistered @('commit', '--allow-empty', '-m', 'continued unregistered feature') | Out-Null
    $continuedUnregisteredTip = Invoke-TestGit $unregistered @('rev-parse', 'HEAD')
    Invoke-TestGit $unregistered @('push', 'origin', 'feature/unregistered-receipt--from-t000') | Out-Null
    Invoke-TestGit $integration @('merge', '--no-ff', '--no-edit', $continuedUnregisteredTip) | Out-Null
    $mergedSha4 = Invoke-TestGit $integration @('rev-parse', 'HEAD')
    Invoke-TestGit $integration @('push', 'origin', 'integration/test') | Out-Null
    Invoke-TestGit $supervisor @('tag', 'test/t004', $mergedSha4) | Out-Null
    Invoke-TestGit $supervisor @('push', 'origin', 'test/t004') | Out-Null

    $continuedUnregisteredResult = Invoke-TestMarkMerged $featureRuntime $unregistered 't004' $mergedSha4 `
        '' '' 'Renamed Attempt'
    if ($continuedUnregisteredResult.ExitCode -ne 0) {
        throw "Continued unregistered mark-merged failed: $($continuedUnregisteredResult.StdErr)"
    }
    $continuedUnregisteredReceipt = Get-AshAtlasMergedLauncherPath $launcherRoot 'Unregistered Receipt' 't000' 't004'
    $continuedUnregisteredMarker = Get-Content -Raw -LiteralPath (Join-Path $unregistered '__MERGED_TO_TEST__.md')
    Assert-True ((Get-Content -Raw -LiteralPath $unregisteredReceipt) -ceq $priorUnregisteredContent) `
        'continued unregistered acceptance preserves the earlier immutable receipt'
    Assert-True ((Test-Path -LiteralPath $continuedUnregisteredReceipt) -and
        (Get-Content -Raw -LiteralPath $continuedUnregisteredReceipt) -match [regex]::Escape($continuedUnregisteredTip)) `
        'continued unregistered acceptance creates a receipt for the new exact feature tip'
    Assert-True ($continuedUnregisteredMarker -match 'Feature: Unregistered Receipt' -and
        $continuedUnregisteredMarker -match 'Included in generation: t004' -and
        -not (Test-Path -LiteralPath (Get-AshAtlasMergedLauncherPath $launcherRoot 'Renamed Attempt' 't000' 't004'))) `
        'continued unregistered acceptance preserves the original feature identity'

    $batchOperationId = 'batch-fixture-001'
    $batchResult = Invoke-TestMarkMerged $featureRuntime $batch 't001' $mergedSha `
        't000' $baseSha 'Batch Receipt' $batchOperationId
    if ($batchResult.ExitCode -ne 0) { throw "Batch mark-merged failed: $($batchResult.StdErr)" }
    $batchReceipt = Get-AshAtlasMergedLauncherPath $launcherRoot 'Batch Receipt' 't000' 't001'
    $batchContent = Get-Content -Raw -LiteralPath $batchReceipt
    $batchMarker = Get-Content -Raw -LiteralPath (Join-Path $batch '__MERGED_TO_TEST__.md')
    Assert-True ($batchContent -match "Batch operation ID: $batchOperationId" -and
        $batchMarker -match "Batch operation ID: $batchOperationId") `
        'batch receipt and marker bind an earlier merge-chain feature to the shared operation ID'
    $batchRepeat = Invoke-TestMarkMerged $featureRuntime $batch 't001' $mergedSha `
        't000' $baseSha 'Batch Receipt' $batchOperationId
    Assert-True ($batchRepeat.ExitCode -eq 0 -and $batchRepeat.StdOut -match 'already marked merged') `
        'batch receipt reconciliation is idempotent for the same operation and final SHA'

    $explicitResult = Invoke-TestMarkMerged $featureRuntime $explicit 't001' $mergedSha 't000' $baseSha 'Explicit Effective Receipt'
    if ($explicitResult.ExitCode -ne 0) { throw "Explicit effective-base mark-merged failed: $($explicitResult.StdErr)" }
    $explicitReceipt = Get-AshAtlasMergedLauncherPath $launcherRoot 'Explicit Effective Receipt' 't000' 't001'
    Assert-True ((Test-Path -LiteralPath $explicitReceipt) -and
        (Get-Content -Raw -LiteralPath $explicitReceipt) -match [regex]::Escape($baseSha)) 'explicit effective-base metadata supports an unlabeled feature source'

    $refusedResult = Invoke-TestMarkMerged $featureRuntime $unproven 't001' $mergedSha
    Assert-True ($refusedResult.ExitCode -ne 0 -and $refusedResult.StdErr -match 'is not an ancestor') 'unproven feature ancestry is refused'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $unproven '__MERGED_TO_TEST__.md'))) 'refused ancestry creates no merged marker'

    $missingGeneration = Invoke-TestMarkMerged $featureRuntime $effective 't002' $mergedSha2 '' $mergedSha
    Assert-True ($missingGeneration.ExitCode -ne 0 -and $missingGeneration.StdErr -match 'must be supplied together|requires .* together') 'effective SHA without generation is refused'
    $missingSha = Invoke-TestMarkMerged $featureRuntime $effective 't002' $mergedSha2 't001' ''
    Assert-True ($missingSha.ExitCode -ne 0 -and $missingSha.StdErr -match 'must be supplied together|requires .* together') 'effective generation without SHA is refused'
    $wrongGeneration = Invoke-TestMarkMerged $featureRuntime $effective 't002' $mergedSha2 't000' $mergedSha
    Assert-True ($wrongGeneration.ExitCode -ne 0 -and $wrongGeneration.StdErr -match 'does not point|does not.*proven base|resolves to') 'generation whose tag disagrees with effective SHA is refused'
    $wrongSha = Invoke-TestMarkMerged $featureRuntime $effective 't002' $mergedSha2 't001' $baseSha
    Assert-True ($wrongSha.ExitCode -ne 0 -and $wrongSha.StdErr -match 'does not point|does not.*proven base|resolves to') 'effective SHA that disagrees with generation tag is refused'
    $notInAncestry = Invoke-TestMarkMerged $featureRuntime $unproven 't002' $mergedSha2 't001' $mergedSha
    Assert-True ($notInAncestry.ExitCode -ne 0) 'effective SHA outside feature ancestry is refused'
    $notOlder = Invoke-TestMarkMerged $featureRuntime $effective 't002' $mergedSha2 't002' $mergedSha2
    Assert-True ($notOlder.ExitCode -ne 0) 'effective generation equal to merged generation is refused'

    $effectiveIdentity = New-AshAtlasFeatureIdentity $fixtureConfig $effective 'chore/effective-receipt--from-t000' $baseSha
    $effectiveIdentity.ports = [pscustomobject]@{ frontend = 42000; backend = 42001; postgres = 42002; world_api = 42900 }
    Add-Member -InputObject $effectiveIdentity -NotePropertyName display_name -NotePropertyValue 'Effective Receipt'
    Add-Member -InputObject $effectiveIdentity -NotePropertyName launcher_path -NotePropertyValue (Join-Path $launcherRoot 'unused-effective.cmd')
    $leaseMismatchStore = Read-AshAtlasLeaseStore $leasePath
    Set-AshAtlasLease $leaseMismatchStore $effectiveIdentity | Out-Null
    Write-AshAtlasLeaseStore $leaseMismatchStore $leasePath
    $leaseMismatch = Invoke-TestMarkMerged $featureRuntime $effective 't002' $mergedSha2 't001' $mergedSha
    Assert-True ($leaseMismatch.ExitCode -ne 0 -and $leaseMismatch.StdErr -match 'registered runtime lease base') 'registered lease base mismatch fails closed'
    $leaseMismatchStore.runtimes = @($leaseMismatchStore.runtimes | Where-Object runtime_id -ne $effectiveIdentity.runtime_id)
    Write-AshAtlasLeaseStore $leaseMismatchStore $leasePath

    $effectiveResult = Invoke-TestMarkMerged $featureRuntime $effective 't002' $mergedSha2 't001' $mergedSha
    if ($effectiveResult.ExitCode -ne 0) { throw "Effective-base mark-merged failed: $($effectiveResult.StdErr)" }
    $effectiveReceipt = Get-AshAtlasMergedLauncherPath $launcherRoot 'Effective Receipt' 't001' 't002'
    $effectiveMarker = Get-Content -Raw -LiteralPath (Join-Path $effective '__MERGED_TO_TEST__.md')
    $effectiveContent = Get-Content -Raw -LiteralPath $effectiveReceipt
    Assert-True ((Test-Path -LiteralPath $effectiveReceipt) -and
        -not (Test-Path -LiteralPath (Get-AshAtlasMergedLauncherPath $launcherRoot 'Effective Receipt' 't000' 't002'))) 'historically mislabeled feature creates only the truthful t001 to t002 receipt'
    Assert-True ($effectiveContent -match 'Base test generation: t001' -and
        $effectiveContent -match [regex]::Escape($mergedSha)) 'effective receipt records the proven generation and exact base SHA'
    Assert-True ($effectiveMarker -match 'Started from generation: t001' -and
        $effectiveMarker -match [regex]::Escape($mergedSha)) 'merged marker records the proven effective base'
} finally {
    if ($null -eq $oldLeasePath) { Remove-Item Env:ASH_ATLAS_DEV_RUNTIME_LEASE_PATH -ErrorAction SilentlyContinue }
    else { $env:ASH_ATLAS_DEV_RUNTIME_LEASE_PATH = $oldLeasePath }
    if ($null -eq $oldTestMode) { Remove-Item Env:ASH_ATLAS_RUNTIME_TEST_MODE -ErrorAction SilentlyContinue }
    else { $env:ASH_ATLAS_RUNTIME_TEST_MODE = $oldTestMode }
    if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}

Write-Host "feature-merged-receipt.tests.ps1: $script:Passed assertions passed." -ForegroundColor Green
