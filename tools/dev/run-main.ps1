[CmdletBinding()]
param(
    [ValidateSet('Main', 'Feature')][string]$RuntimeMode = 'Main',
    [string]$WorktreePath,
    [switch]$Mobile,
    [switch]$Doctor,
    [switch]$Status,
    [switch]$RepairPostgres,
    [switch]$Stop,
    [switch]$RemoveFeature,
    [switch]$AcceptedIntegrationCleanup,
    [switch]$ValidateOnly,
    [switch]$FullWorldVerify,
    [switch]$NoBrowser,
    [ValidateSet('', 'World', 'Postgres')]
    [string]$InternalStartupWorker = '',
    [string]$InternalParentRuntimeId = '',
    [int]$InternalParentProcessId = 0,
    [string]$InternalParentProcessStartTimeUtc = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$SupervisorRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')).TrimEnd('\')
. (Join-Path $PSScriptRoot 'runtime-lib.ps1')
. (Join-Path $SupervisorRoot 'scripts\advanced-flag-world-api.ps1')

$DefaultsPath = Join-Path $SupervisorRoot 'config\dev-runtime.defaults.json'
$ComposePath = Join-Path $SupervisorRoot 'docker-compose.yml'
$Config = Read-AshAtlasRuntimeDefaults $DefaultsPath
$MapRepository = [string]$Config.map_repository
$ReleaseRoot = [string]$Config.release_root
$WaterReadinessBbox = '-120.153919,39.081099,-120.113919,39.121099'
$PlayerSpeedMps = 125
$ServerTickHz = 20
$WorldDeltaHz = 20
$CombatDeltaHz = 10
$RuntimeMutexWaitSeconds = [int]$Config.feature.lifecycle.mutex_wait_seconds
$RuntimeShutdownWaitSeconds = [int]$Config.feature.lifecycle.shutdown_wait_seconds
$RuntimePollMilliseconds = [int]$Config.feature.lifecycle.poll_milliseconds
$childDollar = '$'
$StartedProcesses = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
$StartupTimingOrigin = Get-Date
$StartupTimings = [ordered]@{}

function Set-StartupTiming {
    param([string]$Name, [DateTime]$Started, [DateTime]$Finished = (Get-Date), [string]$Result = 'completed')
    $StartupTimings[$Name] = [ordered]@{
        started_at_utc = $Started.ToUniversalTime().ToString('o')
        finished_at_utc = $Finished.ToUniversalTime().ToString('o')
        duration_ms = [math]::Round(($Finished - $Started).TotalMilliseconds)
        result = $Result
    }
}

function Write-StartupTimingReport {
    param([Parameter(Mandatory = $true)]$Paths, [string]$Result)
    $finished = Get-Date
    $report = [ordered]@{
        schema_version = 1
        result = $Result
        phases = $StartupTimings
        total_duration_ms = [math]::Round(($finished - $StartupTimingOrigin).TotalMilliseconds)
        finished_at_utc = $finished.ToUniversalTime().ToString('o')
    }
    $temporary = "$($Paths.root)\startup-timings.json.$PID.tmp"
    try {
        $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temporary -Encoding utf8
        Move-Item -LiteralPath $temporary -Destination (Join-Path $Paths.root 'startup-timings.json') -Force
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Assert-ExactPath {
    param([string]$Actual, [string]$Expected, [string]$Label)
    if (-not [string]::Equals([IO.Path]::GetFullPath($Actual).TrimEnd('\'), [IO.Path]::GetFullPath($Expected).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label must be '$Expected', not '$Actual'."
    }
}

function Resolve-SelectedRuntime {
    if ($RuntimeMode -eq 'Main') {
        if ($WorktreePath) { throw '-WorktreePath is valid only with -RuntimeMode Feature.' }
        Assert-ExactPath $SupervisorRoot ([string]$Config.permanent_checkout) 'Main supervisor checkout'
        $runtime = New-AshAtlasMainIdentity $Config
        Assert-ExactPath (Get-AshAtlasGitValue $runtime.worktree @('rev-parse', '--show-toplevel')) $runtime.worktree 'Main worktree'
        $actualBranch = Get-AshAtlasGitValue $runtime.worktree @('branch', '--show-current')
        if ($actualBranch -ne $runtime.branch) { throw "Main checkout branch is '$actualBranch', expected '$($runtime.branch)'." }
        return $runtime
    }

    if (-not $WorktreePath) { throw '-WorktreePath is required with -RuntimeMode Feature.' }
    $root = [IO.Path]::GetFullPath($WorktreePath).TrimEnd('\')
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw "Feature worktree is missing: $root" }
    Assert-ExactPath (Get-AshAtlasGitValue $root @('rev-parse', '--show-toplevel')) $root 'Feature worktree'
    $branch = Get-AshAtlasGitValue $root @('branch', '--show-current')
    if (-not $branch) { throw 'Feature runtime refuses a detached worktree.' }
    return New-AshAtlasFeatureIdentity $Config $root $branch
}

function Resolve-AcceptedIntegrationCleanupRuntime {
    param([Parameter(Mandatory = $true)]$Runtime)

    if ([string]$Runtime.mode -ne 'Feature') {
        throw 'REFUSED: accepted Integration Test cleanup requires a Feature runtime.'
    }

    $leaseMutex = Enter-AshAtlasLeaseStoreMutex
    try {
        $leasePath = Get-AshAtlasLeasePath
        $store = Read-AshAtlasLeaseStore $leasePath
        $registered = @($store.runtimes | Where-Object {
            [string]$_.runtime_id -eq [string]$Runtime.runtime_id
        })
        if ($registered.Count -ne 1) {
            if ($registered.Count -gt 1) {
                throw 'REFUSED: accepted Integration Test cleanup found multiple leases for the selected runtime.'
            }
            throw 'REFUSED: accepted Integration Test cleanup requires exactly one persisted feature lease for the selected runtime.'
        }

        $lease = $registered[0]
        if ([string](Get-AshAtlasObjectPropertyValue $lease 'integration_status' '') -cne 'merged_to_test') {
            throw 'REFUSED: accepted Integration Test cleanup requires a merged_to_test feature lease.'
        }
        foreach ($field in @(
            'worktree', 'branch', 'database', 'compose_project', 'postgres_container', 'network', 'volume',
            'base_test_generation', 'base_test_sha'
        )) {
            $leaseValue = [string](Get-AshAtlasObjectPropertyValue $lease $field '')
            $runtimeValue = [string](Get-AshAtlasObjectPropertyValue $Runtime $field '')
            $equal = if ($field -eq 'worktree') {
                [string]::Equals($leaseValue, $runtimeValue, [StringComparison]::OrdinalIgnoreCase)
            } else {
                $leaseValue -ceq $runtimeValue
            }
            if (-not $equal) {
                throw "REFUSED: accepted cleanup lease identity differs at $field."
            }
        }

        $ports = Get-AshAtlasObjectPropertyValue $lease 'ports' $null
        if ($null -eq $ports) {
            throw 'REFUSED: accepted cleanup lease has no persisted feature ports.'
        }
        $portValues = [ordered]@{}
        foreach ($name in @('frontend', 'backend', 'postgres', 'world_api')) {
            $value = Get-AshAtlasObjectPropertyValue $ports $name $null
            if ($null -eq $value) {
                throw "REFUSED: accepted cleanup lease is missing persisted $name port."
            }
            try { $portValues[$name] = [int]$value }
            catch { throw "REFUSED: accepted cleanup lease has an invalid persisted $name port." }
            if ($portValues[$name] -lt 1 -or $portValues[$name] -gt 65535) {
                throw "REFUSED: accepted cleanup lease has an unsafe persisted $name port."
            }
        }
        $portNumbers = @($portValues.Values)
        if (@($portNumbers | Select-Object -Unique).Count -ne $portNumbers.Count) {
            throw 'REFUSED: accepted cleanup lease contains duplicate persisted feature ports.'
        }
        if ($portValues.world_api -eq 8765) {
            throw 'REFUSED: accepted cleanup lease uses the protected Main World API port.'
        }

        $worldRuntime = Get-AshAtlasObjectPropertyValue $lease 'world_runtime' $null
        $groupId = [string](Get-AshAtlasObjectPropertyValue $worldRuntime 'group_id' '')
        if ($groupId -notmatch '^world-[0-9a-f]{16}$') {
            throw 'REFUSED: accepted cleanup lease has an unsafe World API group ID.'
        }
        $descriptorPort = Get-AshAtlasObjectPropertyValue $worldRuntime 'port' $null
        if ($null -eq $descriptorPort) {
            throw 'REFUSED: accepted cleanup lease World descriptor has no persisted port.'
        }
        try { $descriptorPort = [int]$descriptorPort }
        catch { throw 'REFUSED: accepted cleanup lease World descriptor has an invalid persisted port.' }
        if ($descriptorPort -ne $portValues.world_api) {
            throw 'REFUSED: accepted cleanup lease World descriptor port differs from its persisted world_api port.'
        }

        # The historical worktree lock may predate newer World identity fields. Cleanup
        # uses only the exact persisted lease descriptor and never reparses that lock.
        $Runtime.ports = $ports
        Add-Member -InputObject $Runtime -NotePropertyName world_runtime -NotePropertyValue $worldRuntime -Force
        return $Runtime
    } finally {
        Exit-AshAtlasLeaseStoreMutex $leaseMutex
    }
}

function Set-WorldRuntimePolicy {
    param([Parameter(Mandatory = $true)]$Runtime)

    $script:WorldRuntimeLockPath = Join-Path $Runtime.worktree 'config\world-runtime.lock.json'
    if (-not (Test-Path -LiteralPath $script:WorldRuntimeLockPath -PathType Leaf)) {
        throw "Selected runtime world lock is missing: $script:WorldRuntimeLockPath"
    }
    $script:WorldRuntimeDescriptor = Get-AshAtlasWorldRuntimeDescriptor $script:WorldRuntimeLockPath
    $script:WorldRuntimeLock = $script:WorldRuntimeDescriptor.identity
    $script:ExpectedMapBranch = [string]$script:WorldRuntimeLock.pipeline.protected_branch
    $script:ExpectedMapSha = [string]$script:WorldRuntimeLock.pipeline.sha
    $script:ExpectedReleaseId = [string]$script:WorldRuntimeLock.release.release_id
    $script:ExpectedProfileFingerprint = [string]$script:WorldRuntimeLock.release.profile_set_fingerprint
    $script:ExpectedContractFingerprint = [string]$script:WorldRuntimeLock.release.build_contract_fingerprint
    $script:ExpectedBoundaryReleaseId = [string]$script:WorldRuntimeLock.release.boundary_release_id
    $script:ExpectedManifestSha256 = [string]$script:WorldRuntimeLock.release.manifest_sha256
    $script:ExpectedPackageCount = [int]$script:WorldRuntimeLock.release.package_count
    $script:ExpectedRiverSurface = $script:WorldRuntimeLock.river_surface
    $script:RiverSurfaceReleaseRoot = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $ReleaseRoot) ([string]$script:ExpectedRiverSurface.release_id))).TrimEnd('\')
    $rawWorldLock = Get-Content -Raw -LiteralPath $script:WorldRuntimeLockPath | ConvertFrom-Json
    $script:ExpectedLakeSurface = $rawWorldLock.lake_surface
    $script:LakeSurfaceReleaseRoot = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $ReleaseRoot) ([string]$script:ExpectedLakeSurface.release_id))).TrimEnd('\')
    $script:ExpectedOceanCoastSurface = $rawWorldLock.ocean_coast_surface
    $script:OceanCoastSurfaceReleaseRoot = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $ReleaseRoot) ([string]$script:ExpectedOceanCoastSurface.release_id))).TrimEnd('\')
    $script:ExpectedWaterVisualTiles = $rawWorldLock.water_visual_tiles
    $script:WaterVisualTilesArtifactPath = [IO.Path]::GetFullPath((Join-Path `
        (Join-Path (Split-Path -Parent $ReleaseRoot) ([string]$script:ExpectedWaterVisualTiles.release_id)) `
        ([string]$script:ExpectedWaterVisualTiles.artifact_file)))
    $script:ExpectedRiverbankLakeshore = $rawWorldLock.riverbank_lakeshore
    $script:RiverbankLakeshoreReleaseRoot = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $ReleaseRoot) ([string]$script:ExpectedRiverbankLakeshore.release_id))).TrimEnd('\')
    $script:ExpectedWaterbodyIdentityOverlay = $rawWorldLock.waterbody_identity_overlay
    $script:WaterbodyIdentityOverlayReleaseRoot = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $ReleaseRoot) ([string]$script:ExpectedWaterbodyIdentityOverlay.release_id))).TrimEnd('\')
    $script:ExpectedWaterNameIndex = $rawWorldLock.water_name_index
    $script:WaterNameIndexReleaseRoot = [IO.Path]::GetFullPath([string]$Config.water_name_index_root).TrimEnd('\')
    if ($Runtime.mode -eq 'Feature') {
        Add-Member -InputObject $Runtime -NotePropertyName world_runtime -NotePropertyValue $script:WorldRuntimeDescriptor -Force
    }
}

function Get-ActiveAshAtlasRuntimeIds {
    $ids = @()
    if (Get-Command docker -ErrorAction SilentlyContinue) {
        $names = @(& docker ps -a --filter "label=com.ash-atlas.owner=$($Config.owner_label)" --format '{{.Names}}' 2>$null)
        foreach ($name in $names) {
            $inspection = Get-DockerInspection container $name -AllowMissing
            if ($null -ne $inspection) { $ids += [string](Get-AshAtlasObjectPropertyValue $inspection.Config.Labels 'com.ash-atlas.runtime-id' '') }
        }
    }
    $leaseRoot = Split-Path -Parent (Get-AshAtlasLeasePath)
    if (Test-Path -LiteralPath $leaseRoot -PathType Container) {
        foreach ($state in @(Get-ChildItem -LiteralPath (Join-Path $leaseRoot 'runtimes') -Filter owned-processes.json -Recurse -ErrorAction SilentlyContinue)) {
            try {
                $records = @(Read-AshAtlasJsonArray $state.FullName 'runtime process state')
                if (@($records | Where-Object { Get-Process -Id ([int]$_.pid) -ErrorAction SilentlyContinue }).Count -gt 0) {
                    $ids += [string]$records[0].runtime_id
                }
            } catch { }
        }
        foreach ($statePath in @(Get-ChildItem -LiteralPath (Join-Path $leaseRoot 'runtimes') -Filter supervisor.json -Recurse -ErrorAction SilentlyContinue)) {
            try {
                $state = Get-Content -Raw -LiteralPath $statePath.FullName | ConvertFrom-Json
                if ((Get-AshAtlasRecordedProcessStatus $state).status -eq 'match') { $ids += [string]$state.runtime_id }
            } catch { }
        }
    }
    return ,@($ids | Where-Object { $_ } | Select-Object -Unique)
}

function Get-RunningAshAtlasRuntimeIds {
    $ids = @(
        Get-AshAtlasDockerPortMappings |
            Where-Object { $_.running -eq $true -and $_.runtime_id } |
            ForEach-Object { [string]$_.runtime_id }
    )
    $leaseRoot = Split-Path -Parent (Get-AshAtlasLeasePath)
    if (Test-Path -LiteralPath $leaseRoot -PathType Container) {
        foreach ($state in @(Get-ChildItem -LiteralPath (Join-Path $leaseRoot 'runtimes') -Filter owned-processes.json -Recurse -ErrorAction SilentlyContinue)) {
            try {
                $records = @(Read-AshAtlasJsonArray $state.FullName 'runtime process state')
                if (@($records | Where-Object { Get-Process -Id ([int]$_.pid) -ErrorAction SilentlyContinue }).Count -gt 0) {
                    $ids += [string]$records[0].runtime_id
                }
            } catch { }
        }
        foreach ($statePath in @(Get-ChildItem -LiteralPath (Join-Path $leaseRoot 'runtimes') -Filter supervisor.json -Recurse -ErrorAction SilentlyContinue)) {
            try {
                $state = Get-Content -Raw -LiteralPath $statePath.FullName | ConvertFrom-Json
                if ((Get-AshAtlasRecordedProcessStatus $state).status -eq 'match') { $ids += [string]$state.runtime_id }
            } catch { }
        }
    }
    return ,@($ids | Where-Object { $_ } | Select-Object -Unique)
}

function Get-ExistingLeaseWorktrees {
    param([object[]]$Leases)
    return ,@($Leases | ForEach-Object { [string]$_.worktree } | Where-Object { Test-Path -LiteralPath $_ -PathType Container })
}

function Test-LiveRecordedRuntimeProcesses {
    param([Parameter(Mandatory = $true)]$Lease)
    $statePath = Join-Path (Split-Path -Parent (Get-AshAtlasLeasePath)) ("runtimes\$($Lease.runtime_id)\owned-processes.json")
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { return $false }
    try {
        $records = @(Read-AshAtlasJsonArray $statePath 'runtime process state')
        foreach ($record in $records) {
            if ([string]$record.runtime_id -ne [string]$Lease.runtime_id -or
                -not [string]::Equals([string]$record.worktree, [string]$Lease.worktree, [StringComparison]::OrdinalIgnoreCase)) { return $false }
            if ((Get-AshAtlasRecordedProcessStatus $record).status -eq 'match') { return $true }
        }
    } catch { return $false }
    return $false
}

function Test-LiveRecordedRuntimeSupervisor {
    param([Parameter(Mandatory = $true)]$Lease)

    $statePath = Join-Path (Split-Path -Parent (Get-AshAtlasLeasePath)) ("runtimes\$($Lease.runtime_id)\supervisor.json")
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { return $false }
    try {
        $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
        if ([string]$state.runtime_id -ne [string]$Lease.runtime_id -or
            -not [string]::Equals([string]$state.worktree, [string]$Lease.worktree, [StringComparison]::OrdinalIgnoreCase) -or
            [int]$state.ports.frontend -ne [int]$Lease.ports.frontend -or
            [int]$state.ports.backend -ne [int]$Lease.ports.backend -or
            [int]$state.ports.postgres -ne [int]$Lease.ports.postgres) { return $false }
        return (Get-AshAtlasRecordedProcessStatus $state).status -eq 'match'
    } catch { return $false }
}

function Resolve-FeaturePortsAndLease {
    param([Parameter(Mandatory = $true)]$Runtime, [switch]$Persist, [switch]$PreserveExistingPorts)

    $leaseMutex = Enter-AshAtlasLeaseStoreMutex
    try {
    $leasePath = Get-AshAtlasLeasePath
    $store = Read-AshAtlasLeaseStore $leasePath
    $leases = @($store.runtimes | Where-Object { $null -ne $_ })
    $activeRuntimeIds = @(
        foreach ($collection in @(Get-ActiveAshAtlasRuntimeIds)) {
            foreach ($entry in @($collection)) {
                if ($null -ne $entry) { $entry }
            }
        }
    )
    $existingWorktrees = @(
        foreach ($collection in @(Get-ExistingLeaseWorktrees $leases)) {
            foreach ($entry in @($collection)) {
                if ($null -ne $entry) { $entry }
            }
        }
    )
    $stale = @(Get-AshAtlasStaleLeases $leases $existingWorktrees $activeRuntimeIds | Where-Object { $null -ne $_ })
    if ($Persist -and $stale.Count -gt 0) {
        Remove-AshAtlasStaleLeasesFromStore $store $stale | Out-Null
        $leases = @($store.runtimes | Where-Object { $null -ne $_ })
    }
    $existing = @($leases | Where-Object { [string]$_.runtime_id -eq [string]$Runtime.runtime_id } | Select-Object -First 1)
    if ($Persist -and $existing.Count -ne 1) {
        throw "Feature worktree is not registered. Run .\tools\dev\feature-runtime.ps1 create -WorktreePath '$($Runtime.worktree)' -DisplayName '<name>' first."
    }
    if ($Persist -and $existing.Count -eq 1 -and
        [string](Get-AshAtlasObjectPropertyValue $existing[0] 'integration_status' '') -eq 'merged_to_test') {
        throw 'Feature merged into Integration Test; its runtime is retired.'
    }
    $existingPorts = if ($existing.Count -eq 1) { $existing[0].ports } else { $null }
    $dockerMappings = @(
        if ($Persist) { Get-AshAtlasDockerPortMappings -RequireAvailable }
        else { Get-AshAtlasDockerPortMappings }
    )
    $dockerMappings = @($dockerMappings | Where-Object { $null -ne $_ })
    $excludedRanges = @(Get-AshAtlasExcludedTcpRanges | Where-Object { $null -ne $_ })
    $listeningPorts = @(Get-AshAtlasListeningPorts | Where-Object { $null -ne $_ })
    $hasLiveExactRuntime = $existing.Count -eq 1 -and (
        (Test-LiveRecordedRuntimeSupervisor $existing[0]) -or (Test-LiveRecordedRuntimeProcesses $existing[0])
    )
    $portBlockingLeases = @(Get-AshAtlasPortBlockingLeases $leases $activeRuntimeIds)
    if ($hasLiveExactRuntime) {
        $dockerMappings = @($dockerMappings) + @(
            [pscustomobject]@{ port = [int]$existing[0].ports.frontend; container = 'launcher-owned frontend'; runtime_id = [string]$Runtime.runtime_id; compose_project = [string]$Runtime.compose_project },
            [pscustomobject]@{ port = [int]$existing[0].ports.backend; container = 'launcher-owned backend'; runtime_id = [string]$Runtime.runtime_id; compose_project = [string]$Runtime.compose_project }
        )
    }
    if (($PreserveExistingPorts -or $hasLiveExactRuntime) -and $null -ne $existingPorts) {
        $Runtime.ports = $existingPorts
    } else {
        $Runtime.ports = Select-AshAtlasFeaturePorts `
            -Config $Config `
            -RuntimeId ([string]$Runtime.runtime_id) `
            -ExcludedRanges $excludedRanges `
            -ListeningPorts $listeningPorts `
            -DockerMappings $dockerMappings `
            -Leases $portBlockingLeases `
            -ExistingPorts $existingPorts
    }
    if ($Persist) {
        $existingPortClaim = if ($existing.Count -eq 1) { Get-AshAtlasObjectPropertyValue $existing[0] 'port_claim' $null } else { $null }
        $portClaim = if ($hasLiveExactRuntime -and $null -ne $existingPortClaim -and
            (Test-AshAtlasFeaturePortClaimActive $existing[0])) {
            $existingPortClaim
        } else {
            New-AshAtlasFeaturePortClaim $Runtime
        }
        Add-Member -InputObject $Runtime -NotePropertyName port_claim -NotePropertyValue $portClaim -Force
    }
    if ($existing.Count -eq 1) {
        $displayName = [string](Get-AshAtlasObjectPropertyValue $existing[0] 'display_name' '')
        $launcherPath = [string](Get-AshAtlasObjectPropertyValue $existing[0] 'launcher_path' '')
        if ($displayName) { Add-Member -InputObject $Runtime -NotePropertyName display_name -NotePropertyValue $displayName -Force }
        if ($launcherPath) { Add-Member -InputObject $Runtime -NotePropertyName launcher_path -NotePropertyValue $launcherPath -Force }
    }
    $previousWorldRuntime = if ($existing.Count -eq 1) { Get-AshAtlasObjectPropertyValue $existing[0] 'world_runtime' $null } else { $null }
    $registeredRuntimeIds = @($leases | ForEach-Object { [string]$_.runtime_id })
    $Runtime = Resolve-AshAtlasFeatureWorldRegistration `
        -Config $Config `
        -Runtime $Runtime `
        -Store $store `
        -Persist:$Persist `
        -PreviousWorldRuntime $previousWorldRuntime `
        -ExcludedRanges $excludedRanges `
        -ListeningPorts $listeningPorts `
        -DockerMappings $dockerMappings `
        -RegisteredRuntimeIds $registeredRuntimeIds `
        -ActiveRuntimeIds $activeRuntimeIds
    if ($Persist) {
        $launcherPath = [string](Get-AshAtlasObjectPropertyValue $Runtime 'launcher_path' '')
        $displayName = [string](Get-AshAtlasObjectPropertyValue $Runtime 'display_name' '')
        if (-not $launcherPath -or -not $displayName) { throw 'Registered feature lease is missing its generated launcher identity.' }
        $launcherRoot = [string]$Config.feature_launcher_root
        if (Test-Path -LiteralPath $launcherPath) {
            if (-not (Test-AshAtlasGeneratedLauncher $launcherPath $Runtime.runtime_id $launcherRoot)) {
                throw "REFUSED: registered launcher is not safely owned: $launcherPath"
            }
        }
        $launcherDirectory = Split-Path -Parent $launcherPath
        New-Item -ItemType Directory -Path $launcherDirectory -Force | Out-Null
        $launcherTemporary = "$launcherPath.$PID.tmp"
        try {
            New-AshAtlasFeatureLauncherContent $Config $Runtime $displayName $SupervisorRoot | Set-Content -LiteralPath $launcherTemporary -Encoding ascii -NoNewline
            Move-Item -LiteralPath $launcherTemporary -Destination $launcherPath -Force
        } finally {
            if (Test-Path -LiteralPath $launcherTemporary) { Remove-Item -LiteralPath $launcherTemporary -Force }
        }
        Set-AshAtlasLease $store $Runtime | Out-Null
        Write-AshAtlasLeaseStore $store $leasePath
    }
    return [pscustomobject]@{ runtime = $Runtime; store = $store; stale = $stale; path = $leasePath }
    } finally {
        Exit-AshAtlasLeaseStoreMutex $leaseMutex
    }
}

function Release-FeaturePortClaim {
    param([Parameter(Mandatory = $true)]$Runtime)

    $leaseMutex = Enter-AshAtlasLeaseStoreMutex
    try {
        $leasePath = Get-AshAtlasLeasePath
        $store = Read-AshAtlasLeaseStore $leasePath
        $matches = @($store.runtimes | Where-Object { [string]$_.runtime_id -eq [string]$Runtime.runtime_id })
        if ($matches.Count -ne 1) { return }
        $lease = $matches[0]
        $claim = Get-AshAtlasObjectPropertyValue $lease 'port_claim' $null
        if ($null -eq $claim) { return }
        $currentClaim = New-AshAtlasFeaturePortClaim $Runtime
        if ([int]$claim.pid -ne [int]$currentClaim.pid -or
            (ConvertTo-AshAtlasCanonicalUtcTimestamp $claim.start_time_utc) -ne
                (ConvertTo-AshAtlasCanonicalUtcTimestamp $currentClaim.start_time_utc)) {
            return
        }
        $lease.PSObject.Properties.Remove('port_claim')
        Add-Member -InputObject $lease -NotePropertyName updated_at_utc `
            -NotePropertyValue ((Get-Date).ToUniversalTime().ToString('o')) -Force
        Write-AshAtlasLeaseStore $store $leasePath
    } finally {
        Exit-AshAtlasLeaseStoreMutex $leaseMutex
    }
}

function Get-RuntimeStatePaths {
    param([Parameter(Mandatory = $true)]$Runtime)
    $local = Split-Path -Parent (Get-AshAtlasLeasePath)
    $root = Join-Path $local ("runtimes\" + [string]$Runtime.runtime_id)
    return [pscustomobject]@{
        root = $root
        logs = Join-Path $root 'logs'
        processes = Join-Path $root 'owned-processes.json'
        supervisor = Join-Path $root 'supervisor.json'
        stop_signal = Join-Path $root 'stop-requested'
        ready_signal = Join-Path $root 'ready'
    }
}

function Read-RuntimeSupervisorState {
    param([Parameter(Mandatory = $true)]$Runtime, [Parameter(Mandatory = $true)]$Paths)

    if (-not (Test-Path -LiteralPath $Paths.supervisor -PathType Leaf)) { return $null }
    try { $state = Get-Content -Raw -LiteralPath $Paths.supervisor | ConvertFrom-Json }
    catch { throw "REFUSED: runtime supervisor state is unreadable: $($Paths.supervisor)" }
    if ([int]$state.schema_version -notin @(1, 2) -or [string]$state.runtime_id -ne [string]$Runtime.runtime_id -or
        -not [string]::Equals([string]$state.worktree, [string]$Runtime.worktree, [StringComparison]::OrdinalIgnoreCase) -or
        [string]$state.branch -ne [string]$Runtime.branch -or
        [int]$state.ports.frontend -ne [int]$Runtime.ports.frontend -or
        [int]$state.ports.backend -ne [int]$Runtime.ports.backend -or
        [int]$state.ports.postgres -ne [int]$Runtime.ports.postgres) {
        throw "REFUSED: supervisor state does not belong to exact runtime $($Runtime.runtime_id)."
    }
    return $state
}

function Write-RuntimeSupervisorState {
    param([Parameter(Mandatory = $true)]$Runtime, [Parameter(Mandatory = $true)]$Paths, [Parameter(Mandatory = $true)][string]$GameSha, [Parameter(Mandatory = $true)][ValidateSet('starting', 'healthy', 'stopping')][string]$Phase)

    $process = Get-Process -Id $PID -ErrorAction Stop
    $record = [ordered]@{
        schema_version = 2
        pid = $PID
        start_time_utc = $process.StartTime.ToUniversalTime().ToString('o')
        started_at_utc = $process.StartTime.ToUniversalTime().ToString('o')
        runtime_id = [string]$Runtime.runtime_id
        worktree = [string]$Runtime.worktree
        branch = [string]$Runtime.branch
        sha = $GameSha
        ports = [ordered]@{ frontend = [int]$Runtime.ports.frontend; backend = [int]$Runtime.ports.backend; postgres = [int]$Runtime.ports.postgres; world_api = [int]$Runtime.ports.world_api }
        world_group_id = $(if ($Runtime.mode -eq 'Feature') { [string]$Runtime.world_runtime.group_id } else { '' })
        supervisor_script = [IO.Path]::GetFullPath($PSCommandPath)
        phase = $Phase
        updated_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    }
    $temporary = "$($Paths.supervisor).$PID.tmp"
    try {
        $record | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $temporary -Encoding utf8
        Move-Item -LiteralPath $temporary -Destination $Paths.supervisor -Force
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Get-RuntimeSupervisorStatus {
    param([Parameter(Mandatory = $true)]$Runtime, [Parameter(Mandatory = $true)]$Paths)

    $state = Read-RuntimeSupervisorState $Runtime $Paths
    if ($null -eq $state) { return [pscustomobject]@{ status = 'missing'; state = $null; process = $null } }
    $identity = Assert-AshAtlasRecordedProcessIdentity $state 'runtime supervisor'
    if ($identity.status -eq 'missing') { return [pscustomobject]@{ status = 'gone'; state = $state; process = $null } }
    $native = Get-CimInstance Win32_Process -Filter "ProcessId = $($state.pid)" -ErrorAction SilentlyContinue
    $escapedScript = [regex]::Escape([IO.Path]::GetFullPath([string]$state.supervisor_script))
    $escapedWorktree = [regex]::Escape([IO.Path]::GetFullPath([string]$Runtime.worktree).TrimEnd('\'))
    if ($null -eq $native -or -not [string]$native.CommandLine) {
        return [pscustomobject]@{ status = 'match'; state = $state; process = $identity.process }
    }
    $powerShellHost = ([string]$native.Name).ToLowerInvariant()
    if ($powerShellHost -notin @('powershell.exe', 'pwsh.exe') -or [string]$native.CommandLine -notmatch $escapedScript -or
        [string]$native.CommandLine -notmatch $escapedWorktree) {
        throw "REFUSED: recorded supervisor PID $($state.pid) does not identify the exact Ash Atlas runtime command."
    }
    return [pscustomobject]@{ status = 'match'; state = $state; process = $identity.process }
}

function Remove-CurrentRuntimeSupervisorState {
    param([Parameter(Mandatory = $true)]$Runtime, [Parameter(Mandatory = $true)]$Paths)

    if (-not (Test-Path -LiteralPath $Paths.supervisor -PathType Leaf)) { return }
    $state = Read-RuntimeSupervisorState $Runtime $Paths
    if ([int]$state.pid -ne $PID) { return }
    if ((Assert-AshAtlasRecordedProcessIdentity $state 'current runtime supervisor').status -eq 'match') {
        Remove-AshAtlasExpectedRuntimeStateFile $Paths.root $Paths.supervisor
    }
}

function Test-ExactRuntimePortOwners {
    param([Parameter(Mandatory = $true)]$Runtime)

    $escapedWorktree = [regex]::Escape([IO.Path]::GetFullPath([string]$Runtime.worktree).TrimEnd('\'))
    foreach ($entry in @(
        @{ port = [int]$Runtime.ports.frontend; pattern = '(?i)vite(?:\.js)?' },
        @{ port = [int]$Runtime.ports.backend; pattern = '(?i)(tsx|src[\\/]index\.ts)' }
    )) {
        $owners = @(Get-NetTCPConnection -LocalPort $entry.port -State Listen -ErrorAction SilentlyContinue)
        if ($owners.Count -lt 1) { return $false }
        foreach ($owner in $owners) {
            $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($owner.OwningProcess)" -ErrorAction SilentlyContinue
            if ($null -eq $process -or [string]$process.Name -ne 'node.exe' -or
                [string]$process.CommandLine -notmatch $escapedWorktree -or [string]$process.CommandLine -notmatch $entry.pattern) {
                throw "REFUSED: runtime port $($entry.port) is owned by a process outside exact worktree $($Runtime.worktree)."
            }
        }
    }
    return $true
}

function Reject-ExactRuntimeReuse {
    param([Parameter(Mandatory = $true)][string]$Reason)
    Write-Verbose "Exact runtime is not reusable: $Reason"
    return $false
}

function Test-ExactHealthyRuntime {
    param([Parameter(Mandatory = $true)]$Runtime, [Parameter(Mandatory = $true)]$Paths, [Parameter(Mandatory = $true)][string]$GameSha)

    if (-not (Test-Path -LiteralPath $Paths.ready_signal -PathType Leaf)) { return (Reject-ExactRuntimeReuse 'ready marker is absent') }
    if (Test-Path -LiteralPath $Paths.stop_signal -PathType Leaf) { return (Reject-ExactRuntimeReuse 'stop marker is present') }
    $supervisor = Get-RuntimeSupervisorStatus $Runtime $Paths
    if ($supervisor.status -ne 'match') { return (Reject-ExactRuntimeReuse "supervisor status is $($supervisor.status)") }
    if ([string]$supervisor.state.phase -ne 'healthy') { return (Reject-ExactRuntimeReuse "supervisor phase is $($supervisor.state.phase)") }
    if ([string]$supervisor.state.sha -ne $GameSha) { return (Reject-ExactRuntimeReuse 'supervisor SHA differs from current HEAD') }
    if ($Runtime.mode -eq 'Feature') {
        if ([string](Get-AshAtlasObjectPropertyValue $supervisor.state 'world_group_id' '') -ne [string]$Runtime.world_runtime.group_id -or
            [int]$supervisor.state.ports.world_api -ne [int]$Runtime.ports.world_api) {
            return (Reject-ExactRuntimeReuse 'World API group differs from the selected world lock')
        }
        $worldStatus = Get-AshAtlasWorldGroupStatus $Runtime
        if ($null -eq $worldStatus -or $worldStatus.compatible -ne $true) { return (Reject-ExactRuntimeReuse 'World API group is absent or incompatible') }
    }
    if (-not (Test-Path -LiteralPath $Paths.processes -PathType Leaf)) { return (Reject-ExactRuntimeReuse 'owned process state is absent') }
    try { $records = @(Read-AshAtlasJsonArray $Paths.processes 'runtime process state') }
    catch { throw "REFUSED: runtime process state is unreadable: $($Paths.processes). $($_.Exception.Message)" }
    if ($records.Count -lt 2) { return (Reject-ExactRuntimeReuse 'fewer than two owned processes are recorded') }
    foreach ($record in $records) {
        if ([string]$record.runtime_id -ne [string]$Runtime.runtime_id -or
            -not [string]::Equals([string]$record.worktree, [string]$Runtime.worktree, [StringComparison]::OrdinalIgnoreCase) -or
            [int]$record.launcher_pid -ne [int]$supervisor.state.pid) {
            throw 'REFUSED: runtime process state does not belong to the recorded exact supervisor.'
        }
        if ((Assert-AshAtlasRecordedProcessIdentity $record 'launcher-owned process').status -ne 'match') { return (Reject-ExactRuntimeReuse "recorded process $($record.pid) is gone") }
    }
    if (-not (Test-ExactRuntimePortOwners $Runtime)) { return (Reject-ExactRuntimeReuse 'frontend or backend listener is absent') }
    $container = Get-DockerInspection container $Runtime.postgres_container -AllowMissing
    if ($null -eq $container) { return (Reject-ExactRuntimeReuse 'owned PostgreSQL container is absent') }
    Assert-OwnedDockerResource $container $Runtime 'container'
    $healthStatus = if ($null -ne $container.State.PSObject.Properties['Health']) { [string]$container.State.Health.Status } else { '' }
    if (-not [bool]$container.State.Running -or $healthStatus -ne 'healthy' -or
        (Get-ContainerPublishedPort $container) -ne [int]$Runtime.ports.postgres -or
        (Get-ContainerDataVolume $container) -ne [string]$Runtime.volume) { return (Reject-ExactRuntimeReuse 'owned PostgreSQL container is not healthy or its port/volume identity drifted') }

    $frontendUrl = "http://127.0.0.1:$($Runtime.ports.frontend)"
    $backendUrl = "http://127.0.0.1:$($Runtime.ports.backend)"
    try {
        $health = Invoke-RestMethod -Uri "$backendUrl/health" -TimeoutSec 3
        $ready = Invoke-RestMethod -Uri "$backendUrl/ready" -TimeoutSec 3
        $frontend = Invoke-WebRequest -Uri $frontendUrl -UseBasicParsing -TimeoutSec 3
    } catch { return (Reject-ExactRuntimeReuse "HTTP verification failed: $($_.Exception.Message)") }
    $readyIdentity = $ready.checks.runtimeIdentity.identity
    $matches = (
        $health.runtime.label -eq $Runtime.runtime_id -and $health.runtime.branch -eq $Runtime.branch -and $health.runtime.sha -eq $GameSha -and
        $ready.ok -eq $true -and $ready.checks.database.ok -eq $true -and $ready.checks.worldAuthority.ok -eq $true -and
        $ready.checks.runtimeIdentity.ok -eq $true -and $readyIdentity.label -eq $Runtime.runtime_id -and
        $readyIdentity.branch -eq $Runtime.branch -and $readyIdentity.sha -eq $GameSha -and $frontend.StatusCode -eq 200
    )
    if (-not $matches) { return (Reject-ExactRuntimeReuse 'health, readiness, runtime identity, or frontend response does not match the exact runtime') }
    return $true
}

function Invoke-HealthyRuntimeReuse {
    param([Parameter(Mandatory = $true)]$Runtime, [Parameter(Mandatory = $true)]$Paths, [Parameter(Mandatory = $true)][string]$GameSha)

    if (-not (Test-ExactHealthyRuntime $Runtime $Paths $GameSha)) { return $false }
    $frontendUrl = "http://127.0.0.1:$($Runtime.ports.frontend)"
    Write-Host 'Runtime is already healthy; reusing it.' -ForegroundColor Green
    Write-Host "Frontend: $frontendUrl"
    Open-AshAtlasRuntimeFrontend $frontendUrl -NoBrowser:$NoBrowser | Out-Null
    return $true
}

function Assert-RuntimeStartupContinues {
    param([Parameter(Mandatory = $true)]$Paths)
    if (Test-Path -LiteralPath $Paths.stop_signal -PathType Leaf) {
        throw [OperationCanceledException]::new('Runtime startup was superseded by a newer exact launcher invocation.')
    }
}

function Wait-RuntimeStopRequest {
    param([Parameter(Mandatory = $true)]$Paths)

    $canReadConsole = -not [Console]::IsInputRedirected
    Write-Host 'Press Enter to stop launcher-owned processes, or use the exact runtime stop command.'
    while (-not (Test-Path -LiteralPath $Paths.stop_signal -PathType Leaf)) {
        if ($canReadConsole) {
            try {
                if ([Console]::KeyAvailable) {
                    $key = [Console]::ReadKey($true)
                    if ($key.Key -eq [ConsoleKey]::Enter) { return }
                }
            } catch { $canReadConsole = $false }
        }
        Start-Sleep -Milliseconds $RuntimePollMilliseconds
    }
}

function Invoke-WithComposeEnvironment {
    param([Parameter(Mandatory = $true)]$Runtime, [Parameter(Mandatory = $true)][scriptblock]$Action)
    $variables = New-AshAtlasComposeEnvironment $Config $Runtime
    $previous = @{}
    try {
        foreach ($entry in $variables.GetEnumerator()) {
            $previous[$entry.Key] = [Environment]::GetEnvironmentVariable($entry.Key, 'Process')
            [Environment]::SetEnvironmentVariable($entry.Key, [string]$entry.Value, 'Process')
        }
        & $Action
    } finally {
        foreach ($entry in $variables.GetEnumerator()) {
            [Environment]::SetEnvironmentVariable($entry.Key, $previous[$entry.Key], 'Process')
        }
    }
}

function Invoke-RuntimeCompose {
    param([Parameter(Mandatory = $true)]$Runtime, [Parameter(Mandatory = $true)][string[]]$Arguments)
    Invoke-WithComposeEnvironment $Runtime {
        $result = Invoke-AshAtlasNative docker (@('compose', '--file', $ComposePath, '--project-name', [string]$Runtime.compose_project) + $Arguments)
        if ($result.StdOut) { Write-Host $result.StdOut.TrimEnd() }
        if ($result.ExitCode -ne 0) {
            if ($result.StdErr) { Write-Error $result.StdErr.TrimEnd() -ErrorAction Continue }
            throw "Docker Compose failed for runtime $($Runtime.runtime_id)."
        }
    }
}

function Get-DockerInspection {
    param([ValidateSet('container', 'volume', 'network')][string]$Kind, [string]$Name, [switch]$AllowMissing)
    $result = Invoke-AshAtlasNative docker @($Kind, 'inspect', $Name)
    if ($result.ExitCode -ne 0) {
        if ($AllowMissing) { return $null }
        throw "Required Docker $Kind '$Name' is missing."
    }
    return @(($result.StdOut | ConvertFrom-Json))[0]
}

function Assert-OwnedDockerResource {
    param([Parameter(Mandatory = $true)]$Inspection, [Parameter(Mandatory = $true)]$Runtime, [string]$Kind)
    $configProperty = $Inspection.PSObject.Properties['Config']
    $labels = if ($null -ne $configProperty -and $null -ne $configProperty.Value.PSObject.Properties['Labels']) {
        $configProperty.Value.Labels
    } else {
        $Inspection.Labels
    }
    if ([string](Get-AshAtlasObjectPropertyValue $labels 'com.ash-atlas.owner' '') -ne [string]$Config.owner_label -or
        [string](Get-AshAtlasObjectPropertyValue $labels 'com.ash-atlas.runtime-id' '') -ne [string]$Runtime.runtime_id) {
        throw "REFUSED: Docker $Kind is not owned by Ash Atlas runtime $($Runtime.runtime_id)."
    }
}

function Ensure-OwnedNetwork {
    param([Parameter(Mandatory = $true)]$Runtime)
    $network = Get-DockerInspection network $Runtime.network -AllowMissing
    if ($null -ne $network) {
        Assert-OwnedDockerResource $network $Runtime 'network'
        return
    }
    & docker network create `
        --label "com.ash-atlas.owner=$($Config.owner_label)" `
        --label "com.ash-atlas.runtime-id=$($Runtime.runtime_id)" `
        --label "com.ash-atlas.runtime-mode=$(([string]$Runtime.mode).ToLowerInvariant())" `
        $Runtime.network | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not create owned network $($Runtime.network)." }
}

function Ensure-FeatureVolume {
    param([Parameter(Mandatory = $true)]$Runtime)
    if (-not (Test-AshAtlasSafeFeatureRuntime $Config $Runtime)) { throw 'REFUSED: unsafe feature runtime database identity.' }
    $volume = Get-DockerInspection volume $Runtime.volume -AllowMissing
    if ($null -ne $volume) {
        Assert-OwnedDockerResource $volume $Runtime 'volume'
        return
    }
    & docker volume create `
        --label "com.ash-atlas.owner=$($Config.owner_label)" `
        --label "com.ash-atlas.runtime-id=$($Runtime.runtime_id)" `
        --label 'com.ash-atlas.database-disposition=disposable' `
        $Runtime.volume | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not create disposable volume $($Runtime.volume)." }
}

function Assert-RetainedVolume {
    param([Parameter(Mandatory = $true)]$Runtime)
    if ($Runtime.mode -ne 'Main' -or $Runtime.database -ne 'ash_atlas_game' -or $Config.main.database.retained -ne $true) {
        throw 'REFUSED: retained-volume checks are valid only for protected Main.'
    }
    if ([string]$Runtime.volume -ne [string]$Config.main.database.volume) { throw 'REFUSED: retained volume identity changed from defaults.' }
    Get-DockerInspection volume $Runtime.volume | Out-Null
}

function Get-ContainerPublishedPort {
    param($Inspection)
    $binding = $Inspection.HostConfig.PortBindings.'5432/tcp'
    if ($null -eq $binding -or @($binding).Count -ne 1) { return 0 }
    return [int]@($binding)[0].HostPort
}

function Get-ContainerDataVolume {
    param($Inspection)
    $mount = @($Inspection.Mounts | Where-Object { [string]$_.Destination -eq '/var/lib/postgresql/data' })
    if ($mount.Count -ne 1 -or [string]$mount[0].Type -ne 'volume') { return '' }
    return [string]$mount[0].Name
}

function Wait-PostgresReady {
    param(
        [Parameter(Mandatory = $true)]$Runtime,
        [int]$TimeoutSeconds = 90,
        [int]$RequiredSuccesses = 4,
        [int]$MinimumStableSeconds = 3,
        [int]$FinalGraceSeconds = 3
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $runtimePaths = Get-RuntimeStatePaths $Runtime
    $successfulAt = $null
    $startedAt = ''
    $successes = 0
    do {
        Assert-RuntimeStartupContinues $runtimePaths
        $container = Get-DockerInspection container $Runtime.postgres_container -AllowMissing
        $healthy = $false
        if ($null -ne $container -and [bool]$container.State.Running) {
            $health = if ($null -ne $container.State.PSObject.Properties['Health']) { [string]$container.State.Health.Status } else { 'not-configured' }
            $currentStartedAt = [string]$container.State.StartedAt
            if ($health -eq 'healthy') {
                $sql = Invoke-AshAtlasNative docker @(
                    'exec', [string]$Runtime.postgres_container,
                    'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', [string]$Runtime.database_user,
                    '-d', [string]$Runtime.database, '-tAc', 'SELECT 1;'
                )
                $healthy = $sql.ExitCode -eq 0 -and $sql.StdOut.Trim() -eq '1'
            }
            if ($healthy -and ($successes -eq 0 -or $currentStartedAt -eq $startedAt)) {
                if ($successes -eq 0) {
                    $successfulAt = Get-Date
                    $startedAt = $currentStartedAt
                }
                $successes++
                if ($successes -ge $RequiredSuccesses -and ((Get-Date) - $successfulAt).TotalSeconds -ge $MinimumStableSeconds) {
                    Start-Sleep -Seconds $FinalGraceSeconds
                    Assert-RuntimeStartupContinues $runtimePaths
                    $finalContainer = Get-DockerInspection container $Runtime.postgres_container
                    $finalHealth = if ($null -ne $finalContainer.State.PSObject.Properties['Health']) { [string]$finalContainer.State.Health.Status } else { 'not-configured' }
                    $finalSql = Invoke-AshAtlasNative docker @(
                        'exec', [string]$Runtime.postgres_container,
                        'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', [string]$Runtime.database_user,
                        '-d', [string]$Runtime.database, '-tAc', 'SELECT 1;'
                    )
                    if ([bool]$finalContainer.State.Running -and $finalHealth -eq 'healthy' -and
                        [string]$finalContainer.State.StartedAt -eq $startedAt -and
                        $finalSql.ExitCode -eq 0 -and $finalSql.StdOut.Trim() -eq '1') {
                        return
                    }
                    $successes = 0
                    $successfulAt = $null
                    $startedAt = ''
                }
            } else {
                $successes = 0
                $successfulAt = $null
                $startedAt = ''
            }
        } else {
            $successes = 0
            $successfulAt = $null
            $startedAt = ''
        }
        Start-Sleep -Seconds 1
    } while ((Get-Date) -lt $deadline)

    $container = Get-DockerInspection container $Runtime.postgres_container -AllowMissing
    $state = if ($null -eq $container) { 'missing' } else { [string]$container.State.Status }
    $health = if ($null -eq $container) { 'missing' } elseif ($null -ne $container.State.PSObject.Properties['Health']) { [string]$container.State.Health.Status } else { 'not-configured' }
    $logs = Invoke-AshAtlasNative docker @('logs', '--tail', '40', [string]$Runtime.postgres_container)
    $logTail = (($logs.StdOut + [Environment]::NewLine + $logs.StdErr).Trim())
    throw @"
PostgreSQL did not become stably ready within $TimeoutSeconds seconds.
Container: $($Runtime.postgres_container)
State/health: $state / $health
Host port: $($Runtime.ports.postgres)
Database: $($Runtime.database)
Volume: $($Runtime.volume)
Docker log tail:
$logTail
"@
}

function Assert-ExpectedDatabase {
    param([Parameter(Mandatory = $true)]$Runtime)
    if ($Runtime.mode -eq 'Feature' -and -not (Test-AshAtlasSafeFeatureRuntime $Config $Runtime)) {
        throw 'REFUSED: feature runtime may not connect to ash_atlas_game.'
    }
    $escapedName = ([string]$Runtime.database).Replace("'", "''")
    $result = Invoke-AshAtlasNative docker @('exec', [string]$Runtime.postgres_container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', [string]$Runtime.database_user, '-d', 'postgres', '-tAc', "SELECT 1 FROM pg_database WHERE datname='$escapedName';")
    if ($result.ExitCode -ne 0 -or $result.StdOut.Trim() -ne '1') { throw "Expected database $($Runtime.database) is missing." }
}

function Test-TransientMigrationStartupFailure {
    param([string]$Output, [Parameter(Mandatory = $true)]$Runtime)

    $container = Get-DockerInspection container $Runtime.postgres_container -AllowMissing
    if ($null -eq $container -or -not $container.State.StartedAt) { return $false }
    try { $started = [DateTime]::Parse([string]$container.State.StartedAt).ToUniversalTime() }
    catch { return $false }
    if (((Get-Date).ToUniversalTime() - $started).TotalSeconds -gt 180) { return $false }
    return $Output -match '(?im)(Connection terminated unexpectedly|ECONNRESET|ECONNREFUSED|\bEPIPE\b|server closed the connection unexpectedly|the database system is starting up|connection refused)'
}

function Resolve-FeatureInternalWorkerLease {
    param(
        [Parameter(Mandatory = $true)]$Runtime,
        [Parameter(Mandatory = $true)][string]$ParentRuntimeId,
        [Parameter(Mandatory = $true)][int]$ParentProcessId,
        [Parameter(Mandatory = $true)][string]$ParentProcessStartTimeUtc
    )

    if ([string]$Runtime.mode -ne 'Feature' -or [string]$Runtime.runtime_id -ne $ParentRuntimeId) {
        throw 'REFUSED: internal startup worker runtime identity differs from its parent.'
    }
    $workerProcess = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $PID" -ErrorAction Stop
    if ($null -eq $workerProcess -or [int]$workerProcess.ParentProcessId -ne $ParentProcessId) {
        throw 'REFUSED: internal startup worker was not launched by the claimed runtime parent.'
    }

    $leaseMutex = Enter-AshAtlasLeaseStoreMutex
    try {
        $store = Read-AshAtlasLeaseStore (Get-AshAtlasLeasePath)
        $matches = @($store.runtimes | Where-Object { [string]$_.runtime_id -eq [string]$Runtime.runtime_id })
        if ($matches.Count -ne 1) { throw 'REFUSED: internal startup worker requires one exact registered feature lease.' }
        $lease = $matches[0]
        if ([string](Get-AshAtlasObjectPropertyValue $lease 'integration_status' '') -eq 'merged_to_test') {
            throw 'Feature merged into Integration Test; its runtime is retired.'
        }
        if (-not [string]::Equals([string]$lease.worktree, [string]$Runtime.worktree, [StringComparison]::OrdinalIgnoreCase) -or
            [string]$lease.branch -ne [string]$Runtime.branch -or
            [string]$lease.database -ne [string]$Runtime.database -or
            [string]$lease.compose_project -ne [string]$Runtime.compose_project -or
            [string]$lease.postgres_container -ne [string]$Runtime.postgres_container -or
            [string]$lease.network -ne [string]$Runtime.network -or
            [string]$lease.volume -ne [string]$Runtime.volume) {
            throw 'REFUSED: internal startup worker lease resource identity differs from the selected feature.'
        }
        $runtimeBaseGeneration = [string](Get-AshAtlasObjectPropertyValue $Runtime 'base_test_generation' '')
        $runtimeBaseSha = [string](Get-AshAtlasObjectPropertyValue $Runtime 'base_test_sha' '')
        if ([string](Get-AshAtlasObjectPropertyValue $lease 'base_test_generation' '') -ne $runtimeBaseGeneration -or
            [string](Get-AshAtlasObjectPropertyValue $lease 'base_test_sha' '') -ne $runtimeBaseSha) {
            throw 'REFUSED: internal startup worker lease base generation differs from the selected feature.'
        }

        $claim = Get-AshAtlasObjectPropertyValue $lease 'port_claim' $null
        if ($null -eq $claim -or
            [string]$claim.runtime_id -ne $ParentRuntimeId -or
            -not [string]::Equals([string]$claim.worktree, [string]$Runtime.worktree, [StringComparison]::OrdinalIgnoreCase) -or
            [int]$claim.pid -ne $ParentProcessId -or
            (ConvertTo-AshAtlasCanonicalUtcTimestamp $claim.start_time_utc) -ne
                (ConvertTo-AshAtlasCanonicalUtcTimestamp $ParentProcessStartTimeUtc) -or
            -not (Test-AshAtlasFeaturePortClaimActive $lease)) {
            throw 'REFUSED: internal startup worker parent does not own the active feature port claim.'
        }

        $ports = Get-AshAtlasObjectPropertyValue $lease 'ports' $null
        $world = Get-AshAtlasObjectPropertyValue $lease 'world_runtime' $null
        $expectedWorld = Get-AshAtlasObjectPropertyValue $Runtime 'world_runtime' $null
        if ($null -eq $ports -or [int]$ports.frontend -le 0 -or [int]$ports.backend -le 0 -or [int]$ports.postgres -le 0 -or
            @(@([int]$ports.frontend, [int]$ports.backend, [int]$ports.postgres) | Select-Object -Unique).Count -ne 3 -or
            $null -eq $world -or $null -eq $expectedWorld -or [int]$ports.world_api -le 0 -or
            [int]$ports.world_api -ne [int]$world.port -or
            [string]$world.group_id -ne [string]$expectedWorld.group_id -or
            [string]$world.canonical_identity -ne [string]$expectedWorld.canonical_identity) {
            throw 'REFUSED: internal startup worker lease ports or World descriptor are incomplete or differ from the selected feature.'
        }

        $Runtime.ports = $ports
        $Runtime.world_runtime = $world
        return $Runtime
    } finally {
        Exit-AshAtlasLeaseStoreMutex $leaseMutex
    }
}

function Ensure-FeatureTelemetryExporterRole {
    param([Parameter(Mandatory = $true)]$Runtime)

    if ($Runtime.mode -ne 'Feature') { throw 'REFUSED: the telemetry exporter bootstrap is Feature-only.' }
    $roleName = 'ash_atlas_telemetry_exporter'
    $createSql = @"
DO `$role`$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$roleName') THEN
    CREATE ROLE $roleName NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END
`$role`$;
"@
    $create = Invoke-AshAtlasNative docker @(
        'exec', [string]$Runtime.postgres_container,
        'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', [string]$Runtime.database_user,
        '-d', 'postgres', '-c', $createSql
    )
    if ($create.ExitCode -ne 0) {
        throw "Could not bootstrap restricted Feature role $roleName in exact container $($Runtime.postgres_container): $($create.StdErr.Trim())"
    }
    $verifySql = "SELECT count(*) FROM pg_roles WHERE rolname = '$roleName' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit AND NOT rolreplication AND NOT rolbypassrls;"
    $verify = Invoke-AshAtlasNative docker @(
        'exec', [string]$Runtime.postgres_container,
        'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', [string]$Runtime.database_user,
        '-d', 'postgres', '-tAc', $verifySql
    )
    if ($verify.ExitCode -ne 0) {
        throw "Could not verify restricted Feature role $roleName in exact container $($Runtime.postgres_container): $($verify.StdErr.Trim())"
    }
    if ($verify.StdOut.Trim() -ne '1') {
        throw "REFUSED: Feature role $roleName is missing or its NOLOGIN/NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOINHERIT/NOREPLICATION/NOBYPASSRLS attributes drifted."
    }
}

function Invoke-RuntimeMigrations {
    param([Parameter(Mandatory = $true)]$Runtime, [Parameter(Mandatory = $true)]$Paths)

    New-Item -ItemType Directory -Path $Paths.logs -Force | Out-Null
    $pnpm = (Get-Command pnpm.cmd -ErrorAction Stop).Source
    $maximumAttempts = 3
    for ($attempt = 1; $attempt -le $maximumAttempts; $attempt++) {
        $result = Invoke-AshAtlasNative $pnpm @('--dir', [string]$Runtime.worktree, 'db:migrate') -WorkingDirectory $Runtime.worktree
        $stdoutPath = Join-Path $Paths.logs "migration-attempt-$attempt.out.log"
        $stderrPath = Join-Path $Paths.logs "migration-attempt-$attempt.err.log"
        [IO.File]::WriteAllText($stdoutPath, $result.StdOut, [Text.Encoding]::UTF8)
        [IO.File]::WriteAllText($stderrPath, $result.StdErr, [Text.Encoding]::UTF8)
        if ($result.ExitCode -eq 0) {
            if ($result.StdOut) { Write-Host $result.StdOut.TrimEnd() }
            return
        }

        $combined = $result.StdOut + [Environment]::NewLine + $result.StdErr
        $isTransient = Test-TransientMigrationStartupFailure $combined $Runtime
        if (-not $isTransient -or $attempt -eq $maximumAttempts) {
            throw "Migrations failed for $($Runtime.database) on attempt $attempt. Captured output: $stdoutPath and $stderrPath"
        }
        Write-Warning "Transient PostgreSQL startup failure during migration attempt $attempt; revalidating stable readiness before retry."
        Wait-PostgresReady $Runtime
        Start-Sleep -Seconds 2
    }
}

function Assert-PostgresIdentity {
    param([Parameter(Mandatory = $true)]$Runtime, [switch]$RequireOwnership)
    $container = Get-DockerInspection container $Runtime.postgres_container
    if ($RequireOwnership) { Assert-OwnedDockerResource $container $Runtime 'container' }
    $actualVolume = Get-ContainerDataVolume $container
    $actualPort = Get-ContainerPublishedPort $container
    if ($actualVolume -ne [string]$Runtime.volume) { throw "PostgreSQL mounts '$actualVolume', expected '$($Runtime.volume)'." }
    if ($actualPort -ne [int]$Runtime.ports.postgres) { throw "PostgreSQL publishes $actualPort, expected $($Runtime.ports.postgres)." }
    if (-not [bool]$container.State.Running) {
        & docker start $Runtime.postgres_container | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Could not start $($Runtime.postgres_container)." }
    }
    Wait-PostgresReady $Runtime
    Assert-ExpectedDatabase $Runtime
}

function Test-WarmReusableRuntimePostgres {
    param([Parameter(Mandatory = $true)]$Runtime)

    $before = Get-DockerInspection container $Runtime.postgres_container -AllowMissing
    if ($null -eq $before) { return $false }
    Assert-OwnedDockerResource $before $Runtime 'container'
    $beforeHealth = if ($null -ne $before.State.PSObject.Properties['Health']) { [string]$before.State.Health.Status } else { 'not-configured' }
    $beforeId = [string]$before.Id
    $beforePid = [int]$before.State.Pid
    $beforeStartedAt = [string]$before.State.StartedAt
    if (-not [bool]$before.State.Running -or $beforeHealth -ne 'healthy' -or -not $beforeId -or $beforePid -le 0 -or -not $beforeStartedAt -or
        (Get-ContainerDataVolume $before) -ne [string]$Runtime.volume -or
        (Get-ContainerPublishedPort $before) -ne [int]$Runtime.ports.postgres) {
        return $false
    }

    $sql = Invoke-AshAtlasNative docker @(
        'exec', [string]$Runtime.postgres_container,
        'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', [string]$Runtime.database_user,
        '-d', [string]$Runtime.database, '-tAc', 'SELECT 1;'
    )
    if ($sql.ExitCode -ne 0 -or $sql.StdOut.Trim() -ne '1') { return $false }

    $after = Get-DockerInspection container $Runtime.postgres_container -AllowMissing
    if ($null -eq $after) { return $false }
    Assert-OwnedDockerResource $after $Runtime 'container'
    $afterHealth = if ($null -ne $after.State.PSObject.Properties['Health']) { [string]$after.State.Health.Status } else { 'not-configured' }
    return (
        [string]$after.Id -eq $beforeId -and
        [int]$after.State.Pid -eq $beforePid -and
        [string]$after.State.StartedAt -eq $beforeStartedAt -and
        [bool]$after.State.Running -and
        $afterHealth -eq 'healthy' -and
        (Get-ContainerDataVolume $after) -eq [string]$Runtime.volume -and
        (Get-ContainerPublishedPort $after) -eq [int]$Runtime.ports.postgres
    )
}

function Ensure-RuntimePostgres {
    param([Parameter(Mandatory = $true)]$Runtime)
    if ($Runtime.mode -eq 'Main') {
        Assert-RetainedVolume $Runtime
        $container = Get-DockerInspection container $Runtime.postgres_container -AllowMissing
        if ($null -eq $container) { throw 'Main PostgreSQL container is missing. Run -RepairPostgres; the launcher will not recreate it automatically.' }
        if ((Get-ContainerDataVolume $container) -ne $Runtime.volume -or (Get-ContainerPublishedPort $container) -ne [int]$Runtime.ports.postgres) {
            throw "Main PostgreSQL configuration differs from protected defaults. Run .\tools\dev\run-main.ps1 -RepairPostgres."
        }
        Assert-PostgresIdentity $Runtime
        return
    }

    Ensure-OwnedNetwork $Runtime
    Ensure-FeatureVolume $Runtime
    if (Test-WarmReusableRuntimePostgres $Runtime) {
        Write-Host "Reusing healthy PostgreSQL container $($Runtime.postgres_container)."
        return
    }
    Invoke-RuntimeCompose $Runtime @('up', '-d', 'postgres')
    Assert-PostgresIdentity $Runtime -RequireOwnership
}

function Repair-MainPostgres {
    param([Parameter(Mandatory = $true)]$Runtime)
    if ($Runtime.mode -ne 'Main') { throw '-RepairPostgres is supported only for Main.' }
    Assert-RetainedVolume $Runtime
    $volumeBefore = Get-DockerInspection volume $Runtime.volume
    $retainedIdentityBefore = "$($volumeBefore.Name)|$($volumeBefore.Mountpoint)|$($volumeBefore.CreatedAt)"
    $before = Get-DockerInspection container $Runtime.postgres_container -AllowMissing
    if ($null -ne $before) {
        $mounted = Get-ContainerDataVolume $before
        if ($mounted -ne $Runtime.volume) {
            throw "REFUSED: existing Main container mounts '$mounted', not retained volume '$($Runtime.volume)'."
        }
    }
    Ensure-OwnedNetwork $Runtime
    Invoke-RuntimeCompose $Runtime @('up', '-d', '--force-recreate', 'postgres')
    Assert-PostgresIdentity $Runtime -RequireOwnership
    $volumeAfter = Get-DockerInspection volume $Runtime.volume
    $retainedIdentityAfter = "$($volumeAfter.Name)|$($volumeAfter.Mountpoint)|$($volumeAfter.CreatedAt)"
    if ($retainedIdentityAfter -ne $retainedIdentityBefore) { throw 'REFUSED: retained Main volume identity changed during repair.' }
    Write-Host "Main PostgreSQL repaired on port $($Runtime.ports.postgres)." -ForegroundColor Green
    Write-Host "Verified retained volume: $($Runtime.volume)"
    Write-Host "Verified retained database: $($Runtime.database)"
}

function Format-PortOwners {
    param($Owners)
    return (@($Owners | ForEach-Object {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($_.OwningProcess)" -ErrorAction SilentlyContinue
        "PID $($_.OwningProcess), executable '$($process.ExecutablePath)', command '$($process.CommandLine)'"
    }) -join [Environment]::NewLine)
}

function Assert-RequiredPortFree {
    param([int]$Port, [string]$Label)
    $owners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    if ($owners.Count -gt 0) { throw "$Label port $Port is occupied. The launcher will not terminate or reuse its process.`n$(Format-PortOwners $owners)" }
}

function Wait-HttpJson {
    param([string]$Uri, [int]$TimeoutSeconds = 60, [string]$StopSignalPath = '')
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if ($StopSignalPath -and (Test-Path -LiteralPath $StopSignalPath -PathType Leaf)) {
            throw [System.OperationCanceledException]::new('Runtime startup was superseded while waiting for HTTP readiness.')
        }
        try { return Invoke-RestMethod -Uri $Uri -TimeoutSec 3 }
        catch { Start-Sleep -Milliseconds 500 }
    }
    throw "Timed out waiting for $Uri"
}

function Wait-HttpOk {
    param([string]$Uri, [int]$TimeoutSeconds = 60, [string]$StopSignalPath = '')
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if ($StopSignalPath -and (Test-Path -LiteralPath $StopSignalPath -PathType Leaf)) {
            throw [System.OperationCanceledException]::new('Runtime startup was superseded while waiting for frontend readiness.')
        }
        try {
            if ((Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) { return }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    throw "Timed out waiting for HTTP 200 from $Uri"
}

function Assert-WorldIdentity {
    param($Health)
    Assert-AshAtlasWorldHealthIdentity $Health $script:WorldRuntimeLock | Out-Null
}

function Assert-WaterVisualSourceIdentity {
    $manifestPath = Join-Path (Split-Path -Parent $WaterVisualTilesArtifactPath) 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "Water visual manifest is missing: $manifestPath" }
    $manifestHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $manifestPath).Hash.ToLowerInvariant()
    if ($manifestHash -cne [string]$ExpectedWaterVisualTiles.manifest_sha256) { throw "Water visual manifest hash '$manifestHash' does not match locked identity." }
    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    if ([string]$manifest.pipeline_sha -cne [string]$WorldRuntimeLock.pipeline.sha -or
        [string]$manifest.policy -cne [string]$ExpectedWaterVisualTiles.policy -or
        [string]$manifest.precedence -cne 'river>lake>ocean>land' -or
        [string]$manifest.sources.river.manifest_sha256 -cne [string]$ExpectedRiverSurface.manifest_sha256 -or
        [string]$manifest.sources.lake.manifest_sha256 -cne [string]$ExpectedLakeSurface.manifest_sha256 -or
        [string]$manifest.sources.ocean.manifest_sha256 -cne [string]$ExpectedOceanCoastSurface.manifest_sha256 -or
        [string]$manifest.sources.world.manifest_sha256 -cne [string]$WorldRuntimeLock.release.manifest_sha256) {
        throw 'Water visual source identities or precedence do not match the locked authorities.'
    }
    if (-not (Test-Path -LiteralPath $WaterVisualTilesArtifactPath -PathType Leaf)) { throw "Water visual artifact is missing: $WaterVisualTilesArtifactPath" }
    $artifact = Get-Item -LiteralPath $WaterVisualTilesArtifactPath
    if ($artifact.Length -ne [int64]$ExpectedWaterVisualTiles.artifact_size_bytes) { throw 'Water visual artifact size does not match the locked identity.' }
    $artifactHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $WaterVisualTilesArtifactPath).Hash.ToLowerInvariant()
    if ($artifactHash -cne [string]$ExpectedWaterVisualTiles.artifact_sha256) { throw "Water visual artifact hash '$artifactHash' does not match locked identity." }
}

function Assert-RiverbankLakeshoreSourceIdentity {
    $manifestPath = Join-Path $RiverbankLakeshoreReleaseRoot 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "Riverbank/lakeshore release manifest is missing: $RiverbankLakeshoreReleaseRoot"
    }
    $manifestHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $manifestPath).Hash.ToLowerInvariant()
    if ($manifestHash -cne [string]$ExpectedRiverbankLakeshore.manifest_sha256) {
        throw "Riverbank/lakeshore manifest hash '$manifestHash' does not match locked identity."
    }
    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    if ([string]$manifest.release_id -cne [string]$ExpectedRiverbankLakeshore.release_id -or
        [string]$manifest.schema -cne [string]$ExpectedRiverbankLakeshore.schema -or
        [string]$manifest.policy -cne [string]$ExpectedRiverbankLakeshore.policy -or
        [string]$manifest.pipeline_sha -cne [string]$ExpectedRiverbankLakeshore.pipeline_sha -or
        [string]$manifest.contract_fingerprint -cne [string]$ExpectedRiverbankLakeshore.contract_fingerprint -or
        [double]$manifest.distance_m -ne [double]$ExpectedRiverbankLakeshore.distance_m -or
        [double]$manifest.cell_size_m -ne [double]$ExpectedRiverbankLakeshore.cell_size_m -or
        [string]$manifest.grid_fingerprint -cne [string]$ExpectedRiverbankLakeshore.grid_fingerprint -or
        [string]$manifest.deterministic_fingerprint -cne [string]$ExpectedRiverbankLakeshore.deterministic_fingerprint) {
        throw 'Riverbank/lakeshore manifest identity does not match the locked release.'
    }
}

function Assert-WaterOverlayReadiness {
    param($Overlay, [string]$RequestUrl)
    if ($Overlay.type -ne 'FeatureCollection' -or $Overlay.metadata.runtime.branch -ne $ExpectedMapBranch -or $Overlay.metadata.runtime.sha -ne $ExpectedMapSha) {
        throw "Water overlay readiness failed for $RequestUrl`: runtime identity mismatch."
    }
    foreach ($capability in @('flagPlacementWater', 'waterNoBuildOverlay', 'unionedWaterSurface', 'riverWaterAuthorityV1', 'lakeWaterAuthorityV1', 'oceanCoastWaterAuthorityV1')) {
        if ($Overlay.metadata.capabilities.$capability -ne $true) { throw "Water overlay readiness failed: missing $capability." }
    }
    if (@($Overlay.features | Where-Object { $_.properties.kind -eq 'water-no-build' -and $_.geometry.type -in @('Polygon', 'MultiPolygon') }).Count -lt 1) {
        throw 'Water overlay readiness failed: Tahoe viewport contains no supported polygon.'
    }
}

function Assert-ExistingWorldRuntime {
    param([Parameter(Mandatory = $true)]$Runtime)
    $base = "http://127.0.0.1:$($Runtime.ports.world_api)"
    $overlayUrl = "$base/api/overlays.geojson?bbox=$WaterReadinessBbox&zoom=15&layers=administrative%2Cwater-no-build"
    $health = Invoke-RestMethod -Uri "$base/api/health" -TimeoutSec 5
    Assert-WorldIdentity $health
    Assert-WaterOverlayReadiness (Invoke-RestMethod -Uri $overlayUrl -TimeoutSec 20) $overlayUrl
    $snapshot = Get-FeatureWorldApiSnapshot -BaseUrl $base -TimeoutSeconds 30
    if ($snapshot.Compatibility.Compatible -ne $true) { throw "World API is incompatible: $($snapshot.Compatibility.Message)" }
    return $health
}

function Assert-MapReleaseOnDisk {
    Assert-ExactPath (Get-AshAtlasGitValue $MapRepository @('rev-parse', '--show-toplevel')) $MapRepository 'Map repository'
    $branch = Get-AshAtlasGitValue $MapRepository @('branch', '--show-current')
    $sha = Get-AshAtlasGitValue $MapRepository @('rev-parse', 'HEAD')
    if ($branch -ne $ExpectedMapBranch -or $sha -ne $ExpectedMapSha) { throw "Map checkout must be $ExpectedMapBranch @ $ExpectedMapSha." }
    $manifest = Join-Path $ReleaseRoot 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { throw "Published release is missing: $ReleaseRoot" }
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $manifest).Hash.ToLowerInvariant()
    if ($hash -ne $ExpectedManifestSha256) { throw "World manifest hash '$hash' does not match locked identity." }
    $riverManifest = Join-Path $RiverSurfaceReleaseRoot 'manifest.json'
    if (-not (Test-Path -LiteralPath $riverManifest -PathType Leaf)) { throw "Published river surface release is missing: $RiverSurfaceReleaseRoot" }
    $riverHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $riverManifest).Hash.ToLowerInvariant()
    if ($riverHash -ne [string]$ExpectedRiverSurface.manifest_sha256) { throw "River surface manifest hash '$riverHash' does not match locked identity." }
    Assert-RiverbankLakeshoreSourceIdentity
    Assert-WaterVisualSourceIdentity
}

function Start-LoggedProcess {
    param([string]$FilePath, [string[]]$Arguments, [string]$WorkingDirectory, [string]$Name, $Paths, $Runtime)
    New-Item -ItemType Directory -Path $Paths.logs -Force | Out-Null
    $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory `
        -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $Paths.logs "$Name.out.log") `
        -RedirectStandardError (Join-Path $Paths.logs "$Name.err.log")
    $StartedProcesses.Add($process)
    Write-Host "$Name started as PID $($process.Id)." -ForegroundColor DarkGray
    return $process
}

function Get-SharedWorldStatePaths {
    $local = Split-Path -Parent (Get-AshAtlasLeasePath)
    $root = Join-Path $local 'shared-world'
    return [pscustomobject]@{
        root = $root
        state = Join-Path $root 'world-api.json'
        stdout = Join-Path $root 'world-api.out.log'
        stderr = Join-Path $root 'world-api.err.log'
    }
}

function Write-SharedWorldState {
    param([Parameter(Mandatory = $true)]$Process, [Parameter(Mandatory = $true)]$Paths, [int]$Port)
    $record = [ordered]@{
        schema_version = 1
        pid = $Process.Id
        start_time_utc = $Process.StartTime.ToUniversalTime().ToString('o')
        port = $Port
        map_repository = $MapRepository
        pipeline_branch = $ExpectedMapBranch
        pipeline_sha = $ExpectedMapSha
        release_id = $ExpectedReleaseId
        started_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    }
    $temporary = "$($Paths.state).$PID.tmp"
    try {
        $record | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $temporary -Encoding utf8
        Move-Item -LiteralPath $temporary -Destination $Paths.state -Force
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Stop-NewSharedWorldProcess {
    param([Parameter(Mandatory = $true)]$Process)
    $current = Get-Process -Id $Process.Id -ErrorAction SilentlyContinue
    if ($null -ne $current -and $current.StartTime.ToUniversalTime().ToString('o') -eq $Process.StartTime.ToUniversalTime().ToString('o')) {
        Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
    }
}

function Ensure-MainWorldRuntime {
    param(
        [Parameter(Mandatory = $true)]$Runtime,
        [switch]$FullWorldVerify
    )

    $port = [int]$Runtime.ports.world_api
    if ($Runtime.mode -ne 'Main' -or $port -ne [int]$Config.main.ports.world_api -or $port -ne 8765) {
        throw 'Main World API must remain protected on port 8765.'
    }
    $mutex = [Threading.Mutex]::new($false, "Global\AshAtlas_SharedWorldApi_$port")
    $owned = $false
    try {
        try { $owned = $mutex.WaitOne([TimeSpan]::FromMinutes(6)) }
        catch [Threading.AbandonedMutexException] { $owned = $true }
        if (-not $owned) { throw "Timed out waiting for the canonical World API startup lock on port $port." }

        $listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
        if ($listeners.Count -gt 0) {
            Assert-ExistingWorldRuntime $Runtime | Out-Null
            Write-Host "Reusing compatible Main World API on port $port." -ForegroundColor DarkGray
            return
        }

        Assert-MapReleaseOnDisk
        $paths = Get-SharedWorldStatePaths
        New-Item -ItemType Directory -Path $paths.root -Force | Out-Null
        $python = (Get-Command python -ErrorAction Stop).Source
        $verificationMode = if ($FullWorldVerify) { 'full' } else { 'manifest-only' }
        if ($FullWorldVerify) {
            Write-Host 'Full World verification requested: verifying all 64,800 packages.' -ForegroundColor DarkGray
        } else {
            Write-Host 'Fast local World admission: manifest and identity verified; exhaustive package scan skipped.' -ForegroundColor DarkGray
        }
        $arguments = @('-m', 'map_world_pipeline', 'serve-world-release', '--release-root', $ReleaseRoot,
            '--host', '127.0.0.1', '--port', [string]$port, '--cache-packages', '12',
            '--overlay-max-features', '2000', '--overlay-max-packages', '64', '--runtime-branch', $ExpectedMapBranch, '--runtime-sha', $ExpectedMapSha,
            '--artifact-verification-mode', $verificationMode, '--expected-manifest-sha256', $ExpectedManifestSha256,
            '--expected-release-root', $ReleaseRoot,
            '--river-surface-mode', [string]$ExpectedRiverSurface.release_id,
            '--river-surface-release-root', $RiverSurfaceReleaseRoot,
            '--river-surface-manifest-sha256', [string]$ExpectedRiverSurface.manifest_sha256,
            '--river-surface-policy', [string]$ExpectedRiverSurface.policy,
            '--river-surface-cache-packages', '12',
            '--lake-surface-release-root', $LakeSurfaceReleaseRoot,
            '--lake-surface-manifest-sha256', [string]$ExpectedLakeSurface.manifest_sha256,
            '--lake-surface-policy', [string]$ExpectedLakeSurface.policy,
            '--lake-surface-cache-packages', '12',
            '--ocean-coast-surface-release-root', $OceanCoastSurfaceReleaseRoot,
            '--ocean-coast-surface-manifest-sha256', [string]$ExpectedOceanCoastSurface.manifest_sha256,
            '--ocean-coast-surface-policy', [string]$ExpectedOceanCoastSurface.policy,
            '--ocean-coast-surface-cache-packages', '12',
            '--riverbank-lakeshore-release-root', $RiverbankLakeshoreReleaseRoot,
            '--riverbank-lakeshore-manifest-sha256', [string]$ExpectedRiverbankLakeshore.manifest_sha256,
            '--riverbank-lakeshore-policy', [string]$ExpectedRiverbankLakeshore.policy,
            '--riverbank-lakeshore-cache-packages', '12',
            '--waterbody-identity-overlay-release-root', $WaterbodyIdentityOverlayReleaseRoot,
            '--waterbody-identity-overlay-manifest-sha256', [string]$ExpectedWaterbodyIdentityOverlay.manifest_sha256,
            '--waterbody-identity-overlay-cache-packages', '12',
            '--water-name-index-root', $WaterNameIndexReleaseRoot,
            '--water-name-index-manifest-sha256', [string]$ExpectedWaterNameIndex.manifest_sha256)
        $previousPythonPath = [Environment]::GetEnvironmentVariable('PYTHONPATH', 'Process')
        try {
            [Environment]::SetEnvironmentVariable('PYTHONPATH', (Join-Path $MapRepository 'src'), 'Process')
            $process = Start-Process -FilePath $python -ArgumentList (@($arguments | ForEach-Object { ConvertTo-AshAtlasNativeArgument ([string]$_) }) -join ' ') `
                -WorkingDirectory $MapRepository -WindowStyle Hidden -PassThru `
                -RedirectStandardOutput $paths.stdout -RedirectStandardError $paths.stderr
        } finally {
            [Environment]::SetEnvironmentVariable('PYTHONPATH', $previousPythonPath, 'Process')
        }
        Write-SharedWorldState $process $paths $port
        try {
            $base = "http://127.0.0.1:$port"
            Wait-HttpJson "$base/api/health" 300 | Out-Null
            Assert-ExistingWorldRuntime $Runtime | Out-Null
            Write-Host "Started canonical Main World API as PID $($process.Id)." -ForegroundColor DarkGray
        } catch {
            Stop-NewSharedWorldProcess $process
            if (Test-Path -LiteralPath $paths.state) { Remove-Item -LiteralPath $paths.state -Force }
            throw
        }
    } finally {
        if ($owned) { $mutex.ReleaseMutex() | Out-Null }
        $mutex.Dispose()
    }
}

function Write-ProcessState {
    param($Runtime, $Paths)
    New-Item -ItemType Directory -Path $Paths.root -Force | Out-Null
    @($StartedProcesses | ForEach-Object {
        [ordered]@{ pid = $_.Id; start_time_utc = $_.StartTime.ToUniversalTime().ToString('o'); worktree = $Runtime.worktree; runtime_id = $Runtime.runtime_id; launcher_pid = $PID }
    }) | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $Paths.processes -Encoding utf8
}

function Stop-RecordedProcesses {
    param($Runtime, $Paths)
    $records = @()
    if (Test-Path -LiteralPath $Paths.processes -PathType Leaf) {
        $records = @(Read-AshAtlasJsonArray $Paths.processes 'runtime process state')
        foreach ($record in $records | Sort-Object pid -Descending) {
            if ([string]$record.runtime_id -ne [string]$Runtime.runtime_id -or
                -not [string]::Equals([string]$record.worktree, [string]$Runtime.worktree, [StringComparison]::OrdinalIgnoreCase)) {
                throw "REFUSED: recorded process state '$($record.runtime_id)' / '$($record.worktree)' does not match selected '$($Runtime.runtime_id)' / '$($Runtime.worktree)'."
            }
            $identity = Assert-AshAtlasRecordedProcessIdentity $record 'launcher-owned process'
            if ($identity.status -eq 'missing') { continue }
            Stop-RecordedProcessTree $identity.process.Id
            Write-Host "Stopped launcher-owned PID $($identity.process.Id)."
        }
    }
    Stop-ExactRuntimePortProcesses $Runtime
    Wait-AshAtlasBoundedCondition `
        -Condition {
            foreach ($record in $records) {
                if ((Assert-AshAtlasRecordedProcessIdentity $record 'launcher-owned process').status -eq 'match') { return $false }
            }
            foreach ($port in @([int]$Runtime.ports.frontend, [int]$Runtime.ports.backend)) {
                if (@(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue).Count -gt 0) { return $false }
            }
            return $true
        } `
        -TimeoutSeconds $RuntimeShutdownWaitSeconds `
        -PollMilliseconds $RuntimePollMilliseconds `
        -TimeoutMessage "Timed out after $RuntimeShutdownWaitSeconds seconds waiting for exact runtime $($Runtime.runtime_id) frontend/backend processes to exit."
    Remove-AshAtlasExpectedRuntimeStateFile $Paths.root $Paths.processes
}

function Stop-ExactRuntimePortProcesses {
    param([Parameter(Mandatory = $true)]$Runtime)
    $escapedWorktree = [regex]::Escape([IO.Path]::GetFullPath([string]$Runtime.worktree).TrimEnd('\'))
    foreach ($port in @([int]$Runtime.ports.frontend, [int]$Runtime.ports.backend)) {
        foreach ($owner in @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) {
            $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($owner.OwningProcess)" -ErrorAction SilentlyContinue
            $runtimeCommandPattern = if ($port -eq [int]$Runtime.ports.frontend) { '(?i)vite(?:\.js)?' } else { '(?i)(tsx|src[\\/]index\.ts)' }
            if ($null -eq $process -or [string]$process.Name -ne 'node.exe' -or
                [string]$process.CommandLine -notmatch $escapedWorktree -or [string]$process.CommandLine -notmatch $runtimeCommandPattern) {
                throw "REFUSED: port $port is owned by a process that does not reference exact worktree $($Runtime.worktree)."
            }
            Stop-RecordedProcessTree ([int]$owner.OwningProcess)
            Write-Host "Stopped exact-worktree port owner PID $($owner.OwningProcess) on $port."
        }
    }
}

function Stop-RecordedProcessTree {
    param([int]$ProcessId)
    $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $ProcessId" -ErrorAction SilentlyContinue)
    foreach ($child in $children) { Stop-RecordedProcessTree ([int]$child.ProcessId) }
    Stop-Process -Id $ProcessId -ErrorAction SilentlyContinue
}

function Stop-OwnedRuntimeContainer {
    param([Parameter(Mandatory = $true)]$Runtime)

    if ($Runtime.mode -ne 'Feature') { return }
    $container = Get-DockerInspection container $Runtime.postgres_container -AllowMissing
    if ($null -eq $container) { return }
    Assert-OwnedDockerResource $container $Runtime 'container'
    if ([bool]$container.State.Running) {
        & docker stop $Runtime.postgres_container | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Could not stop $($Runtime.postgres_container)." }
    }
}

function Request-ExactRuntimeStop {
    param([Parameter(Mandatory = $true)]$Runtime, [Parameter(Mandatory = $true)]$Paths)

    New-Item -ItemType Directory -Path $Paths.root -Force | Out-Null
    $supervisor = Get-RuntimeSupervisorStatus $Runtime $Paths
    if ($supervisor.status -eq 'match' -or (Test-Path -LiteralPath $Paths.processes -PathType Leaf) -or
        (Test-Path -LiteralPath $Paths.ready_signal -PathType Leaf)) {
        [IO.File]::WriteAllText($Paths.stop_signal, (Get-Date).ToUniversalTime().ToString('o'), [Text.Encoding]::ASCII)
    }
    Stop-RecordedProcesses $Runtime $Paths
    Stop-OwnedRuntimeContainer $Runtime
}

function Test-RuntimeQuiescent {
    param([Parameter(Mandatory = $true)]$Runtime, [Parameter(Mandatory = $true)]$Paths, $CapturedSupervisorState = $null)

    if ($null -ne $CapturedSupervisorState) {
        if ([string]$CapturedSupervisorState.runtime_id -ne [string]$Runtime.runtime_id -or
            -not [string]::Equals([string]$CapturedSupervisorState.worktree, [string]$Runtime.worktree, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'REFUSED: captured supervisor belongs to another runtime.'
        }
        if ((Assert-AshAtlasRecordedProcessIdentity $CapturedSupervisorState 'captured runtime supervisor').status -eq 'match') { return $false }
    }

    $supervisor = Get-RuntimeSupervisorStatus $Runtime $Paths
    if ($supervisor.status -eq 'match') { return $false }
    if (Test-Path -LiteralPath $Paths.processes -PathType Leaf) {
        try { $records = @(Read-AshAtlasJsonArray $Paths.processes 'runtime process state') }
        catch { throw "REFUSED: runtime process state is unreadable: $($Paths.processes). $($_.Exception.Message)" }
        foreach ($record in $records) {
            if ([string]$record.runtime_id -ne [string]$Runtime.runtime_id -or
                -not [string]::Equals([string]$record.worktree, [string]$Runtime.worktree, [StringComparison]::OrdinalIgnoreCase)) {
                throw 'REFUSED: stale process state belongs to another runtime.'
            }
            if ((Assert-AshAtlasRecordedProcessIdentity $record 'launcher-owned process').status -eq 'match') { return $false }
        }
    }
    $escapedWorktree = [regex]::Escape([IO.Path]::GetFullPath([string]$Runtime.worktree).TrimEnd('\'))
    foreach ($port in @([int]$Runtime.ports.frontend, [int]$Runtime.ports.backend)) {
        foreach ($owner in @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) {
            $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($owner.OwningProcess)" -ErrorAction SilentlyContinue
            if ($null -eq $process -or [string]$process.Name -ne 'node.exe' -or [string]$process.CommandLine -notmatch $escapedWorktree) {
                throw "REFUSED: port $port remains owned by a process outside exact worktree $($Runtime.worktree)."
            }
            return $false
        }
    }
    if ($Runtime.mode -eq 'Feature') {
        $container = Get-DockerInspection container $Runtime.postgres_container -AllowMissing
        if ($null -ne $container) {
            Assert-OwnedDockerResource $container $Runtime 'container'
            if ([bool]$container.State.Running) { return $false }
        }
    }
    return $true
}

function Complete-RuntimeQuiescence {
    param([Parameter(Mandatory = $true)]$Runtime, [Parameter(Mandatory = $true)]$Paths)

    # The supervisor removes its state in finally before its process releases redirected logs.
    # Keep the verified identity through shutdown even when that state file disappears.
    $capturedSupervisor = Get-RuntimeSupervisorStatus $Runtime $Paths
    Request-ExactRuntimeStop $Runtime $Paths
    Wait-AshAtlasBoundedCondition `
        -Condition { Test-RuntimeQuiescent $Runtime $Paths $capturedSupervisor.state } `
        -TimeoutSeconds $RuntimeShutdownWaitSeconds `
        -PollMilliseconds $RuntimePollMilliseconds `
        -TimeoutMessage "Timed out after $RuntimeShutdownWaitSeconds seconds waiting for exact runtime $($Runtime.runtime_id) to become quiescent. Check $($Paths.supervisor) and run Doctor; no unrelated process was terminated."
    foreach ($path in @($Paths.processes, $Paths.ready_signal, $Paths.stop_signal, $Paths.supervisor)) {
        Remove-AshAtlasExpectedRuntimeStateFile $Paths.root $path
    }
}

function Stop-SelectedRuntime {
    param($Runtime)
    $paths = Get-RuntimeStatePaths $Runtime
    Complete-RuntimeQuiescence $Runtime $paths
    if ($Runtime.mode -eq 'Feature') { Release-AshAtlasFeatureWorldRuntime $Runtime }
    Write-Host "$($Runtime.runtime_id) is stopped." -ForegroundColor Green
}

function Get-FeatureRuntimeParkingCandidates {
    param([string]$CurrentRuntimeId, [string[]]$RunningIds, [object[]]$Leases)

    $stateRoot = Split-Path -Parent (Get-AshAtlasLeasePath)
    $candidates = @($Leases | Where-Object {
        $id = [string]$_.runtime_id
        $id -and $id -ne [string]$Config.main.runtime_id -and $id -ne $CurrentRuntimeId -and $RunningIds -contains $id
    } | ForEach-Object {
        $lease = $_
        $started = $null
        $supervisorPath = Join-Path $stateRoot "runtimes\$($lease.runtime_id)\supervisor.json"
        if (Test-Path -LiteralPath $supervisorPath -PathType Leaf) {
            try {
                $supervisor = Get-Content -Raw -LiteralPath $supervisorPath | ConvertFrom-Json
                if ([string]$supervisor.runtime_id -eq [string]$lease.runtime_id -and
                    [string]::Equals([string]$supervisor.worktree, [string]$lease.worktree, [StringComparison]::OrdinalIgnoreCase)) {
                    $started = ConvertTo-AshAtlasStrictUtcTimestamp (Get-AshAtlasObjectPropertyValue $supervisor 'started_at_utc' $null)
                }
            } catch { }
        }
        if (-not $started) { $started = ConvertTo-AshAtlasStrictUtcTimestamp (Get-AshAtlasObjectPropertyValue $lease 'updated_at_utc' $null) }
        [pscustomobject]@{
            lease = $lease
            started_at_utc = if ($started) { [DateTime]$started } else { [DateTime]::MinValue }
            runtime_id = [string]$lease.runtime_id
        }
    } | Sort-Object started_at_utc, runtime_id)
    return $candidates
}

function Stop-ExcessFeatureRuntimes {
    param([Parameter(Mandatory = $true)]$Runtime, [int]$MaxRunning)

    if ($Runtime.mode -ne 'Feature' -or $MaxRunning -le 0) { return }
    $store = Read-AshAtlasLeaseStore
    $runningIds = Get-RunningAshAtlasRuntimeIds
    $candidates = @(Get-FeatureRuntimeParkingCandidates ([string]$Runtime.runtime_id) $runningIds @($store.runtimes))
    $runningCount = $candidates.Count
    foreach ($candidate in $candidates) {
        if ($runningCount -lt $MaxRunning) { break }
        $lease = $candidate.lease
        $candidateMutex = $null
        try {
            $selected = New-AshAtlasFeatureIdentity $Config ([string]$lease.worktree) ([string]$lease.branch)
            foreach ($field in @('runtime_id', 'compose_project', 'postgres_container', 'network', 'volume', 'database')) {
                if ([string]$selected.$field -cne [string]$lease.$field) { throw "lease identity differs at $field" }
            }
            $selected.ports = $lease.ports
            $worldRuntime = Get-AshAtlasObjectPropertyValue $lease 'world_runtime' $null
            if ($null -ne $worldRuntime) { Add-Member -InputObject $selected -NotePropertyName world_runtime -NotePropertyValue $worldRuntime }
            if (-not (Test-AshAtlasSafeFeatureRuntime $Config $selected)) { throw 'lease overlaps protected Main resources' }
            try {
                $candidateMutex = Enter-AshAtlasRuntimeLifecycleMutex -RuntimeId ([string]$selected.runtime_id) -TimeoutSeconds 0
            } catch {
                if ($_.Exception.Message -notmatch '^Timed out .* waiting for runtime ') { throw }
                # A healthy supervisor owns this mutex for its full session. Its exact stop
                # signal is safe; a competing start or shutdown must be left alone.
                $supervisor = Get-RuntimeSupervisorStatus $selected (Get-RuntimeStatePaths $selected)
                if ($supervisor.status -ne 'match' -or [string]$supervisor.state.phase -ne 'healthy') {
                    throw 'lifecycle mutex is held by another launcher'
                }
            }
            Stop-SelectedRuntime $selected
            $runningCount--
            $display = [string](Get-AshAtlasObjectPropertyValue $lease 'display_name' $lease.runtime_id)
            Write-Host "Parked $display [$($lease.runtime_id)] to stay under the limit of $MaxRunning running feature runtimes. Its launcher will restart it."
        } catch {
            Write-Warning "Could not park feature runtime $($lease.runtime_id): $($_.Exception.Message); continuing the requested launcher."
        } finally {
            if ($null -ne $candidateMutex) { Exit-AshAtlasRuntimeLifecycleMutex $candidateMutex }
        }
    }
}

function Remove-SelectedFeatureRuntime {
    param($Runtime)
    if (-not (Test-AshAtlasSafeFeatureRuntime $Config $Runtime)) { throw '-RemoveFeature refuses Main or an unsafe feature database.' }
    $leaseMutex = Enter-AshAtlasLeaseStoreMutex
    try {
    $path = Get-AshAtlasLeasePath
    for ($validationPass = 0; $validationPass -lt 2; $validationPass++) {
    $store = Read-AshAtlasLeaseStore $path
    $registered = @($store.runtimes | Where-Object { [string]$_.runtime_id -eq [string]$Runtime.runtime_id })
    if ($registered.Count -gt 1) { throw 'REFUSED: multiple leases claim the selected runtime.' }
    if ($registered.Count -eq 1) {
        foreach ($field in @('worktree', 'branch', 'database', 'compose_project', 'postgres_container', 'network', 'volume', 'base_test_generation', 'base_test_sha')) {
            if ([string](Get-AshAtlasObjectPropertyValue $registered[0] $field '') -cne
                [string](Get-AshAtlasObjectPropertyValue $Runtime $field '')) {
                throw "REFUSED: selected runtime lease identity differs at $field."
            }
        }
        $registeredPorts = Get-AshAtlasObjectPropertyValue $registered[0] 'ports' $null
        $selectedPorts = Get-AshAtlasObjectPropertyValue $Runtime 'ports' $null
        $registeredPortsJson = if ($null -eq $registeredPorts) { '' } else { $registeredPorts | ConvertTo-Json -Depth 8 -Compress }
        $selectedPortsJson = if ($null -eq $selectedPorts) { '' } else { $selectedPorts | ConvertTo-Json -Depth 8 -Compress }
        if ($registeredPortsJson -cne $selectedPortsJson) {
            throw 'REFUSED: selected runtime lease identity differs at ports.'
        }
        $registeredWorldRuntime = Get-AshAtlasObjectPropertyValue $registered[0] 'world_runtime' $null
        $selectedWorldRuntime = Get-AshAtlasObjectPropertyValue $Runtime 'world_runtime' $null
        $registeredWorldRuntimeJson = if ($null -eq $registeredWorldRuntime) { '' } else { $registeredWorldRuntime | ConvertTo-Json -Depth 20 -Compress }
        $selectedWorldRuntimeJson = if ($null -eq $selectedWorldRuntime) { '' } else { $selectedWorldRuntime | ConvertTo-Json -Depth 20 -Compress }
        if ($registeredWorldRuntimeJson -cne $selectedWorldRuntimeJson) {
            throw 'REFUSED: selected runtime lease identity differs at world_runtime.'
        }
    }
    if ($registered.Count -eq 1 -and
        [string](Get-AshAtlasObjectPropertyValue $registered[0] 'integration_status' '') -eq 'merged_to_test') {
        $cleanupMarker = Join-Path (Get-RuntimeStatePaths $Runtime).root 'cleanup-in-progress'
        if (-not $AcceptedIntegrationCleanup -or -not (Test-Path -LiteralPath $cleanupMarker -PathType Leaf)) {
            throw 'REFUSED: merged runtime removal requires the ownership-verified integration cleanup marker.'
        }
    }
    $launcherPath = if ($registered.Count -eq 1) { [string](Get-AshAtlasObjectPropertyValue $registered[0] 'launcher_path' '') } else { '' }
    if ($launcherPath -and (Test-Path -LiteralPath $launcherPath) -and
        -not (Test-AshAtlasGeneratedLauncher $launcherPath $Runtime.runtime_id ([string]$Config.feature_launcher_root))) {
        throw "REFUSED: registered launcher is not safely owned: $launcherPath"
    }
    if ($validationPass -eq 1) {
        $currentIdentity = if ($registered.Count -eq 1) {
            $registered[0] | Select-Object * -ExcludeProperty port_claim, updated_at_utc | ConvertTo-Json -Depth 20 -Compress
        } else { '' }
        $currentClaim = if ($registered.Count -eq 1) { Get-AshAtlasObjectPropertyValue $registered[0] 'port_claim' $null } else { $null }
        if ($currentIdentity -cne $retiringIdentity -or
            ($null -ne $currentClaim -and ($currentClaim | ConvertTo-Json -Depth 10 -Compress) -cne $retiringClaim)) {
            throw 'REFUSED: merged runtime lease changed during shutdown.'
        }
        break
    }
    if ($registered.Count -eq 1 -and
        [string](Get-AshAtlasObjectPropertyValue $registered[0] 'integration_status' '') -eq 'merged_to_test') {
        $retiringIdentity = $registered[0] | Select-Object * -ExcludeProperty port_claim, updated_at_utc | ConvertTo-Json -Depth 20 -Compress
        $retiringClaim = Get-AshAtlasObjectPropertyValue $registered[0] 'port_claim' $null | ConvertTo-Json -Depth 10 -Compress
        # Merged status fences startup. Let the exiting supervisor release its
        # port claim, then reread the store before deleting this reservation.
        Exit-AshAtlasLeaseStoreMutex $leaseMutex
        $leaseMutex = $null
        Stop-SelectedRuntime $Runtime
        $leaseMutex = Enter-AshAtlasLeaseStoreMutex
    } else {
        Stop-SelectedRuntime $Runtime
        break
    }
    }
    if ($registered.Count -eq 1) {
        $registeredWorld = Get-AshAtlasObjectPropertyValue $registered[0] 'world_runtime' $null
        if ($null -ne $registeredWorld -and [string]$registeredWorld.group_id) {
            $worldMutex = Enter-AshAtlasWorldRuntimeMutex
            try {
                Remove-AshAtlasWorldGroupMember -GroupId ([string]$registeredWorld.group_id) -RuntimeId ([string]$Runtime.runtime_id) -Registered -Live
            } finally { Exit-AshAtlasWorldRuntimeMutex $worldMutex }
        }
    }
    foreach ($resource in @(
        @{ kind = 'container'; name = $Runtime.postgres_container },
        @{ kind = 'network'; name = $Runtime.network },
        @{ kind = 'volume'; name = $Runtime.volume }
    )) {
        $inspection = Get-DockerInspection $resource.kind $resource.name -AllowMissing
        if ($null -eq $inspection) { continue }
        Assert-OwnedDockerResource $inspection $Runtime $resource.kind
        if ($resource.kind -eq 'container') { & docker rm $resource.name | Out-Null }
        elseif ($resource.kind -eq 'network') { & docker network rm $resource.name | Out-Null }
        else { & docker volume rm $resource.name | Out-Null }
        if ($LASTEXITCODE -ne 0) { throw "Could not remove owned $($resource.kind) $($resource.name)." }
    }
    if ($launcherPath -and (Test-Path -LiteralPath $launcherPath)) { Remove-Item -LiteralPath $launcherPath -Force }
    $store.runtimes = @($store.runtimes | Where-Object { [string]$_.runtime_id -ne [string]$Runtime.runtime_id })
    Write-AshAtlasLeaseStore $store $path
    $statePaths = Get-RuntimeStatePaths $Runtime
    $expectedStateRoot = Join-Path (Split-Path -Parent $path) ("runtimes\" + [string]$Runtime.runtime_id)
    Assert-ExactPath $statePaths.root $expectedStateRoot 'Disposable runtime state root'
    if (Test-Path -LiteralPath $statePaths.root -PathType Container) { Remove-Item -LiteralPath $statePaths.root -Recurse -Force }
    Write-Host "Removed disposable feature runtime $($Runtime.runtime_id)." -ForegroundColor Green
    } finally {
        if ($null -ne $leaseMutex) { Exit-AshAtlasLeaseStoreMutex $leaseMutex }
    }
}

function Show-RuntimeStatus {
    $main = New-AshAtlasMainIdentity $Config
    $store = Read-AshAtlasLeaseStore
    $rows = @([pscustomobject]@{ runtime_id = $main.runtime_id; worktree = $main.worktree; branch = $main.branch; frontend = $main.ports.frontend; backend = $main.ports.backend; world_group = 'Main'; world = $main.ports.world_api; postgres = $main.ports.postgres; database = $main.database; project = $main.compose_project; state = 'stopped' })
    $rows += @($store.runtimes | ForEach-Object {
        $world = Get-AshAtlasObjectPropertyValue $_ 'world_runtime' $null
        [pscustomobject]@{ runtime_id = $_.runtime_id; worktree = $_.worktree; branch = $_.branch; frontend = $_.ports.frontend; backend = $_.ports.backend; world_group = $(if ($null -ne $world) { [string]$world.group_id } else { 'legacy / sync required' }); world = $_.ports.world_api; postgres = $_.ports.postgres; database = $_.database; project = $_.compose_project; state = 'stopped' }
    })
    $runningIds = Get-RunningAshAtlasRuntimeIds
    foreach ($row in $rows) { if ($runningIds -contains [string]$row.runtime_id) { $row.state = 'running' } }
    $rows | Format-Table runtime_id, state, frontend, backend, world_group, world, postgres, database, project, branch, worktree -AutoSize
}

function Show-RuntimeDoctor {
    param($Runtime, [object[]]$StaleLeases = @())
    Write-Host "Ash Atlas Doctor - $($Runtime.runtime_id)" -ForegroundColor Cyan
    $dockerVersion = @(& docker version --format '{{.Server.Version}}' 2>$null)
    Write-Host "Docker daemon: $(if ($LASTEXITCODE -eq 0) { 'available (' + ($dockerVersion -join '') + ')' } else { 'UNAVAILABLE' })"
    Write-Host "Identity:      $($Runtime.mode) / $($Runtime.runtime_id)"
    Write-Host "Worktree:      $($Runtime.worktree)"
    Write-Host "Branch:        $($Runtime.branch)"
    Write-Host "Ports:         frontend=$($Runtime.ports.frontend), backend=$($Runtime.ports.backend), world=$($Runtime.ports.world_api), postgres=$($Runtime.ports.postgres)"
    Write-Host "Compose:       $($Runtime.compose_project)"
    Write-Host "Database:      $($Runtime.database) ($(if ($Runtime.mode -eq 'Main') { 'retained' } else { 'disposable' }))"
    Write-Host "Volume:        $($Runtime.volume)"
    $excluded = Get-AshAtlasExcludedTcpRanges
    $selectedExcluded = @($Runtime.ports.PSObject.Properties.Value | Where-Object { Test-AshAtlasPortExcluded ([int]$_) $excluded })
    Write-Host "Excluded TCP:  $($excluded.Count) ranges; selected conflicts=$($selectedExcluded.Count)"
    $listeners = Get-AshAtlasListeningPorts
    $activeSelected = @($Runtime.ports.PSObject.Properties.Value | Where-Object { $listeners -contains [int]$_ })
    Write-Host "Listeners:     $($activeSelected -join ', ')"
    $mappings = @(Get-AshAtlasDockerPortMappings | Where-Object { $_.port -in @($Runtime.ports.PSObject.Properties.Value) })
    Write-Host "Docker ports:  $(if ($mappings.Count) { ($mappings | ForEach-Object { "$($_.port):$($_.container)" }) -join ', ' } else { 'none' })"
    $container = Get-DockerInspection container $Runtime.postgres_container -AllowMissing
    $containerSummary = 'missing'
    if ($null -ne $container) {
        $health = if ($null -ne $container.State.PSObject.Properties['Health']) { [string]$container.State.Health.Status } else { 'not-configured' }
        $containerSummary = [string]$container.State.Status + ' / health=' + $health
    }
    Write-Host "Container:     $containerSummary"
    $staleCount = ($StaleLeases | Measure-Object).Count
    Write-Host "Stale leases:  $staleCount"
    if ($Runtime.mode -eq 'Main') {
        try { Assert-ExistingWorldRuntime $Runtime | Out-Null; Write-Host 'Main World:     compatible on protected port 8765' -ForegroundColor Green }
        catch { Write-Host "Main World:     unavailable or incompatible - $($_.Exception.Message)" -ForegroundColor Yellow }
    } else {
        $group = Get-AshAtlasWorldGroupStatus $Runtime
        Write-Host "World group:    $($Runtime.world_runtime.group_id)"
        Write-Host "Expected:       $ExpectedMapBranch @ $ExpectedMapSha"
        if ($null -eq $group -or $null -eq $group.state) {
            Write-Host 'Group state:    missing' -ForegroundColor Yellow
        } else {
            Write-Host "Group process:  port=$($group.state.port), pid=$($group.state.pid), compatibility=$($group.compatible)"
            Write-Host "Group members:  registered=$(@($group.state.members_registered) -join ', '); live=$(@($group.state.members_live) -join ', ')"
            if ($null -ne $group.health) {
                Write-Host "Actual:         $($group.health.runtime.branch) @ $($group.health.runtime.sha)"
                Write-Host "Release:        $($group.health.release.release_id) / $($group.health.release_verification.release_manifest_sha256)"
            } else { Write-Host "Group detail:   $($group.message)" -ForegroundColor Yellow }
        }
    }
}

function Invoke-ParallelRuntimePrerequisites {
    param([Parameter(Mandatory = $true)]$Runtime, [Parameter(Mandatory = $true)]$Paths)

    $powerShell = (Get-Process -Id $PID).Path
    $common = @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', $PSCommandPath,
        '-RuntimeMode', [string]$Runtime.mode
    )
    if ($Runtime.mode -eq 'Feature') {
        $claim = Get-AshAtlasObjectPropertyValue $Runtime 'port_claim' $null
        if ($null -eq $claim -or -not (Test-AshAtlasFeaturePortClaimActive $Runtime)) {
            throw 'REFUSED: parallel feature startup requires an active parent port claim.'
        }
        $common += @(
            '-WorktreePath', [string]$Runtime.worktree,
            '-InternalParentRuntimeId', [string]$Runtime.runtime_id,
            '-InternalParentProcessId', [string]$claim.pid,
            '-InternalParentProcessStartTimeUtc', (ConvertTo-AshAtlasCanonicalUtcTimestamp $claim.start_time_utc)
        )
    }
    if ($FullWorldVerify) { $common += '-FullWorldVerify' }
    $workers = @()
    foreach ($name in @('World', 'Postgres')) {
        $stdout = Join-Path $Paths.logs ("prerequisite-{0}.out.log" -f $name.ToLowerInvariant())
        $stderr = Join-Path $Paths.logs ("prerequisite-{0}.err.log" -f $name.ToLowerInvariant())
        $started = Get-Date
        $process = Start-Process -FilePath $powerShell `
            -ArgumentList ((@($common + @('-InternalStartupWorker', $name)) | ForEach-Object {
                ConvertTo-AshAtlasNativeArgument ([string]$_)
            }) -join ' ') `
            -WorkingDirectory $Runtime.worktree -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput $stdout -RedirectStandardError $stderr
        $process.Handle | Out-Null
        $workers += [pscustomobject]@{ name = $name; process = $process; started = $started; stdout = $stdout; stderr = $stderr }
    }
    try {
        while (@($workers | Where-Object { -not $_.process.HasExited }).Count -gt 0) {
            Assert-RuntimeStartupContinues $Paths
            Start-Sleep -Milliseconds $RuntimePollMilliseconds
        }
        $failures = @()
        foreach ($worker in $workers) {
            $worker.process.WaitForExit()
            $worker.process.Refresh()
            $finished = Get-Date
            Set-StartupTiming ("{0}_startup_or_reuse" -f $worker.name.ToLowerInvariant()) $worker.started $finished `
                $(if ($worker.process.ExitCode -eq 0) { 'completed' } else { 'failed' })
            if ($worker.process.ExitCode -ne 0) {
                $detail = if (Test-Path -LiteralPath $worker.stderr) {
                    ([string](Get-Content -Raw -LiteralPath $worker.stderr)).Trim()
                } else { '' }
                if (-not $detail -and (Test-Path -LiteralPath $worker.stdout)) {
                    $detail = ([string](Get-Content -Raw -LiteralPath $worker.stdout)).Trim()
                }
                $failures += "$($worker.name) prerequisite failed with exit code $($worker.process.ExitCode): $detail"
            }
        }
        if ($failures.Count -gt 0) { throw ($failures -join [Environment]::NewLine) }
    } finally {
        foreach ($worker in $workers) {
            if (-not $worker.process.HasExited) {
                Stop-Process -Id $worker.process.Id -Force -ErrorAction SilentlyContinue
            }
            $worker.process.Dispose()
        }
    }
}

function Wait-ParallelApplicationReadiness {
    param(
        [Parameter(Mandatory = $true)]$Runtime,
        [Parameter(Mandatory = $true)]$Paths,
        [Parameter(Mandatory = $true)][string]$BackendUrl,
        [Parameter(Mandatory = $true)][string]$FrontendUrl,
        [Parameter(Mandatory = $true)][string]$GameSha
    )

    $started = Get-Date
    $probe = {
        param($Kind, $Uri, $StopSignal)
        $deadline = (Get-Date).AddSeconds(90)
        while ((Get-Date) -lt $deadline) {
            if (Test-Path -LiteralPath $StopSignal -PathType Leaf) { throw 'Runtime startup was superseded while waiting for readiness.' }
            try {
                if ($Kind -eq 'frontend') {
                    $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 3
                    if ([int]$response.StatusCode -eq 200) { return '{"status":200}' }
                } else {
                    return (Invoke-RestMethod -Uri $Uri -TimeoutSec 3 | ConvertTo-Json -Depth 12 -Compress)
                }
            } catch { }
            Start-Sleep -Milliseconds 500
        }
        throw "Timed out waiting for $Uri"
    }
    $jobs = @(
        Start-Job -ScriptBlock $probe -ArgumentList 'health', "$BackendUrl/health", $Paths.stop_signal
        Start-Job -ScriptBlock $probe -ArgumentList 'ready', "$BackendUrl/ready", $Paths.stop_signal
        Start-Job -ScriptBlock $probe -ArgumentList 'frontend', $FrontendUrl, $Paths.stop_signal
    )
    try {
        Wait-Job -Job $jobs | Out-Null
        $failures = @($jobs | Where-Object State -ne 'Completed')
        if ($failures.Count -gt 0) {
            throw "Readiness probes failed: $(@($failures | ForEach-Object { $_.JobStateInfo.Reason.Message }) -join '; ')"
        }
        $health = (Receive-Job -Job $jobs[0] -ErrorAction Stop) | ConvertFrom-Json
        $ready = (Receive-Job -Job $jobs[1] -ErrorAction Stop) | ConvertFrom-Json
        $frontend = (Receive-Job -Job $jobs[2] -ErrorAction Stop) | ConvertFrom-Json
        if ($health.runtime.label -ne $Runtime.runtime_id -or $health.runtime.branch -ne $Runtime.branch -or $health.runtime.sha -ne $GameSha) {
            throw 'Backend runtime identity mismatch.'
        }
        if ($ready.ok -ne $true -or $ready.checks.database.ok -ne $true -or $ready.checks.worldAuthority.ok -ne $true) {
            throw 'Backend readiness did not verify database and World API authority.'
        }
        if ([int]$frontend.status -ne 200) { throw 'Frontend readiness did not return HTTP 200.' }
        Set-StartupTiming 'final_readiness' $started
    } finally {
        $jobs | Remove-Job -Force -ErrorAction SilentlyContinue
    }
}

function Start-SelectedRuntime {
    param($Runtime)
    foreach ($command in @('git', 'docker', 'node', 'pnpm')) { if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "$command was not found on PATH." } }
    $paths = Get-RuntimeStatePaths $Runtime
    New-Item -ItemType Directory -Path $paths.root -Force | Out-Null
    New-Item -ItemType Directory -Path $paths.logs -Force | Out-Null
    $gameSha = Get-AshAtlasGitValue $Runtime.worktree @('rev-parse', 'HEAD')
    if (Invoke-HealthyRuntimeReuse $Runtime $paths $gameSha) {
        Set-StartupTiming 'final_readiness' $StartupTimingOrigin (Get-Date) 'reused exact healthy runtime'
        Write-StartupTimingReport $paths 'reused'
        return
    }
    $mutexHandle = $null
    $capacityMutex = $null
    $capacityOwned = $false
    $ownsRuntime = $false
    $worldMembershipAttached = $false
    try {
        $mutexHandle = Enter-AshAtlasRuntimeLifecycleMutex `
            -RuntimeId ([string]$Runtime.runtime_id) `
            -TimeoutSeconds $RuntimeMutexWaitSeconds `
            -PollMilliseconds $RuntimePollMilliseconds `
            -OnWait { Request-ExactRuntimeStop $Runtime $paths }
        if ($mutexHandle.abandoned) { Write-Host 'Recovered an abandoned exact-runtime lifecycle mutex.' -ForegroundColor Yellow }
        $gameSha = Get-AshAtlasGitValue $Runtime.worktree @('rev-parse', 'HEAD')
        if (Invoke-HealthyRuntimeReuse $Runtime $paths $gameSha) {
            Set-StartupTiming 'final_readiness' $StartupTimingOrigin (Get-Date) 'reused exact healthy runtime after lifecycle lock'
            Write-StartupTimingReport $paths 'reused'
            return
        }
        if ($Runtime.mode -eq 'Feature') {
            $maxRunning = [int](Get-AshAtlasObjectPropertyValue $Config.feature.lifecycle 'max_running_features' 0)
            if ($maxRunning -gt 0) {
                $capacityMutex = [Threading.Mutex]::new($false, 'Global\AshAtlas_DevFeatureRuntimeCapacity')
                try { $capacityOwned = $capacityMutex.WaitOne([TimeSpan]::FromSeconds($RuntimeMutexWaitSeconds)) }
                catch [Threading.AbandonedMutexException] { $capacityOwned = $true }
                if (-not $capacityOwned) {
                    $capacityMutex.Dispose()
                    $capacityMutex = $null
                    Write-Warning 'Feature capacity lock is busy; continuing the requested launcher without parking.'
                } else {
                    Stop-ExcessFeatureRuntimes $Runtime $maxRunning
                }
            }
        }
        Complete-RuntimeQuiescence $Runtime $paths
        if ($Runtime.mode -eq 'Feature') {
            $Runtime = (Resolve-FeaturePortsAndLease $Runtime -Persist -PreserveExistingPorts).runtime
        }
        Write-RuntimeSupervisorState $Runtime $paths $gameSha 'starting'
        if ($null -ne $capacityMutex) {
            $capacityMutex.ReleaseMutex() | Out-Null
            $capacityOwned = $false
            $capacityMutex.Dispose()
            $capacityMutex = $null
        }
        $ownsRuntime = $true
        Assert-RuntimeStartupContinues $paths
        Assert-RequiredPortFree $Runtime.ports.frontend 'Frontend'
        Assert-RequiredPortFree $Runtime.ports.backend 'Backend'
        if ($Runtime.mode -eq 'Feature') {
            # Cleanup may safely release an absent membership, and must release one created before
            # a concurrent PostgreSQL failure is observed.
            $worldMembershipAttached = $true
        }
        Invoke-ParallelRuntimePrerequisites $Runtime $paths
        Assert-RuntimeStartupContinues $paths
        if ($Runtime.mode -eq 'Feature') { Ensure-FeatureTelemetryExporterRole $Runtime }
        Assert-RuntimeStartupContinues $paths
        $frontendUrl = "http://127.0.0.1:$($Runtime.ports.frontend)"
        $backendUrl = "http://127.0.0.1:$($Runtime.ports.backend)"
        $worldUrl = "http://127.0.0.1:$($Runtime.ports.world_api)"
        $databaseUrl = "postgres://$($Runtime.database_user):$($Runtime.database_password)@127.0.0.1:$($Runtime.ports.postgres)/$($Runtime.database)"
        $lanAddresses = if ($Mobile) { @(& (Join-Path $Runtime.worktree 'scripts\get-private-lan-ip.ps1')) } else { @() }
        $allowedOrigins = (@($frontendUrl) + @($lanAddresses | ForEach-Object { "http://$($_):$($Runtime.ports.frontend)" }) | Select-Object -Unique) -join ','

        $env:NODE_ENV = "development"
        $env:AUTH_RUNTIME_MODE = 'local'
        $env:AUTH_MODE = 'dev'
        $env:AUTH_DEV_LOGIN_ENABLED = 'true'
        $env:DEV_ADMIN_TOOLS_ENABLED = 'true'
        $env:DEV_AUTHORIZED_GOOGLE_SUBJECTS = 'ash-atlas-dev:developer@example.com'
        $env:RUNTIME_LABEL = [string]$Runtime.runtime_id
        $env:RUNTIME_BRANCH = [string]$Runtime.branch
        $env:RUNTIME_SHA = $gameSha
        $env:PORT = [string]$Runtime.ports.backend
        $env:CLIENT_ORIGIN = $frontendUrl
        $env:APP_PUBLIC_ORIGIN = $frontendUrl
        $env:AUTH_ALLOWED_ORIGINS = $allowedOrigins
        $env:DATABASE_URL = $databaseUrl
        $env:MARKET_GLOBAL_ACCESS = 'true'
        $env:PLAYER_SPEED_MPS = "$PlayerSpeedMps"
        $env:SERVER_TICK_HZ = "$ServerTickHz"
        $env:WORLD_DELTA_HZ = "$WorldDeltaHz"
        $env:COMBAT_DELTA_HZ = [string]$CombatDeltaHz
        $env:WORLD_API_BASE = $worldUrl
        $env:WORLD_REQUIRED_RELEASE_ID = $ExpectedReleaseId
        $env:WORLD_REQUIRED_PROFILE_SET_FINGERPRINT = $ExpectedProfileFingerprint
        $env:WORLD_REQUIRED_BUILD_CONTRACT_FINGERPRINT = $ExpectedContractFingerprint
        $env:WORLD_REQUIRED_BOUNDARY_RELEASE_ID = $ExpectedBoundaryReleaseId
        $env:WORLD_LOOKUP_TIMEOUT_MS = '5000'
        $env:ALLOW_DEGRADED_WORLD_LOOKUPS_IN_DEV = 'false'
        $env:ALLOW_UNRESOLVED_FLAGS_IN_DEV = 'false'
        $env:REGION_CODE = 'GLOBAL'
        $env:ASH_ATLAS_FRONTEND_PORT = [string]$Runtime.ports.frontend
        $env:ASH_ATLAS_GAME_SERVER_TARGET = $backendUrl
        $env:ASH_ATLAS_WORLD_API_TARGET = $worldUrl
        $env:ASH_ATLAS_WATER_VISUAL_TILES_PATH = $WaterVisualTilesArtifactPath
        $env:VITE_RUNTIME_LABEL = [string]$Runtime.runtime_id
        $env:VITE_RUNTIME_BRANCH = [string]$Runtime.branch
        $env:VITE_RUNTIME_SHA = $gameSha

        $migrationStarted = Get-Date
        Invoke-RuntimeMigrations $Runtime $paths
        Set-StartupTiming 'migrations' $migrationStarted
        Assert-RuntimeStartupContinues $paths
        $powerShell = (Get-Process -Id $PID).Path
        $serverCommand = @"
${childDollar}Host.UI.RawUI.WindowTitle = 'Ash Atlas $($Runtime.runtime_id) Backend'
Set-Location -LiteralPath '$($Runtime.worktree)'
${childDollar}env:NODE_ENV = 'development'
${childDollar}env:AUTH_RUNTIME_MODE = 'local'
${childDollar}env:AUTH_MODE = 'dev'
${childDollar}env:AUTH_DEV_LOGIN_ENABLED = 'true'
${childDollar}env:DEV_ADMIN_TOOLS_ENABLED = 'true'
${childDollar}env:DEV_AUTHORIZED_GOOGLE_SUBJECTS = 'ash-atlas-dev:developer@example.com'
${childDollar}env:RUNTIME_LABEL = '$($Runtime.runtime_id)'
${childDollar}env:RUNTIME_BRANCH = '$($Runtime.branch)'
${childDollar}env:RUNTIME_SHA = '$gameSha'
${childDollar}env:PORT = '$($Runtime.ports.backend)'
${childDollar}env:CLIENT_ORIGIN = '$frontendUrl'
${childDollar}env:APP_PUBLIC_ORIGIN = '$frontendUrl'
${childDollar}env:AUTH_ALLOWED_ORIGINS = '$allowedOrigins'
${childDollar}env:DATABASE_URL = '$databaseUrl'
${childDollar}env:MARKET_GLOBAL_ACCESS = 'true'
${childDollar}env:PLAYER_SPEED_MPS = '$PlayerSpeedMps'
${childDollar}env:SERVER_TICK_HZ = '$ServerTickHz'
${childDollar}env:WORLD_DELTA_HZ = '$WorldDeltaHz'
${childDollar}env:COMBAT_DELTA_HZ = '$CombatDeltaHz'
${childDollar}env:WORLD_API_BASE = '$worldUrl'
${childDollar}env:WORLD_REQUIRED_RELEASE_ID = '$ExpectedReleaseId'
${childDollar}env:WORLD_REQUIRED_PROFILE_SET_FINGERPRINT = '$ExpectedProfileFingerprint'
${childDollar}env:WORLD_REQUIRED_BUILD_CONTRACT_FINGERPRINT = '$ExpectedContractFingerprint'
${childDollar}env:WORLD_REQUIRED_BOUNDARY_RELEASE_ID = '$ExpectedBoundaryReleaseId'
${childDollar}env:WORLD_LOOKUP_TIMEOUT_MS = '5000'
${childDollar}env:ALLOW_DEGRADED_WORLD_LOOKUPS_IN_DEV = 'false'
${childDollar}env:ALLOW_UNRESOLVED_FLAGS_IN_DEV = 'false'
${childDollar}env:REGION_CODE = 'GLOBAL'
pnpm dev:server
"@
        $clientCommand = @"
${childDollar}Host.UI.RawUI.WindowTitle = 'Ash Atlas $($Runtime.runtime_id) Frontend'
Set-Location -LiteralPath '$($Runtime.worktree)\apps\client'
${childDollar}env:ASH_ATLAS_FRONTEND_PORT = '$($Runtime.ports.frontend)'
${childDollar}env:ASH_ATLAS_GAME_SERVER_TARGET = '$backendUrl'
${childDollar}env:ASH_ATLAS_WORLD_API_TARGET = '$worldUrl'
${childDollar}env:ASH_ATLAS_WATER_VISUAL_TILES_PATH = '$WaterVisualTilesArtifactPath'
${childDollar}env:VITE_RUNTIME_LABEL = '$($Runtime.runtime_id)'
${childDollar}env:VITE_RUNTIME_BRANCH = '$($Runtime.branch)'
${childDollar}env:VITE_RUNTIME_SHA = '$gameSha'
${childDollar}env:CI = 'true'
node '$($Runtime.worktree)\apps\client\node_modules\vite\bin\vite.js' --strictPort --configLoader runner
"@
        $backendStarted = Get-Date
        Start-LoggedProcess $powerShell @('-NoProfile', '-Command', $serverCommand) $Runtime.worktree 'backend' $paths $Runtime | Out-Null
        Set-StartupTiming 'backend_startup' $backendStarted
        $frontendStarted = Get-Date
        Start-LoggedProcess $powerShell @('-NoProfile', '-Command', $clientCommand) (Join-Path $Runtime.worktree 'apps\client') 'frontend' $paths $Runtime | Out-Null
        Set-StartupTiming 'frontend_startup' $frontendStarted
        Write-ProcessState $Runtime $paths
        Assert-RuntimeStartupContinues $paths
        Wait-ParallelApplicationReadiness $Runtime $paths $backendUrl $frontendUrl $gameSha
        Assert-RuntimeStartupContinues $paths
        Write-Host "Ash Atlas $($Runtime.runtime_id) is ready." -ForegroundColor Green
        Write-Host "Frontend: $frontendUrl"
        Write-Host "Backend:  $backendUrl"
        Write-Host "World API: $worldUrl $(if ($Runtime.mode -eq 'Feature') { '(group ' + $Runtime.world_runtime.group_id + ')' } else { '(Main)' })"
        Write-Host "Database: $($Runtime.database) on $($Runtime.ports.postgres)"
        [IO.File]::WriteAllText($paths.ready_signal, (Get-Date).ToUniversalTime().ToString('o'), [Text.Encoding]::ASCII)
        Write-RuntimeSupervisorState $Runtime $paths $gameSha 'healthy'
        Write-StartupTimingReport $paths 'healthy'
        Open-AshAtlasRuntimeFrontend $frontendUrl -NoBrowser:$NoBrowser | Out-Null
        Wait-RuntimeStopRequest $paths
    } catch [System.OperationCanceledException] {
        Write-Host $_.Exception.Message -ForegroundColor Yellow
        try { Write-StartupTimingReport $paths 'cancelled' } catch { }
    } catch {
        try { Write-StartupTimingReport $paths 'failed' } catch { }
        throw
    } finally {
        if ($null -ne $capacityMutex) {
            if ($capacityOwned) { $capacityMutex.ReleaseMutex() | Out-Null }
            $capacityMutex.Dispose()
        }
        if ($ownsRuntime) {
            try { Write-RuntimeSupervisorState $Runtime $paths $gameSha 'stopping' } catch { Write-Warning $_.Exception.Message }
            try { Stop-RecordedProcesses $Runtime $paths } catch { Write-Warning $_.Exception.Message }
            try { Stop-OwnedRuntimeContainer $Runtime } catch { Write-Warning $_.Exception.Message }
            if ($Runtime.mode -eq 'Feature' -and $worldMembershipAttached) {
                try { Release-AshAtlasFeatureWorldRuntime $Runtime } catch { Write-Warning $_.Exception.Message }
            }
            Remove-AshAtlasExpectedRuntimeStateFile $paths.root $paths.ready_signal
            Remove-AshAtlasExpectedRuntimeStateFile $paths.root $paths.stop_signal
            try { Remove-CurrentRuntimeSupervisorState $Runtime $paths } catch { Write-Warning $_.Exception.Message }
        }
        if ($null -ne $mutexHandle) { Exit-AshAtlasRuntimeLifecycleMutex $mutexHandle }
    }
}

$actions = @(@($Doctor, $Status, $RepairPostgres, $Stop, $RemoveFeature, $ValidateOnly) | Where-Object { $_ })
if ($actions.Count -gt 1) { throw 'Choose only one action: Doctor, Status, RepairPostgres, Stop, RemoveFeature, or ValidateOnly.' }
if ($InternalStartupWorker -and $actions.Count -gt 0) { throw '-InternalStartupWorker cannot be combined with a public launcher action.' }
if (-not $InternalStartupWorker -and ($InternalParentRuntimeId -or $InternalParentProcessId -or $InternalParentProcessStartTimeUtc)) {
    throw 'Internal parent identity is valid only with -InternalStartupWorker.'
}
if ($AcceptedIntegrationCleanup -and -not $RemoveFeature) { throw '-AcceptedIntegrationCleanup is valid only with -RemoveFeature.' }
if ($Status) { Show-RuntimeStatus; exit 0 }

$selection = $null
$leaseResolutionStarted = Get-Date
$runtime = Resolve-SelectedRuntime
if ($runtime.mode -eq 'Feature') {
    if (-not (Test-AshAtlasSafeFeatureRuntime $Config $runtime)) { throw 'REFUSED: Feature runtime overlaps protected Main database resources.' }
    Clear-AshAtlasInheritedFeatureDatabaseEnvironment $runtime
}
if ($AcceptedIntegrationCleanup) {
    $runtime = Resolve-AcceptedIntegrationCleanupRuntime $runtime
} else {
    Set-WorldRuntimePolicy $runtime
    if ($runtime.mode -eq 'Feature') {
        if ($InternalStartupWorker) {
            $runtime = Resolve-FeatureInternalWorkerLease $runtime $InternalParentRuntimeId $InternalParentProcessId $InternalParentProcessStartTimeUtc
        } else {
            $selection = Resolve-FeaturePortsAndLease $runtime `
                -Persist:(-not ($Doctor -or $ValidateOnly -or $Stop -or $RemoveFeature)) `
                -PreserveExistingPorts:($Doctor -or $ValidateOnly -or $Stop -or $RemoveFeature)
            $runtime = $selection.runtime
        }
    }
}
Set-StartupTiming 'lease_and_port_resolution' $leaseResolutionStarted

if ($InternalStartupWorker) {
    if ($InternalStartupWorker -eq 'World') {
        if ($runtime.mode -eq 'Feature') {
            Ensure-AshAtlasFeatureWorldRuntime $Config $runtime -FullWorldVerify:$FullWorldVerify | Out-Null
            Assert-ExistingWorldRuntime $runtime | Out-Null
        } else {
            Ensure-MainWorldRuntime $runtime -FullWorldVerify:$FullWorldVerify
        }
    } else {
        Ensure-RuntimePostgres $runtime
    }
    exit 0
}

if ($Doctor) {
    $stale = if ($null -ne $selection) { $selection.stale } else {
        $store = Read-AshAtlasLeaseStore
        @(Get-AshAtlasStaleLeases @($store.runtimes) (Get-ExistingLeaseWorktrees @($store.runtimes)) (Get-ActiveAshAtlasRuntimeIds))
    }
    Show-RuntimeDoctor $runtime $stale
    exit 0
}
if ($RepairPostgres) { Repair-MainPostgres $runtime; exit 0 }
if ($Stop) { Stop-SelectedRuntime $runtime; exit 0 }
if ($RemoveFeature) { Remove-SelectedFeatureRuntime $runtime; exit 0 }
if ($ValidateOnly) {
    Assert-RequiredPortFree $runtime.ports.frontend 'Frontend'
    Assert-RequiredPortFree $runtime.ports.backend 'Backend'
    $worldOwners = @(Get-NetTCPConnection -LocalPort $runtime.ports.world_api -State Listen -ErrorAction SilentlyContinue)
    if ($worldOwners.Count -gt 0) {
        if ($runtime.mode -eq 'Main') { Assert-ExistingWorldRuntime $runtime | Out-Null }
        else {
            $groupStatus = Get-AshAtlasWorldGroupStatus $runtime
            if ($null -eq $groupStatus -or $groupStatus.compatible -ne $true) { throw "Feature World API group is not compatible: $($groupStatus.message)" }
        }
    }
    [ordered]@{
        ok = $true
        runtime_id = $runtime.runtime_id
        mode = $runtime.mode
        worktree = $runtime.worktree
        branch = $runtime.branch
        ports = $runtime.ports
        database = $runtime.database
        compose_project = $runtime.compose_project
        world_group_id = $(if ($runtime.mode -eq 'Feature') { [string]$runtime.world_runtime.group_id } else { 'Main' })
        retained_database_mutated = $false
        processes_started = $false
    } | ConvertTo-Json -Depth 5
    exit 0
}

try {
    Start-SelectedRuntime $runtime
} finally {
    if ($runtime.mode -eq 'Feature') {
        try { Release-FeaturePortClaim $runtime } catch { Write-Warning "Feature port release failed: $($_.Exception.Message)" }
    }
}
