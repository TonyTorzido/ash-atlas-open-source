$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$libraryPath = Join-Path $PSScriptRoot 'runtime-lib.ps1'
. $libraryPath
$script:Passed = 0

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
    $script:Passed++
}

function Assert-Equal($Actual, $Expected, [string]$Message) {
    if ($Actual -ne $Expected) { throw "ASSERTION FAILED: $Message. Expected '$Expected', got '$Actual'." }
    $script:Passed++
}

function Assert-Throws([scriptblock]$Action, [string]$Pattern, [string]$Message) {
    try { & $Action; throw "ASSERTION FAILED: $Message did not throw." }
    catch {
        if ($_.Exception.Message -notmatch $Pattern) { throw "ASSERTION FAILED: $Message threw '$($_.Exception.Message)'." }
    }
    $script:Passed++
}

function Start-MutexHolder([string]$RuntimeId, [int]$HoldMilliseconds, [string]$MarkerPath) {
    $name = "Global\AshAtlas_DevRuntime_$(Get-AshAtlasStableHash $RuntimeId 12)"
    $escapedName = $name.Replace("'", "''")
    $escapedMarker = $MarkerPath.Replace("'", "''")
    $code = @"
`$ErrorActionPreference = 'Stop'
`$mutex = [Threading.Mutex]::new(`$false, '$escapedName')
`$owned = `$false
try {
    `$owned = `$mutex.WaitOne([TimeSpan]::FromSeconds(10))
    if (-not `$owned) { exit 2 }
    [IO.File]::WriteAllText('$escapedMarker', 'ready')
    Start-Sleep -Milliseconds $HoldMilliseconds
} finally {
    if (`$owned) { `$mutex.ReleaseMutex() | Out-Null }
    `$mutex.Dispose()
}
"@
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($code))
    return Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList @('-NoProfile', '-EncodedCommand', $encoded) -WindowStyle Hidden -PassThru
}

function Wait-Marker([string]$Path) {
    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $Path)) { Start-Sleep -Milliseconds 25 }
    if (-not (Test-Path -LiteralPath $Path)) { throw "Timed out waiting for test holder marker $Path" }
}

function Start-StateCleanupWorker(
    [string]$RuntimeStateRoot,
    [string]$StatePath,
    [string]$GatePath,
    [string]$DeletedPath,
    [ValidateSet('first', 'second')][string]$Order
) {
    $escapedLibrary = $libraryPath.Replace("'", "''")
    $escapedRoot = $RuntimeStateRoot.Replace("'", "''")
    $escapedState = $StatePath.Replace("'", "''")
    $escapedGate = $GatePath.Replace("'", "''")
    $escapedDeleted = $DeletedPath.Replace("'", "''")
    $waitForFirst = if ($Order -eq 'second') {
        "while (-not (Test-Path -LiteralPath '$escapedDeleted')) { Start-Sleep -Milliseconds 10 }"
    } else { '' }
    $signalDeleted = if ($Order -eq 'first') {
        "[IO.File]::WriteAllText('$escapedDeleted', 'deleted')"
    } else { '' }
    $code = @"
`$ErrorActionPreference = 'Stop'
. '$escapedLibrary'
while (-not (Test-Path -LiteralPath '$escapedGate')) { Start-Sleep -Milliseconds 10 }
$waitForFirst
Remove-AshAtlasExpectedRuntimeStateFile '$escapedRoot' '$escapedState'
$signalDeleted
"@
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($code))
    $stderr = Join-Path (Split-Path -Parent $GatePath) ("cleanup-worker-" + [guid]::NewGuid().ToString('n') + '.stderr')
    $worker = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList @('-NoProfile', '-EncodedCommand', $encoded) `
        -WindowStyle Hidden -RedirectStandardError $stderr -PassThru
    Add-Member -InputObject $worker -NotePropertyName stderr_path -NotePropertyValue $stderr
    return $worker
}

# Windows CI may expose TEMP through an 8.3 alias; launch and record the same full path.
$tempRoot = [IO.Path]::GetFullPath((Join-Path $env:TEMP ("ash-atlas-launcher-lifecycle-tests-" + [guid]::NewGuid().ToString('n'))))
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
try {
    $opened = ''
    $openedResult = Open-AshAtlasRuntimeFrontend 'http://127.0.0.1:41291' -OpenAction { param($url) $script:opened = $url }
    Assert-True $openedResult 'healthy reuse opens a browser target'
    Assert-Equal $script:opened 'http://127.0.0.1:41291' 'healthy reuse opens the exact frontend URL'
    Assert-True (-not (Open-AshAtlasRuntimeFrontend 'http://127.0.0.1:41291' -NoBrowser)) 'NoBrowser suppresses URL opening'

    $generationIdentity = New-AshAtlasFeatureIdentity `
        (Read-AshAtlasRuntimeDefaults (Join-Path $root 'config\dev-runtime.defaults.json')) `
        'C:\Users\dev\Documents\worktrees\launcher-check__t007' `
        'feature/launcher-check--from-t007' ('b' * 40)
    $generationIdentity.ports = [pscustomobject]@{ frontend = 41291; backend = 41292; postgres = 41293; world_api = 41900 }
    $generationLauncher = New-AshAtlasFeatureLauncherContent `
        (Read-AshAtlasRuntimeDefaults (Join-Path $root 'config\dev-runtime.defaults.json')) `
        $generationIdentity 'Launcher Check'
    Assert-Equal (ConvertTo-AshAtlasLauncherFileName 'Launcher Check' 't007') 'Run Launcher Check [t007].cmd' 'launcher filename keeps the base generation visible'
    Assert-True ($generationLauncher -match 'Base test generation: t007' -and $generationLauncher -match 'Base integration SHA: b{40}') 'launcher content keeps the immutable base identity visible'
    Assert-Equal (Get-AshAtlasFeatureLauncherPath 'C:\Feature Launchers' 'Launcher Check' 't007') 'C:\Feature Launchers\Active\Run Launcher Check [t007].cmd' 'future active launcher uses the Active directory'
    $mergedLauncherPath = Get-AshAtlasMergedLauncherPath 'C:\Feature Launchers' 'Launcher Check' 't007' 't009'
    Assert-Equal $mergedLauncherPath 'C:\Feature Launchers\Merged\[MERGED] Launcher Check [t007 to t009].cmd' 'archived launcher filename shows base and accepted generations'
    $mergedLauncher = New-AshAtlasMergedLauncherContent 'Launcher Check' 'feature/launcher-check--from-t007' `
        ('d' * 40) 't007' ('b' * 40) 't009' ('c' * 40)
    Assert-True ($mergedLauncher -match 'already been accepted into Integration Test' -and
        $mergedLauncher -match 'Feature: Launcher Check' -and
        $mergedLauncher -match 'Source branch: feature/launcher-check--from-t007' -and
        $mergedLauncher -match 'Feature tip SHA: d{40}' -and
        $mergedLauncher -match 'Base test generation: t007' -and
        $mergedLauncher -match 'Base integration SHA: b{40}' -and
        $mergedLauncher -match 'Merged test generation: t009' -and
        $mergedLauncher -match 'Merged integration SHA: c{40}') 'archived launcher displays the complete merged receipt'
    Assert-True ($mergedLauncher -notmatch 'powershell|run-main|WorktreePath|RemoveFeature|cleanup|restart|inspect') 'archived launcher cannot control a feature runtime'
    $windowsSafeMergedPath = Get-AshAtlasMergedLauncherPath $tempRoot 'Launcher Check' 't007' 't009'
    New-Item -ItemType Directory -Path (Split-Path -Parent $windowsSafeMergedPath) -Force | Out-Null
    Set-Content -LiteralPath $windowsSafeMergedPath -Value $mergedLauncher -Encoding ascii -NoNewline
    Assert-True (Test-Path -LiteralPath $windowsSafeMergedPath -PathType Leaf) 'merged receipt filename is valid on Windows'
    $mergedMarker = New-AshAtlasMergedMarkerContent 'Launcher Check' 'feature/launcher-check--from-t007' `
        't007' ('b' * 40) 't009' ('c' * 40) '2026-07-18T01:02:03.0000000Z'
    Assert-True ($mergedMarker -match '^# Merged to Integration Test' -and
        $mergedMarker -match 'Feature: Launcher Check' -and
        $mergedMarker -match 'Branch: feature/launcher-check--from-t007' -and
        $mergedMarker -match 'Started from generation: t007' -and
        $mergedMarker -match 'Included in generation: t009') 'worktree marker records the complete accepted integration identity'

    $currentProcessStart = (Get-Process -Id $PID -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')
    $dateTimeRecord = ('{"pid":' + $PID + ',"start_time_utc":"' + $currentProcessStart + '"}' | ConvertFrom-Json)
    Assert-Equal (Get-AshAtlasRecordedProcessStatus $dateTimeRecord).status 'match' 'JSON process start preserves exact current-process ownership'

    $fakeRecord = ('{"pid":' + $PID + ',"start_time_utc":"2000-01-01T00:00:00.0000000Z"}' | ConvertFrom-Json)
    Assert-Throws { Assert-AshAtlasRecordedProcessIdentity $fakeRecord 'PID reuse fixture' | Out-Null } 'PID .* reused' 'PID reuse is refused'
    Assert-True ($null -ne (Get-Process -Id $PID -ErrorAction SilentlyContinue)) 'PID-reuse refusal never terminates the unrelated process'
    $currentProcess = Get-Process -Id $PID -ErrorAction Stop
    $currentStart = $currentProcess.StartTime.ToUniversalTime()
    $dateConvertedRecord = [pscustomobject]@{ pid = $PID; start_time_utc = $currentStart }
    Assert-Equal (Get-AshAtlasRecordedProcessStatus $dateConvertedRecord).status 'match' 'PowerShell 7 DateTime conversion preserves exact process-start identity'
    Assert-Equal (ConvertTo-AshAtlasCanonicalUtcTimestamp $currentStart) $currentStart.ToString('o') 'DateTime and ISO child-parent timestamps share one canonical UTC identity'

    $cleanupRoot = Join-Path $tempRoot 'concurrent-runtime-state'
    New-Item -ItemType Directory -Path $cleanupRoot -Force | Out-Null
    $processState = Join-Path $cleanupRoot 'owned-processes.json'
    $unrelatedState = Join-Path $tempRoot 'unrelated-state.txt'
    Set-Content -LiteralPath $unrelatedState -Value 'must remain' -Encoding ascii
    $goneChildren = @(
        Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Seconds 30') -WindowStyle Hidden -PassThru
        Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Seconds 30') -WindowStyle Hidden -PassThru
    )
    $goneRecords = @($goneChildren | ForEach-Object {
        [pscustomobject]@{
            pid = $_.Id
            start_time_utc = $_.StartTime.ToUniversalTime().ToString('o')
            runtime_id = 'cleanup-race-runtime'
            worktree = 'C:\verified-cleanup-race'
        }
    })
    $goneRecords | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $processState -Encoding utf8
    foreach ($child in $goneChildren) {
        Stop-Process -Id $child.Id -Force
        $child.WaitForExit()
    }
    Assert-True (@($goneRecords | Where-Object {
        (Get-AshAtlasRecordedProcessStatus $_).status -eq 'missing'
    }).Count -eq 2) 'both recorded child processes may already be gone before state cleanup'

    $cleanupGate = Join-Path $tempRoot 'cleanup.gate'
    $deletedGate = Join-Path $tempRoot 'cleanup.deleted'
    $cleanupWorkers = @(
        Start-StateCleanupWorker $cleanupRoot $processState $cleanupGate $deletedGate 'first'
        Start-StateCleanupWorker $cleanupRoot $processState $cleanupGate $deletedGate 'second'
    )
    Set-Content -LiteralPath $cleanupGate -Value 'go' -Encoding ascii
    foreach ($worker in $cleanupWorkers) {
        $worker.WaitForExit()
        $workerError = if (Test-Path -LiteralPath $worker.stderr_path) {
            Get-Content -Raw -LiteralPath $worker.stderr_path
        } else { '' }
        $worker.Refresh()
        Assert-Equal ([int]$worker.ExitCode) 0 "concurrent verified state cleanup exits successfully: $workerError"
    }
    Assert-True (-not (Test-Path -LiteralPath $processState)) 'one cleanup path may remove owned process state before the other'
    Remove-AshAtlasExpectedRuntimeStateFile $cleanupRoot $processState
    Assert-True (Test-Path -LiteralPath $unrelatedState -PathType Leaf) 'concurrent cleanup preserves unrelated files'
    Assert-Throws {
        Remove-AshAtlasExpectedRuntimeStateFile $cleanupRoot $unrelatedState
    } 'REFUSED:.*not an expected runtime state file' 'state cleanup refuses unrelated paths'
    Assert-True (Test-Path -LiteralPath $unrelatedState -PathType Leaf) 'refused unrelated path is not deleted'

    $lockedState = Join-Path $cleanupRoot 'ready'
    Set-Content -LiteralPath $lockedState -Value 'locked' -Encoding ascii
    $lockedHandle = [IO.File]::Open($lockedState, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try {
        Assert-Throws {
            Remove-AshAtlasExpectedRuntimeStateFile $cleanupRoot $lockedState
        } 'used by another process|cannot access|being used' 'non-absent state deletion errors still fail'
        Assert-True (Test-Path -LiteralPath $lockedState -PathType Leaf) 'failed deletion leaves the locked state file intact'
    } finally {
        $lockedHandle.Dispose()
    }
    Remove-AshAtlasExpectedRuntimeStateFile $cleanupRoot $lockedState

    $malformedState = Join-Path $cleanupRoot 'supervisor.json'
    New-Item -ItemType Directory -Path $malformedState -Force | Out-Null
    Assert-Throws {
        Remove-AshAtlasExpectedRuntimeStateFile $cleanupRoot $malformedState
    } 'expected runtime state file is a directory' 'malformed state paths are not suppressed as absent'
    Assert-True (Test-Path -LiteralPath $malformedState -PathType Container) 'malformed state directory is not deleted'
    Remove-Item -LiteralPath $malformedState -Force

    $delayedRuntime = 'test-delayed-release-' + [guid]::NewGuid().ToString('n')
    $delayedMarker = Join-Path $tempRoot 'delayed.marker'
    $delayed = Start-MutexHolder $delayedRuntime 1200 $delayedMarker
    Wait-Marker $delayedMarker
    $waitCalls = 0
    $started = Get-Date
    $handle = Enter-AshAtlasRuntimeLifecycleMutex $delayedRuntime 5 50 { $script:waitCalls++ }
    $elapsed = ((Get-Date) - $started).TotalMilliseconds
    Assert-True ($elapsed -ge 700) 'launch waits for delayed mutex release instead of failing immediately'
    Assert-True ($script:waitCalls -gt 0) 'bounded mutex wait invokes exact-runtime shutdown polling'
    Assert-True (-not $handle.abandoned) 'normal delayed release is not reported abandoned'
    Exit-AshAtlasRuntimeLifecycleMutex $handle
    $delayed.WaitForExit()

    $stuckRuntime = 'test-stuck-' + [guid]::NewGuid().ToString('n')
    $stuckMarker = Join-Path $tempRoot 'stuck.marker'
    $stuck = Start-MutexHolder $stuckRuntime 10000 $stuckMarker
    Wait-Marker $stuckMarker
    Assert-Throws { Enter-AshAtlasRuntimeLifecycleMutex $stuckRuntime 1 50 | Out-Null } 'Timed out after 1 seconds.*finish shutdown' 'stuck supervisor has a bounded actionable timeout'
    Stop-Process -Id $stuck.Id -Force -ErrorAction SilentlyContinue
    $stuck.WaitForExit()

    $abandonedRuntime = 'test-abandoned-' + [guid]::NewGuid().ToString('n')
    $abandonedMarker = Join-Path $tempRoot 'abandoned.marker'
    $abandoned = Start-MutexHolder $abandonedRuntime 10000 $abandonedMarker
    Wait-Marker $abandonedMarker
    $killerCode = "Start-Sleep -Milliseconds 250; Stop-Process -Id $($abandoned.Id) -Force"
    $killerEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($killerCode))
    $killer = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList @('-NoProfile', '-EncodedCommand', $killerEncoded) -WindowStyle Hidden -PassThru
    $abandonedHandle = Enter-AshAtlasRuntimeLifecycleMutex $abandonedRuntime 2 50
    Assert-True $abandonedHandle.abandoned 'abandoned runtime mutex is recovered safely'
    Exit-AshAtlasRuntimeLifecycleMutex $abandonedHandle
    $killer.WaitForExit()
    $abandoned.WaitForExit()

    $runtimeA = 'test-concurrent-a-' + [guid]::NewGuid().ToString('n')
    $runtimeB = 'test-concurrent-b-' + [guid]::NewGuid().ToString('n')
    $handleA = Enter-AshAtlasRuntimeLifecycleMutex $runtimeA 2 50
    $handleB = Enter-AshAtlasRuntimeLifecycleMutex $runtimeB 2 50
    Assert-True ($handleA.name -ne $handleB.name) 'different feature runtimes keep independent lifecycle mutexes'
    Exit-AshAtlasRuntimeLifecycleMutex $handleB
    Exit-AshAtlasRuntimeLifecycleMutex $handleA

    $rapidRuntime = 'test-rapid-' + [guid]::NewGuid().ToString('n')
    $rapidOutput = Join-Path $tempRoot 'rapid.txt'
    $escapedLibrary = $libraryPath.Replace("'", "''")
    $escapedOutput = $rapidOutput.Replace("'", "''")
    $children = @()
    foreach ($index in 1..3) {
        $code = @"
`$ErrorActionPreference = 'Stop'
. '$escapedLibrary'
`$handle = Enter-AshAtlasRuntimeLifecycleMutex '$rapidRuntime' 10 25
try {
    Add-Content -LiteralPath '$escapedOutput' -Value '$index'
    Start-Sleep -Milliseconds 150
} finally { Exit-AshAtlasRuntimeLifecycleMutex `$handle }
"@
        $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($code))
        $children += Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList @('-NoProfile', '-EncodedCommand', $encoded) -WindowStyle Hidden -PassThru
    }
    foreach ($child in $children) { $child.WaitForExit(); Assert-Equal $child.ExitCode 0 'rapid launcher contender exits successfully' }
    Assert-Equal @(Get-Content -LiteralPath $rapidOutput).Count 3 'three rapid contenders serialize through one runtime lifecycle lock'

    $runtimeScript = Get-Content -Raw -LiteralPath (Join-Path $root 'tools\dev\run-main.ps1')
    & {
        . ([scriptblock]::Create([regex]::Match($runtimeScript, '(?ms)^function Remove-SelectedFeatureRuntime \{.*?(?=^function |\z)').Value))
        . ([scriptblock]::Create([regex]::Match($runtimeScript, '(?ms)^function Assert-ExactPath \{.*?(?=^function |\z)').Value))
        $fixtureRoot = Join-Path $tempRoot 'merged-retirement'
        $leasePath = Join-Path $fixtureRoot 'leases.json'
        $runtime = $generationIdentity | ConvertTo-Json -Depth 20 | ConvertFrom-Json
        $runtimeRoot = Join-Path $fixtureRoot ("runtimes\" + $runtime.runtime_id)
        $Config = [pscustomobject]@{ feature_launcher_root = $fixtureRoot }
        $AcceptedIntegrationCleanup = $true
        $script:retirementStops = 0
        $script:retirementMutation = ''
        function Get-AshAtlasLeasePath { $leasePath }
        function Get-RuntimeStatePaths { param($Runtime) [pscustomobject]@{ root = $runtimeRoot } }
        function Test-AshAtlasSafeFeatureRuntime { param($Config, $Runtime) $true }
        function Get-DockerInspection { param($Kind, $Name, [switch]$AllowMissing) $null }
        function Reset-RetirementFixture {
            New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
            Set-Content -LiteralPath (Join-Path $runtimeRoot 'cleanup-in-progress') -Value 'accepted'
            $selected = $runtime | ConvertTo-Json -Depth 20 | ConvertFrom-Json
            Add-Member -InputObject $selected -NotePropertyName integration_status -NotePropertyValue 'merged_to_test' -Force
            Add-Member -InputObject $selected -NotePropertyName port_claim -NotePropertyValue ([pscustomobject]@{ pid = 123; start_time_utc = '2026-01-01T00:00:00Z' }) -Force
            Write-AshAtlasLeaseStore ([pscustomobject]@{ schema_version = 2; runtimes = @($selected, [pscustomobject]@{ runtime_id = 'other'; display_name = 'before' }) }) $leasePath
        }
        function Stop-SelectedRuntime {
            param($Runtime)
            $script:retirementStops++
            # A separate supervisor must acquire the real lease mutex to finish.
            $workerCode = @"
`$ErrorActionPreference = 'Stop'
. '$($libraryPath.Replace("'", "''"))'
`$mutex = Enter-AshAtlasLeaseStoreMutex
try {
    `$store = Read-AshAtlasLeaseStore '$($leasePath.Replace("'", "''"))'
    `$store.runtimes[0].PSObject.Properties.Remove('port_claim')
    `$store.runtimes[1].display_name = 'updated during shutdown'
    if ('$script:retirementMutation' -eq 'identity') { `$store.runtimes[0].branch = 'fix/replaced-runtime' }
    if ('$script:retirementMutation' -eq 'status') { `$store.runtimes[0].integration_status = 'active' }
    Write-AshAtlasLeaseStore `$store '$($leasePath.Replace("'", "''"))'
} finally { Exit-AshAtlasLeaseStoreMutex `$mutex }
"@
            $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($workerCode))
            $worker = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList @('-NoProfile', '-EncodedCommand', $encoded) -WindowStyle Hidden -PassThru
            try {
                if (-not $worker.WaitForExit(5000)) { throw 'Supervisor could not acquire lease mutex during merged retirement.' }
                $worker.Refresh()
                Assert-Equal $worker.ExitCode 0 'merged supervisor releases its lease claim successfully'
            } finally {
                if (-not $worker.HasExited) { $worker.Kill(); $worker.WaitForExit() }
                $worker.Dispose()
            }
        }
        Reset-RetirementFixture
        Remove-SelectedFeatureRuntime $runtime
        $remaining = @( (Read-AshAtlasLeaseStore $leasePath).runtimes )
        Assert-Equal $remaining.Count 1 'merged retirement removes only the selected lease'
        Assert-Equal $remaining[0].display_name 'updated during shutdown' 'retirement preserves another lease update made during shutdown'

        foreach ($mutation in @('identity', 'status')) {
            Reset-RetirementFixture
            $script:retirementMutation = $mutation
            Assert-Throws { Remove-SelectedFeatureRuntime $runtime } 'REFUSED:.*(identity differs|changed during shutdown)' "retirement refuses selected $mutation drift"
            Assert-Equal @((Read-AshAtlasLeaseStore $leasePath).runtimes).Count 2 'refused retirement preserves both leases'
            Assert-True (Test-Path -LiteralPath $runtimeRoot) 'refused retirement preserves runtime state'
        }
        $script:retirementMutation = ''
        Reset-RetirementFixture
        $AcceptedIntegrationCleanup = $false
        $stopsBefore = $script:retirementStops
        Assert-Throws { Remove-SelectedFeatureRuntime $runtime } 'ownership-verified integration cleanup marker' 'merged removal requires explicit accepted cleanup authorization'
        Assert-Equal $script:retirementStops $stopsBefore 'unauthorized merged removal never stops the runtime'
        $AcceptedIntegrationCleanup = $true
        Remove-Item -LiteralPath (Join-Path $runtimeRoot 'cleanup-in-progress')
        Assert-Throws { Remove-SelectedFeatureRuntime $runtime } 'ownership-verified integration cleanup marker' 'merged removal requires its cleanup marker'
        Assert-Equal $script:retirementStops $stopsBefore 'missing cleanup marker never stops the runtime'
    }
    & {
        foreach ($name in @('Read-RuntimeSupervisorState', 'Get-RuntimeSupervisorStatus', 'Request-ExactRuntimeStop', 'Test-RuntimeQuiescent', 'Complete-RuntimeQuiescence')) {
            . ([scriptblock]::Create([regex]::Match($runtimeScript, "(?ms)^function $name \{.*?(?=^function |\z)").Value))
        }
        # Isolate only port/container/child discovery; supervisor identity and bounded waiting are real.
        function Get-NetTCPConnection { param($LocalPort, $State, $ErrorAction) }
        function Stop-OwnedRuntimeContainer { param($Runtime) }
        $fixtureRoot = Join-Path $tempRoot 'supervisor-exit-gap'
        New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
        $paths = [pscustomobject]@{
            root = $fixtureRoot
            supervisor = Join-Path $fixtureRoot 'supervisor.json'
            processes = Join-Path $fixtureRoot 'owned-processes.json'
            ready_signal = Join-Path $fixtureRoot 'ready'
            stop_signal = Join-Path $fixtureRoot 'stop-requested'
        }
        $fixtureScript = Join-Path $fixtureRoot 'supervisor.ps1'
        $logPath = Join-Path $fixtureRoot 'ready-bootstrap-fixture.err.log'
        $removedPath = Join-Path $fixtureRoot 'state-removed'
        $releasePath = Join-Path $fixtureRoot 'release'
        @'
param([string]$Worktree)
$ErrorActionPreference = 'Stop'
$log = [IO.File]::Open((Join-Path $Worktree 'ready-bootstrap-fixture.err.log'), 'Create', 'Write', 'None')
try {
    while (-not (Test-Path -LiteralPath (Join-Path $Worktree 'stop-requested'))) { Start-Sleep -Milliseconds 10 }
    Remove-Item -LiteralPath (Join-Path $Worktree 'supervisor.json')
    [IO.File]::WriteAllText((Join-Path $Worktree 'state-removed'), 'removed')
    while (-not (Test-Path -LiteralPath (Join-Path $Worktree 'release'))) { Start-Sleep -Milliseconds 10 }
    Start-Sleep -Milliseconds 250
} finally { $log.Dispose() }
'@ | Set-Content -LiteralPath $fixtureScript -Encoding utf8
        $fixture = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList @('-NoProfile', '-File', ('"' + $fixtureScript + '"'), '-Worktree', ('"' + $fixtureRoot + '"')) -WindowStyle Hidden -PassThru
        try {
            $runtime = [pscustomobject]@{ runtime_id = 'test-supervisor-exit-gap'; worktree = $fixtureRoot; branch = 'test'; mode = 'Main'; ports = @{ frontend = 1; backend = 2; postgres = 3 } }
            $record = [pscustomobject]@{ schema_version = 2; runtime_id = $runtime.runtime_id; worktree = $fixtureRoot; branch = 'test'; ports = $runtime.ports; pid = $fixture.Id; start_time_utc = $fixture.StartTime.ToUniversalTime().ToString('o'); supervisor_script = $fixtureScript }
            $record | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $paths.supervisor -Encoding utf8
            $captured = Get-RuntimeSupervisorStatus $runtime $paths
            Assert-Equal $captured.status 'match' 'fixture supervisor exact runtime command and process identity are verified'
            function Stop-RecordedProcesses {
                param($Runtime, $Paths)
                Wait-Marker $removedPath
                Assert-True (-not (Test-Path -LiteralPath $Paths.supervisor)) 'fixture removes supervisor state before process exit'
                Assert-True (Test-RuntimeQuiescent $Runtime $Paths) 'without captured identity absent state reproduces premature quiescence'
                Assert-True (-not (Test-RuntimeQuiescent $Runtime $Paths $captured.state)) 'live captured supervisor prevents quiescence after state removal'
                Assert-Throws { $stream = [IO.File]::Open($logPath, 'Open', 'Write', 'None'); $stream.Dispose() } 'being used by another process' 'supervisor still holds bootstrap log after state removal'
                $wrong = $record.PSObject.Copy()
                $wrong.start_time_utc = $fixture.StartTime.ToUniversalTime().AddMinutes(-1).ToString('o')
                Assert-Throws { Test-RuntimeQuiescent $Runtime $Paths $wrong } 'PID .+ reused' 'captured PID reuse remains refused'
                $wrong = $record.PSObject.Copy()
                $wrong.runtime_id = 'unrelated'
                Assert-Throws { Test-RuntimeQuiescent $Runtime $Paths $wrong } 'another runtime' 'captured foreign runtime remains refused'
                $wrong = $record.PSObject.Copy()
                $wrong.worktree = Join-Path $fixtureRoot 'unrelated'
                Assert-Throws { Test-RuntimeQuiescent $Runtime $Paths $wrong } 'another runtime' 'captured foreign worktree remains refused'
                [IO.File]::WriteAllText($releasePath, 'release')
            }
            $RuntimeShutdownWaitSeconds = 5
            $RuntimePollMilliseconds = 25
            Complete-RuntimeQuiescence $runtime $paths
            $fixture.Refresh()
            Assert-True $fixture.HasExited 'complete quiescence waits for actual supervisor process exit'
            Assert-True (Test-RuntimeQuiescent $runtime $paths $captured.state) 'exited captured supervisor permits quiescence'
            Remove-Item -LiteralPath $logPath -ErrorAction Stop
            Assert-True (-not (Test-Path -LiteralPath $logPath)) 'bootstrap log can be deleted immediately after quiescence'
        } finally {
            [IO.File]::WriteAllText($releasePath, 'release')
            $fixture.Refresh()
            if (-not $fixture.HasExited) { Stop-Process -InputObject $fixture -Force; $fixture.WaitForExit() }
            $fixture.Dispose()
        }
    }
    $featureRuntimeScript = Get-Content -Raw -LiteralPath (Join-Path $root 'tools\dev\feature-runtime.ps1')
    $liveRecordedSource = [regex]::Match($runtimeScript, '(?ms)^function Test-LiveRecordedRuntimeProcesses \{.*?(?=^function |\z)').Value
    $supervisorStatusSource = [regex]::Match($runtimeScript, '(?ms)^function Get-RuntimeSupervisorStatus \{.*?(?=^function |\z)').Value
    $supervisorCleanupSource = [regex]::Match($runtimeScript, '(?ms)^function Remove-CurrentRuntimeSupervisorState \{.*?(?=^function |\z)').Value
    $stopRecordedSource = [regex]::Match($runtimeScript, '(?ms)^function Stop-RecordedProcesses \{.*?(?=^function |\z)').Value
    $liveOwnedSource = [regex]::Match($featureRuntimeScript, '(?ms)^function Get-LiveOwnedProcessRecords\([^\r\n]*\) \{.*?(?=^function |\z)').Value
    Assert-True ($liveOwnedSource -match 'Get-AshAtlasRecordedProcessStatus \$record' -and $liveOwnedSource -notmatch 'StartTime\.ToUniversalTime') 'feature runtime live-record detection preserves JSON DateTime identity centrally'
    Assert-True ($liveRecordedSource -match 'Get-AshAtlasRecordedProcessStatus \$record' -and $liveRecordedSource -notmatch 'StartTime\.ToUniversalTime') 'run-main live-record detection preserves JSON DateTime identity centrally'
    Assert-True ($supervisorStatusSource.Contains('$powerShellHost = ([string]$native.Name).ToLowerInvariant()') -and
        $supervisorStatusSource.Contains('$powerShellHost -notin @(''powershell.exe'', ''pwsh.exe'')') -and
        $supervisorStatusSource -notmatch '\*\.exe') 'supervisor verification accepts exactly Windows PowerShell and PowerShell 7 hosts'
    Assert-True ($supervisorCleanupSource -match 'Assert-AshAtlasRecordedProcessIdentity \$state' -and $supervisorCleanupSource -notmatch 'StartTime\.ToUniversalTime') 'current supervisor cleanup preserves JSON DateTime identity centrally'
    Assert-True ($stopRecordedSource -match 'Assert-AshAtlasRecordedProcessIdentity \$record' -and $stopRecordedSource -notmatch 'StartTime\.ToUniversalTime') 'recorded process shutdown refuses stale PID identity centrally before stopping'
    Assert-True ($runtimeScript -match 'Runtime is already healthy; reusing it\.') 'healthy exact runtime has a clear reuse result'
    Assert-True ($runtimeScript -match 'Test-LiveRecordedRuntimeSupervisor' -and $runtimeScript -match 'PreserveExistingPorts -or \$hasLiveExactRuntime') 'starting exact runtime preserves its stable leased ports'
    Assert-True ($runtimeScript -notmatch '@\(Get-Content[^\r\n]+ConvertFrom-Json\)' -and $runtimeScript -match 'Read-AshAtlasJsonArray') 'PowerShell 5.1 expands recorded process JSON arrays correctly'
    Assert-True ($runtimeScript -match 'Invoke-HealthyRuntimeReuse[\s\S]+Open-AshAtlasRuntimeFrontend') 'healthy reuse opens the canonical frontend URL'
    Assert-True ($runtimeScript -match 'supervisor\.json' -and $runtimeScript -match 'start_time_utc') 'supervisor identity persists PID start time'
    Assert-True ($runtimeScript -match '\$null -eq \$native -or -not \[string\]\$native\.CommandLine' -and $runtimeScript -match "status = 'match'") 'terminating exact supervisor with transient blank CIM command waits for process exit'
    Assert-True ($runtimeScript -match "'powershell\.exe', 'pwsh\.exe'" -and $runtimeScript -match '\$native\.CommandLine -notmatch \$escapedScript' -and
        $runtimeScript -match '\$native\.CommandLine -notmatch \$escapedWorktree') 'supervisor identity accepts Windows PowerShell and PowerShell 7 while preserving exact command checks'
    Assert-True ($runtimeScript -match 'Write-RuntimeSupervisorState.+starting' -and $runtimeScript -match 'Write-RuntimeSupervisorState.+healthy' -and $runtimeScript -match 'Write-RuntimeSupervisorState.+stopping') 'supervisor lifecycle phases are explicit'
    Assert-True ($runtimeScript -match 'Complete-RuntimeQuiescence' -and $runtimeScript -match 'Wait-AshAtlasBoundedCondition') 'shutdown waits for exact-runtime quiescence'
    $startupIndex = $runtimeScript.IndexOf('function Start-SelectedRuntime')
    $quiescenceIndex = $runtimeScript.IndexOf('Complete-RuntimeQuiescence $Runtime $paths', $startupIndex)
    $claimRefreshIndex = $runtimeScript.IndexOf('$Runtime = (Resolve-FeaturePortsAndLease $Runtime -Persist -PreserveExistingPorts).runtime', $quiescenceIndex)
    $supervisorStateIndex = $runtimeScript.IndexOf("Write-RuntimeSupervisorState `$Runtime `$paths `$gameSha 'starting'", $quiescenceIndex)
    $parallelPrerequisitesIndex = $runtimeScript.IndexOf('Invoke-ParallelRuntimePrerequisites $Runtime $paths', $quiescenceIndex)
    Assert-True ($runtimeScript -match "if \(\`$Runtime\.mode -eq 'Feature'\) \{\s+\`$Runtime = \(Resolve-FeaturePortsAndLease \`$Runtime -Persist -PreserveExistingPorts\)\.runtime\s+\}" -and
        $quiescenceIndex -lt $claimRefreshIndex -and $claimRefreshIndex -lt $supervisorStateIndex -and $supervisorStateIndex -lt $parallelPrerequisitesIndex) 'feature restart refreshes the current supervisor port claim after quiescence and before supervisor state or parallel prerequisites'
    Assert-True ($runtimeScript -match 'waiting for exact runtime.+frontend/backend processes to exit' -and $runtimeScript -match 'Assert-AshAtlasRecordedProcessIdentity') 'owned process exit is proven before process state is removed'
    Assert-True ($runtimeScript -match 'Stop-RecordedProcesses[\s\S]+Remove-AshAtlasExpectedRuntimeStateFile \$Paths\.root \$Paths\.processes') 'owned process cleanup uses idempotent expected-state removal after identity checks'
    Assert-True ($runtimeScript -match 'foreach \(\$path in @\(\$Paths\.processes, \$Paths\.ready_signal, \$Paths\.stop_signal, \$Paths\.supervisor\)\)[\s\S]+Remove-AshAtlasExpectedRuntimeStateFile \$Paths\.root \$path') 'quiescence removes every expected runtime marker idempotently'
    Assert-True ($runtimeScript -match 'Remove-CurrentRuntimeSupervisorState[\s\S]+Remove-AshAtlasExpectedRuntimeStateFile \$Paths\.root \$Paths\.supervisor') 'supervisor state removal remains behind exact current-process verification'
    Assert-True ($runtimeScript -match 'Remove-AshAtlasExpectedRuntimeStateFile \$paths\.root \$paths\.ready_signal' -and
        $runtimeScript -match 'Remove-AshAtlasExpectedRuntimeStateFile \$paths\.root \$paths\.stop_signal') 'supervisor finally cleanup uses idempotent marker removal'
    $runtimeLibrary = Get-Content -Raw -LiteralPath $libraryPath
    Assert-True ($runtimeLibrary -match 'catch \[System\.Management\.Automation\.ItemNotFoundException\]' -and
        $runtimeLibrary -match 'Microsoft\.PowerShell\.Management\\Remove-Item.+-ErrorAction Stop') 'state removal catches only the already-absent race and keeps real deletion errors terminating'
    Assert-True ($runtimeScript -notmatch '\.WaitOne\(0\).*already active') 'launcher no longer fails immediately with already active'
    Assert-True ($runtimeScript -notmatch 'Read-Host') 'supervisor never blocks away from the stop marker in Read-Host'
    Assert-True ($runtimeScript.Contains("env:CI = 'true'") -and $runtimeScript.Contains('vite\bin\vite.js')) 'launcher-owned Vite is explicitly noninteractive'
    Assert-True ($runtimeScript -match 'Test-ExactRuntimePortOwners' -and $runtimeScript -match 'outside exact worktree') 'unrelated port owners are refused, never killed'
    Assert-True ($runtimeScript -match 'Assert-AshAtlasRecordedProcessIdentity') 'owned process and supervisor PID reuse checks are centralized'
    Assert-True ($runtimeScript -match 'Stop-OwnedRuntimeContainer' -and $runtimeScript -notmatch 'compose\s+down\s+-v') 'feature shutdown preserves disposable volumes'
    Assert-True ($runtimeScript -match 'Ensure-AshAtlasFeatureWorldRuntime' -and $runtimeScript -match 'Ensure-MainWorldRuntime') 'feature groups and protected Main World API have separate lifecycle paths'
    Assert-True ($runtimeScript -match 'Remove-CurrentRuntimeSupervisorState' -and $runtimeScript -match '\$paths\.ready_signal' -and $runtimeScript -match '\$paths\.stop_signal') 'failed startup cleanup settles supervisor and marker state'
    $acceptedCleanupIndex = $runtimeScript.IndexOf('if ($AcceptedIntegrationCleanup)')
    $worldPolicyIndex = $runtimeScript.IndexOf('Set-WorldRuntimePolicy $runtime')
    $featureLeaseResolutionIndex = $runtimeScript.IndexOf('Resolve-FeaturePortsAndLease $runtime')
    Assert-True ($runtimeScript -match 'function Resolve-AcceptedIntegrationCleanupRuntime' -and
        $runtimeScript -match 'accepted Integration Test cleanup requires exactly one persisted feature lease' -and
        $runtimeScript -match 'accepted cleanup lease World descriptor port differs' -and
        $acceptedCleanupIndex -ge 0 -and $acceptedCleanupIndex -lt $worldPolicyIndex -and
        $acceptedCleanupIndex -lt $featureLeaseResolutionIndex) 'accepted cleanup has a separate persisted-lease path before current World lock parsing and feature lease resolution'

    & {
        . ([scriptblock]::Create([regex]::Match($runtimeScript, '(?ms)^function Resolve-AcceptedIntegrationCleanupRuntime \{.*?(?=^function |\z)').Value))
        $fixtureRoot = Join-Path $tempRoot 'historical-world-retire'
        $leasePath = Join-Path $fixtureRoot 'leases.json'
        $Config = [pscustomobject]@{}
        function Get-AshAtlasLeasePath { $leasePath }
        $runtime = [pscustomobject][ordered]@{
            runtime_id = 'historical-world-retire-t1117-abcd123456'
            mode = 'Feature'
            worktree = 'C:\Users\dev\Documents\worktrees\ios-hud-edge-flow__t1117'
            branch = 'fix/ios-hud-edge-flow--from-t1117'
            database = 'ash_atlas_stability_ios_hud_edge_flow_t1117_abcd123456'
            compose_project = 'ash-atlas-feature-abcd123456'
            postgres_container = 'ash-atlas-feature-postgres-abcd123456'
            network = 'ash-atlas-feature-net-abcd123456'
            volume = 'ash-atlas-feature-pg-abcd123456'
            base_test_generation = 't1117'
            base_test_sha = ('a' * 40)
            ports = $null
        }
        $ports = [pscustomobject][ordered]@{ frontend = 41010; backend = 41011; postgres = 41012; world_api = 41910 }
        # Deliberately omit the modern World identity payload: the historical lease is
        # valid for retirement because cleanup only needs its persisted group and port.
        $world = [pscustomobject][ordered]@{ group_id = 'world-0123456789abcdef'; canonical_identity = 'historical-world-identity'; port = 41910 }
        function Write-RetirementLease([object[]]$Leases) {
            New-Item -ItemType Directory -Path $fixtureRoot -Force | Out-Null
            [pscustomobject]@{ schema_version = 2; runtimes = @($Leases) } | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $leasePath -Encoding utf8
        }
        function New-RetirementLease {
            $lease = $runtime | ConvertTo-Json -Depth 20 | ConvertFrom-Json
            $lease.ports = $ports
            Add-Member -InputObject $lease -NotePropertyName world_runtime -NotePropertyValue $world -Force
            Add-Member -InputObject $lease -NotePropertyName integration_status -NotePropertyValue 'merged_to_test' -Force
            return $lease
        }

        $lease = New-RetirementLease
        Write-RetirementLease @($lease)
        $resolved = Resolve-AcceptedIntegrationCleanupRuntime ($runtime | ConvertTo-Json -Depth 20 | ConvertFrom-Json)
        Assert-Equal $resolved.ports.world_api 41910 'accepted cleanup hydrates persisted World API port without reading the historical lock'
        Assert-Equal $resolved.world_runtime.group_id 'world-0123456789abcdef' 'accepted cleanup hydrates the exact persisted World group descriptor'

        Write-RetirementLease @()
        Assert-Throws { Resolve-AcceptedIntegrationCleanupRuntime ($runtime | ConvertTo-Json -Depth 20 | ConvertFrom-Json) } 'exactly one persisted feature lease' 'accepted cleanup refuses a missing lease'
        Write-RetirementLease @($lease, (New-RetirementLease))
        Assert-Throws { Resolve-AcceptedIntegrationCleanupRuntime ($runtime | ConvertTo-Json -Depth 20 | ConvertFrom-Json) } 'multiple leases' 'accepted cleanup refuses duplicate leases'

        $mismatched = New-RetirementLease
        $mismatched.branch = 'fix/replaced-runtime--from-t1117'
        Write-RetirementLease @($mismatched)
        Assert-Throws { Resolve-AcceptedIntegrationCleanupRuntime ($runtime | ConvertTo-Json -Depth 20 | ConvertFrom-Json) } 'identity differs at branch' 'accepted cleanup refuses a mismatched lease identity'

        $badWorldPort = New-RetirementLease
        $badWorldPort.world_runtime.port = 41911
        Write-RetirementLease @($badWorldPort)
        Assert-Throws { Resolve-AcceptedIntegrationCleanupRuntime ($runtime | ConvertTo-Json -Depth 20 | ConvertFrom-Json) } 'World descriptor port differs' 'accepted cleanup refuses a mismatched persisted World descriptor'
    }
} finally {
    if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}

Write-Host "feature-launcher-lifecycle.tests.ps1: $script:Passed assertions passed." -ForegroundColor Green
