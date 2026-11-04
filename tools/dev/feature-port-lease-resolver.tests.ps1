$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
. (Join-Path $PSScriptRoot 'runtime-lib.ps1')
$Config = Read-AshAtlasRuntimeDefaults (Join-Path $root 'config\dev-runtime.defaults.json')
$SupervisorRoot = $root
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

function Get-ArrayTypeName($Value) {
    if ($null -eq $Value) { return '<null>' }
    return $Value.GetType().FullName
}

$realSelectFeaturePorts = ${function:Select-AshAtlasFeaturePorts}
$realReadLeaseStore = ${function:Read-AshAtlasLeaseStore}
$tokens = $null
$parseErrors = $null
$runMainAst = [Management.Automation.Language.Parser]::ParseFile(
    (Join-Path $PSScriptRoot 'run-main.ps1'),
    [ref]$tokens,
    [ref]$parseErrors
)
Assert-Equal $parseErrors.Count 0 'run-main parses before resolver extraction'
$resolverAst = $runMainAst.Find({
    param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq 'Resolve-FeaturePortsAndLease'
}, $true)
Assert-True ($null -ne $resolverAst) 'resolver function is discoverable through the PowerShell AST'
Invoke-Expression $resolverAst.Extent.Text

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("ash-atlas-port-lease-tests-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

function New-TestRuntime([string]$RuntimeId, [int]$BasePort = 41000) {
    return [pscustomobject]@{
        mode = 'Feature'
        runtime_id = $RuntimeId
        worktree = Join-Path $tempRoot $RuntimeId
        branch = "fix/$RuntimeId"
        ports = [pscustomobject]@{ frontend = $BasePort; backend = $BasePort + 1; postgres = $BasePort + 2; world_api = 41900 }
        database = "ash_atlas_stability_$($RuntimeId.Replace('-', '_'))"
        compose_project = "ash-atlas-$RuntimeId"
        postgres_container = "ash-atlas-postgres-$RuntimeId"
        network = "ash-atlas-net-$RuntimeId"
        volume = "ash-atlas-pg-$RuntimeId"
    }
}

function New-TestLease([string]$RuntimeId, [int]$BasePort = 41000, [string]$Worktree = '') {
    $runtime = New-TestRuntime $RuntimeId $BasePort
    if ($Worktree) { $runtime.worktree = $Worktree }
    Add-Member -InputObject $runtime -NotePropertyName display_name -NotePropertyValue $RuntimeId
    Add-Member -InputObject $runtime -NotePropertyName launcher_path -NotePropertyValue (Join-Path $tempRoot "$RuntimeId.cmd")
    Add-Member -InputObject $runtime -NotePropertyName world_runtime -NotePropertyValue ([pscustomobject]@{ group_id = "world-$RuntimeId"; port = 41900 })
    return $runtime
}

function Reset-ResolverFixture {
    $script:store = [pscustomobject]@{ schema_version = 2; runtimes = @() }
    $script:activeRuntimeIds = @()
    $script:existingWorktrees = @()
    $script:dockerMappings = @()
    $script:excludedRanges = @()
    $script:listeningPorts = @()
    $script:liveRuntimeId = ''
    $script:selectionThrows = $false
    $script:leaseWrites = 0
    $script:storeWrites = 0
    $script:staleRemoved = 0
    $script:selectCalls = 0
    $script:observed = [ordered]@{}
}

function Enter-AshAtlasLeaseStoreMutex { return [pscustomobject]@{ owned = $true } }
function Exit-AshAtlasLeaseStoreMutex { param($Mutex) }
function Get-AshAtlasLeasePath { return (Join-Path $tempRoot 'resolver-leases.json') }
function Read-AshAtlasLeaseStore { param($Path) return $script:store }
function Get-ActiveAshAtlasRuntimeIds { return ,@($script:activeRuntimeIds) }
function Get-ExistingLeaseWorktrees {
    param([object[]]$Leases)
    $script:observed.existingLeaseInputType = Get-ArrayTypeName $Leases
    $script:observed.existingLeaseInputCount = @($Leases).Count
    return ,@($script:existingWorktrees)
}
function Test-LiveRecordedRuntimeSupervisor { param($Lease) return [string]$Lease.runtime_id -eq $script:liveRuntimeId }
function Test-LiveRecordedRuntimeProcesses { param($Lease) return $false }
function Get-AshAtlasDockerPortMappings {
    param([switch]$RequireAvailable)
    foreach ($mapping in @($script:dockerMappings)) { $mapping }
}
function Get-AshAtlasExcludedTcpRanges { foreach ($range in @($script:excludedRanges)) { $range } }
function Get-AshAtlasListeningPorts { foreach ($port in @($script:listeningPorts)) { $port } }
function Select-AshAtlasFeaturePorts {
    param($Config, [string]$RuntimeId, $ExcludedRanges, $ListeningPorts, $DockerMappings, $Leases, $ExistingPorts)
    $script:selectCalls++
    $script:observed.selectDockerType = Get-ArrayTypeName $DockerMappings
    $script:observed.selectDockerCount = @($DockerMappings).Count
    $script:observed.selectLeaseType = Get-ArrayTypeName $Leases
    $script:observed.selectLeaseCount = @($Leases).Count
    if ($script:selectionThrows) { throw 'No safe Ash Atlas feature ports remain in test pool.' }
    return [pscustomobject]@{ frontend = 41800; backend = 41801; postgres = 41802; world_api = 0 }
}
function Resolve-AshAtlasFeatureWorldRegistration {
    param($Config, $Runtime, $Store, [switch]$Persist, $PreviousWorldRuntime, $ExcludedRanges, $ListeningPorts, $DockerMappings, $RegisteredRuntimeIds, $ActiveRuntimeIds)
    $script:observed.worldDockerType = Get-ArrayTypeName $DockerMappings
    $script:observed.worldDockerCount = @($DockerMappings).Count
    $script:observed.registeredType = Get-ArrayTypeName $RegisteredRuntimeIds
    $script:observed.registeredCount = @($RegisteredRuntimeIds).Count
    $script:observed.activeType = Get-ArrayTypeName $ActiveRuntimeIds
    $script:observed.activeCount = @($ActiveRuntimeIds).Count
    return $Runtime
}
function Remove-AshAtlasStaleLeasesFromStore {
    param($Store, [object[]]$StaleLeases)
    $script:staleRemoved += @($StaleLeases).Count
    $ids = @($StaleLeases | ForEach-Object { [string]$_.runtime_id })
    $Store.runtimes = @($Store.runtimes | Where-Object { $ids -notcontains [string]$_.runtime_id })
    return $Store
}
function New-AshAtlasFeatureLauncherContent { param($Config, $Runtime, $DisplayName, $SupervisorRoot) return '@echo off' }
function Test-AshAtlasGeneratedLauncher { param($Path, $RuntimeId, $LauncherRoot) return $true }
function Set-AshAtlasLease { param($Store, $Runtime) $script:leaseWrites++; return $Store }
function Write-AshAtlasLeaseStore { param($Store, $Path) $script:storeWrites++ }

try {
    foreach ($case in @(
        [pscustomobject]@{ name = 'empty registry'; leases = @(); worktrees = @() },
        [pscustomobject]@{ name = 'one runtime'; leases = @((New-TestLease 'one-runtime')); worktrees = @((Join-Path $tempRoot 'one-runtime')) },
        [pscustomobject]@{ name = 'many runtimes'; leases = @(1..40 | ForEach-Object { New-TestLease "many-$_" (41000 + ($_ * 3)) }); worktrees = @(1..40 | ForEach-Object { Join-Path $tempRoot "many-$_" }) }
    )) {
        Reset-ResolverFixture
        $script:store.runtimes = @($case.leases)
        $script:existingWorktrees = @($case.worktrees)
        Resolve-FeaturePortsAndLease (New-TestRuntime 'target-runtime') | Out-Null
        Assert-Equal $script:observed.existingLeaseInputType 'System.Object[]' "$($case.name) lease input stays an array"
        Assert-Equal $script:observed.existingLeaseInputCount @($case.leases).Count "$($case.name) lease count is preserved"
        Assert-Equal $script:observed.selectLeaseType 'System.Object[]' "$($case.name) selection receives an array"
    }

    Reset-ResolverFixture
    $target = New-TestLease 'target-runtime'
    $stale = New-TestLease 'stale-runtime' 41030 'C:\missing-stale-runtime'
    $script:store.runtimes = @($target, $stale)
    $script:existingWorktrees = @($target.worktree)
    Resolve-FeaturePortsAndLease (New-TestRuntime 'target-runtime') -Persist | Out-Null
    Assert-Equal $script:staleRemoved 1 'one stale runtime is removed through the existing policy'
    Assert-Equal @($script:store.runtimes).Count 1 'lease array is refreshed after stale removal'
    Assert-Equal $script:observed.registeredCount 1 'stale lease is absent from World registration input'

    Reset-ResolverFixture
    $target = New-TestLease 'target-runtime'
    $stale = New-TestLease 'stale-runtime' 41030 'C:\missing-stale-runtime'
    $active = New-TestLease 'active-runtime' 41060 'C:\missing-active-runtime'
    $script:store.runtimes = @($target, $stale, $active)
    $script:existingWorktrees = @($target.worktree)
    $script:activeRuntimeIds = @('active-runtime')
    Resolve-FeaturePortsAndLease (New-TestRuntime 'target-runtime') -Persist | Out-Null
    Assert-Equal $script:staleRemoved 1 'mixed stale and active runtimes remove only the stale entry'
    Assert-True (@($script:store.runtimes.runtime_id) -contains 'active-runtime') 'active runtime with a missing worktree is retained'

    foreach ($worktreeCount in @(1, 300)) {
        Reset-ResolverFixture
        $script:store.runtimes = @(1..$worktreeCount | ForEach-Object { New-TestLease "worktree-$_" (41000 + (($_ - 1) % 250) * 3) })
        $script:existingWorktrees = @($script:store.runtimes.worktree)
        Resolve-FeaturePortsAndLease (New-TestRuntime 'target-runtime') | Out-Null
        Assert-Equal $script:observed.existingLeaseInputCount $worktreeCount "$worktreeCount worktree records remain iterable"
        Assert-Equal $script:observed.selectLeaseCount 0 "$worktreeCount parked worktrees reserve no active-session ports"
    }

    $parkedLease = New-TestLease 'parked-runtime' 41700
    Assert-Equal @(Get-AshAtlasPortBlockingLeases @($parkedLease) @()).Count 0 'parked lease does not block its last assigned tuple'
    Assert-Equal @(Get-AshAtlasPortBlockingLeases @($parkedLease) @('parked-runtime')).Count 1 'active runtime ID blocks its tuple'
    Add-Member -InputObject $parkedLease -NotePropertyName port_claim -NotePropertyValue (New-AshAtlasFeaturePortClaim $parkedLease) -Force
    Assert-Equal @(Get-AshAtlasPortBlockingLeases @($parkedLease) @()).Count 1 'live launcher-process claim blocks its tuple'
    $parkedLease.port_claim.pid = 2147483000
    Assert-Equal @(Get-AshAtlasPortBlockingLeases @($parkedLease) @()).Count 0 'dead launcher-process claim is recovered as parked'

    Reset-ResolverFixture
    $script:activeRuntimeIds = $null
    $script:existingWorktrees = $null
    $script:dockerMappings = $null
    $script:excludedRanges = $null
    $script:listeningPorts = $null
    Resolve-FeaturePortsAndLease (New-TestRuntime 'target-runtime') | Out-Null
    Assert-Equal $script:observed.selectDockerType 'System.Object[]' 'null optional Docker mappings normalize to an array'
    Assert-Equal $script:observed.selectDockerCount 0 'null optional Docker mappings normalize to empty'
    Assert-Equal $script:observed.activeType 'System.Object[]' 'null active runtime IDs normalize to an array'

    $oneMapping = [pscustomobject]@{ port = 41575; container = 'one'; runtime_id = 'other'; compose_project = 'other'; running = $true }
    foreach ($shape in @(
        [pscustomobject]@{ name = 'empty'; value = @(); expected = 2 },
        [pscustomobject]@{ name = 'one PSCustomObject'; value = $oneMapping; expected = 3 },
        [pscustomobject]@{ name = 'one object array'; value = [object[]]@($oneMapping); expected = 3 },
        [pscustomobject]@{ name = 'many'; value = @($oneMapping, [pscustomobject]@{ port = 55839; container = 'two'; runtime_id = ''; compose_project = ''; running = $true }); expected = 4 }
    )) {
        Reset-ResolverFixture
        $lease = New-TestLease 'target-runtime'
        $script:store.runtimes = @($lease)
        $script:existingWorktrees = @($lease.worktree)
        $script:liveRuntimeId = 'target-runtime'
        $script:dockerMappings = $shape.value
        Resolve-FeaturePortsAndLease (New-TestRuntime 'target-runtime') | Out-Null
        Assert-Equal $script:observed.worldDockerType 'System.Object[]' "$($shape.name) live-runtime mappings remain an array"
        Assert-Equal $script:observed.worldDockerCount $shape.expected "$($shape.name) live-runtime mappings append exactly two listener records"
    }

    Reset-ResolverFixture
    $lease = New-TestLease 'target-runtime' 41620
    $script:store.runtimes = @($lease)
    $script:existingWorktrees = @($lease.worktree)
    $first = Resolve-FeaturePortsAndLease (New-TestRuntime 'target-runtime') -PreserveExistingPorts
    $second = Resolve-FeaturePortsAndLease $first.runtime -PreserveExistingPorts
    Assert-Equal $first.runtime.ports.frontend 41620 'PreserveExistingPorts retains the registered tuple'
    Assert-Equal $second.runtime.ports.frontend $first.runtime.ports.frontend 'repeated resolution of the enriched runtime is idempotent'
    Assert-Equal $script:selectCalls 0 'preserved ports bypass reselection'
    Assert-Equal $script:storeWrites 0 'Persist false never writes the registry'

    $smallConfig = Read-AshAtlasRuntimeDefaults (Join-Path $root 'config\dev-runtime.defaults.json')
    $smallConfig.feature.port_pool.start = 41890
    $smallConfig.feature.port_pool.end = 41898
    $smallConfig.feature.port_pool.ports_per_runtime = 3
    $manyAvailable = & $realSelectFeaturePorts $smallConfig 'many-available' @() @() @() @() $null
    Assert-True ($manyAvailable.frontend -ge 41890 -and $manyAvailable.postgres -le 41898) 'many available tuples return a bounded tuple'
    Assert-True (@(3000, 5270, 8765, 35432) -notcontains $manyAvailable.frontend) 'protected Main ports are never returned'
    $occupied = @(
        [pscustomobject]@{ runtime_id = 'occupied-a'; ports = [pscustomobject]@{ frontend = 41890; backend = 41891; postgres = 41892 } },
        [pscustomobject]@{ runtime_id = 'occupied-b'; ports = [pscustomobject]@{ frontend = 41893; backend = 41894; postgres = 41895 } }
    )
    $oneAvailable = & $realSelectFeaturePorts $smallConfig 'one-available' @() @() @() $occupied $null
    Assert-Equal $oneAvailable.frontend 41896 'one available tuple is selected exactly'
    $exhausted = @($occupied + [pscustomobject]@{ runtime_id = 'occupied-c'; ports = [pscustomobject]@{ frontend = 41896; backend = 41897; postgres = 41898 } })
    Assert-Throws { & $realSelectFeaturePorts $smallConfig 'exhausted' @() @() @() $exhausted $null | Out-Null } 'No safe Ash Atlas feature ports remain' 'exhausted tuples fail closed'

    $concurrentLeasePath = Join-Path $tempRoot 'concurrent-leases.json'
    $childOutputs = @(
        (Join-Path $tempRoot 'allocator-a.txt'),
        (Join-Path $tempRoot 'allocator-b.txt')
    )
    $childErrors = @(
        (Join-Path $tempRoot 'allocator-a.err.txt'),
        (Join-Path $tempRoot 'allocator-b.err.txt')
    )
    $childIds = @('allocator-a', 'allocator-c')
    $children = @()
    for ($index = 0; $index -lt 2; $index++) {
        $escapedLib = (Join-Path $PSScriptRoot 'runtime-lib.ps1').Replace("'", "''")
        $escapedLease = $concurrentLeasePath.Replace("'", "''")
        $escapedOutput = $childOutputs[$index].Replace("'", "''")
        $escapedError = $childErrors[$index].Replace("'", "''")
        $runtimeId = $childIds[$index]
        $code = @"
`$ErrorActionPreference = 'Stop'
`$env:ASH_ATLAS_RUNTIME_TEST_MODE = '1'
`$env:ASH_ATLAS_DEV_RUNTIME_LEASE_PATH = '$escapedLease'
. '$escapedLib'
`$config = Read-AshAtlasRuntimeDefaults '$($root.Replace("'", "''"))\config\dev-runtime.defaults.json'
`$config.feature.port_pool.start = 41890
`$config.feature.port_pool.end = 41895
`$config.feature.port_pool.ports_per_runtime = 3
try {
    `$handle = Enter-AshAtlasLeaseStoreMutex
    try {
        `$store = Read-AshAtlasLeaseStore
        `$runtime = [pscustomobject]@{ runtime_id = '$runtimeId'; worktree = 'C:\test\$runtimeId'; branch = 'fix/$runtimeId'; ports = `$null; database = 'ash_atlas_stability_$runtimeId'; compose_project = 'ash-atlas-$runtimeId'; postgres_container = 'ash-atlas-postgres-$runtimeId'; network = 'ash-atlas-net-$runtimeId'; volume = 'ash-atlas-pg-$runtimeId' }
        `$blocking = @(Get-AshAtlasPortBlockingLeases @(`$store.runtimes) @())
        `$runtime.ports = Select-AshAtlasFeaturePorts `$config `$runtime.runtime_id @() @() @() `$blocking `$null
        Add-Member -InputObject `$runtime -NotePropertyName port_claim -NotePropertyValue (New-AshAtlasFeaturePortClaim `$runtime)
        Set-AshAtlasLease `$store `$runtime | Out-Null
        Write-AshAtlasLeaseStore `$store
        [IO.File]::WriteAllText('$escapedOutput', [string]`$runtime.ports.frontend)
    } finally { Exit-AshAtlasLeaseStoreMutex `$handle }
    Start-Sleep -Milliseconds 500
} catch {
    [IO.File]::WriteAllText('$escapedError', (`$_ | Out-String))
    exit 1
}
"@
        $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($code))
        $children += Start-Process -FilePath (Get-Process -Id $PID).Path `
            -ArgumentList @('-NoProfile', '-EncodedCommand', $encoded) `
            -WindowStyle Hidden `
            -PassThru
    }
    for ($index = 0; $index -lt $children.Count; $index++) {
        $child = $children[$index]
        $child.WaitForExit()
        $exitCode = $child.ExitCode
        $child.Dispose()
        if ($exitCode -ne 0) {
            $detail = if (Test-Path -LiteralPath $childErrors[$index]) {
                Get-Content -Raw -LiteralPath $childErrors[$index]
            } else { 'no child error output' }
            throw "ASSERTION FAILED: simultaneous allocator child exits successfully. Exit ${exitCode}: $detail"
        }
        $script:Passed++
    }
    $allocatedPorts = @($childOutputs | ForEach-Object { [int](Get-Content -Raw -LiteralPath $_) })
    Assert-Equal @($allocatedPorts | Select-Object -Unique).Count 2 'two simultaneous allocators cannot receive the same lease'
    $concurrentStore = & $realReadLeaseStore $concurrentLeasePath
    Assert-Equal @($concurrentStore.runtimes).Count 2 'simultaneous allocations both persist under the mutex'
} finally {
    $resolvedTemp = [IO.Path]::GetFullPath($tempRoot)
    $systemTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if ($resolvedTemp.StartsWith($systemTemp, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedTemp)) {
        Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
    }
}

Write-Host "feature-port-lease-resolver.tests.ps1: $script:Passed assertions passed." -ForegroundColor Green
