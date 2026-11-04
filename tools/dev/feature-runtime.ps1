[CmdletBinding()]
param(
    [Parameter(Position = 0, Mandatory = $true)]
    [ValidateSet('create', 'sync', 'status', 'ready', 'park', 'mark-merged', 'remove', 'cleanup')]
    [string]$Operation,
    [string]$WorktreePath,
    [string]$DisplayName,
    [string]$IntegratedRef,
    [ValidatePattern('^t\d{3,4}$')][string]$MergedTestGeneration,
    [ValidatePattern('^[0-9a-fA-F]{40}$')][string]$MergedTestSha,
    [ValidatePattern('^t\d{3,4}$')][string]$EffectiveBaseTestGeneration,
    [ValidatePattern('^[0-9a-fA-F]{40}$')][string]$EffectiveBaseTestSha,
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')][string]$BatchOperationId,
    [switch]$ConfirmAcceptedIntegration
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$SupervisorRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')).TrimEnd('\')
. (Join-Path $PSScriptRoot 'runtime-lib.ps1')
$Config = Read-AshAtlasRuntimeDefaults (Join-Path $SupervisorRoot 'config\dev-runtime.defaults.json')
$LauncherRoot = [IO.Path]::GetFullPath([string]$Config.feature_launcher_root).TrimEnd('\')
$MergedLauncherRoot = Join-Path $LauncherRoot 'Merged'
$LeasePath = Get-AshAtlasLeasePath

function Assert-ExactPath([string]$Actual, [string]$Expected, [string]$Label) {
    if (-not [string]::Equals([IO.Path]::GetFullPath($Actual).TrimEnd('\'), [IO.Path]::GetFullPath($Expected).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label must be '$Expected', not '$Actual'."
    }
}

function Resolve-FeatureWorktree([string]$Path) {
    if (-not $Path) { throw '-WorktreePath is required for this operation.' }
    $root = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw "Feature worktree is missing: $root" }
    Assert-ExactPath (Get-AshAtlasGitValue $root @('rev-parse', '--show-toplevel')) $root 'Feature worktree'
    $branch = Get-AshAtlasGitValue $root @('branch', '--show-current')
    if (-not $branch) { throw 'Feature runtime refuses a detached worktree.' }
    return New-AshAtlasFeatureIdentity $Config $root $branch
}

function Find-RegisteredLease([string]$Path) {
    if (-not $Path) { throw '-WorktreePath is required for this operation.' }
    $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $store = Read-AshAtlasLeaseStore $LeasePath
    $matches = @($store.runtimes | Where-Object {
        [string]::Equals([IO.Path]::GetFullPath([string]$_.worktree).TrimEnd('\'), $fullPath, [StringComparison]::OrdinalIgnoreCase)
    })
    if ($matches.Count -ne 1) { throw "No single registered feature runtime exists for $fullPath. Run feature-runtime.ps1 create first." }
    return [pscustomobject]@{ store = $store; lease = $matches[0] }
}

function Find-OptionalRegisteredLease([string]$Path) {
    if (-not $Path) { throw '-WorktreePath is required for this operation.' }
    $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $store = Read-AshAtlasLeaseStore $LeasePath
    $matches = @($store.runtimes | Where-Object {
        [string]::Equals([IO.Path]::GetFullPath([string]$_.worktree).TrimEnd('\'), $fullPath, [StringComparison]::OrdinalIgnoreCase)
    })
    if ($matches.Count -gt 1) { throw "REFUSED: multiple runtime leases claim $fullPath." }
    if ($matches.Count -eq 0) { return $null }
    return [pscustomobject]@{ store = $store; lease = $matches[0] }
}

function Convert-LeaseToRuntime($Lease) {
    $runtime = [pscustomobject][ordered]@{
        runtime_id = [string]$Lease.runtime_id
        mode = 'Feature'
        worktree = [string]$Lease.worktree
        branch = [string]$Lease.branch
        compose_project = [string]$Lease.compose_project
        postgres_container = [string]$Lease.postgres_container
        network = [string]$Lease.network
        volume = [string]$Lease.volume
        database = [string]$Lease.database
        database_user = [string]$Config.main.database.user
        database_password = [string]$Config.main.database.password
        ports = $Lease.ports
    }
    $worldRuntime = Get-AshAtlasObjectPropertyValue $Lease 'world_runtime' $null
    if ($null -ne $worldRuntime) { Add-Member -InputObject $runtime -NotePropertyName world_runtime -NotePropertyValue $worldRuntime }
    $baseGeneration = [string](Get-AshAtlasObjectPropertyValue $Lease 'base_test_generation' '')
    $baseSha = [string](Get-AshAtlasObjectPropertyValue $Lease 'base_test_sha' '')
    if ($baseGeneration) {
        Add-Member -InputObject $runtime -NotePropertyName base_test_generation -NotePropertyValue $baseGeneration
        Add-Member -InputObject $runtime -NotePropertyName base_test_sha -NotePropertyValue $baseSha
    }
    $integrationStatus = [string](Get-AshAtlasObjectPropertyValue $Lease 'integration_status' '')
    if ($integrationStatus) {
        foreach ($name in @('integration_status', 'merged_test_generation', 'merged_test_sha', 'merged_at_utc', 'merged_launcher_path')) {
            Add-Member -InputObject $runtime -NotePropertyName $name -NotePropertyValue ([string](Get-AshAtlasObjectPropertyValue $Lease $name ''))
        }
    }
    return $runtime
}

function Get-LiveOwnedProcessRecords($Lease) {
    $statePath = Join-Path (Split-Path -Parent $LeasePath) ("runtimes\$($Lease.runtime_id)\owned-processes.json")
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { return @() }
    $records = @(Read-AshAtlasJsonArray $statePath 'runtime process state')
    $live = @()
    foreach ($record in $records) {
        if ([string]$record.runtime_id -ne [string]$Lease.runtime_id -or
            -not [string]::Equals([string]$record.worktree, [string]$Lease.worktree, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'REFUSED: launcher process state belongs to another runtime or worktree.'
        }
        if ((Get-AshAtlasRecordedProcessStatus $record).status -ne 'match') { continue }
        $live += $record
    }
    return $live
}

function Test-LiveOwnedSupervisor($Lease) {
    $statePath = Join-Path (Split-Path -Parent $LeasePath) ("runtimes\$($Lease.runtime_id)\supervisor.json")
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { return $false }
    try {
        $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
        if ([string]$state.runtime_id -ne [string]$Lease.runtime_id -or
            -not [string]::Equals([string]$state.worktree, [string]$Lease.worktree, [StringComparison]::OrdinalIgnoreCase)) { return $false }
        return (Get-AshAtlasRecordedProcessStatus $state).status -eq 'match'
    } catch { return $false }
}

function Get-DockerInspectionSafe([string]$Kind, [string]$Name) {
    $previous = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'SilentlyContinue'
        $raw = @(& docker $Kind inspect $Name 2>$null)
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    if ($exitCode -ne 0) { return $null }
    return @($raw | ConvertFrom-Json)[0]
}

function Assert-FeatureResourceOwnership($Lease) {
    $runtime = Convert-LeaseToRuntime $Lease
    if (-not (Test-AshAtlasSafeFeatureRuntime $Config $runtime)) { throw 'REFUSED: registered runtime could touch the retained Main database.' }
    foreach ($mainIdentity in @($Config.main.postgres_container, $Config.main.database.volume, $Config.main.compose_project, $Config.main.network)) {
        if ($runtime.postgres_container -eq $mainIdentity -or $runtime.volume -eq $mainIdentity -or $runtime.compose_project -eq $mainIdentity -or $runtime.network -eq $mainIdentity) {
            throw 'REFUSED: feature resource identity overlaps protected Main.'
        }
    }
    foreach ($resource in @(
        @{ kind = 'container'; name = [string]$runtime.postgres_container },
        @{ kind = 'network'; name = [string]$runtime.network },
        @{ kind = 'volume'; name = [string]$runtime.volume }
    )) {
        $inspection = Get-DockerInspectionSafe $resource.kind $resource.name
        if ($null -eq $inspection) { continue }
        $configProperty = $inspection.PSObject.Properties['Config']
        $labels = if ($null -ne $configProperty) { $configProperty.Value.Labels } else { $inspection.Labels }
        if ([string](Get-AshAtlasObjectPropertyValue $labels 'com.ash-atlas.owner' '') -ne [string]$Config.owner_label -or
            [string](Get-AshAtlasObjectPropertyValue $labels 'com.ash-atlas.runtime-id' '') -ne [string]$runtime.runtime_id) {
            throw "REFUSED: Docker $($resource.kind) '$($resource.name)' is not owned by this exact feature."
        }
    }
    $projectContainers = @(& docker ps -a --filter "label=com.docker.compose.project=$($runtime.compose_project)" --format '{{.Names}}')
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the feature Compose project.' }
    foreach ($containerName in $projectContainers) {
        if ([string]$containerName -ne [string]$runtime.postgres_container) {
            throw "REFUSED: Compose project contains unexpected container '$containerName'."
        }
    }
}

function Assert-NoUnregisteredFeatureRuntimeArtifacts($Runtime) {
    if (-not (Test-AshAtlasSafeFeatureRuntime $Config $Runtime)) {
        throw 'REFUSED: unregistered worktree derives an unsafe feature runtime identity.'
    }
    foreach ($resource in @(
        @{ kind = 'container'; name = [string]$Runtime.postgres_container },
        @{ kind = 'network'; name = [string]$Runtime.network },
        @{ kind = 'volume'; name = [string]$Runtime.volume }
    )) {
        if ($null -ne (Get-DockerInspectionSafe $resource.kind $resource.name)) {
            throw "REFUSED: unregistered worktree still has Docker $($resource.kind) '$($resource.name)'; register or inspect it before cleanup."
        }
    }
    $projectContainers = @(& docker ps -a --filter "label=com.docker.compose.project=$($Runtime.compose_project)" --format '{{.Names}}')
    if ($LASTEXITCODE -ne 0) { throw 'Could not prove the unregistered worktree has no Docker resources.' }
    if ($projectContainers.Count -gt 0) {
        throw "REFUSED: unregistered worktree still has Compose resources: $($projectContainers -join ', ')."
    }
    if (Test-Path -LiteralPath $LauncherRoot -PathType Container) {
        foreach ($launcher in @(Get-ChildItem -LiteralPath $LauncherRoot -Filter '*.cmd' -File -Recurse -ErrorAction SilentlyContinue)) {
            $content = Get-Content -Raw -LiteralPath $launcher.FullName
            if ($content -match [regex]::Escape([string]$Runtime.worktree) -or $content -match [regex]::Escape([string]$Runtime.runtime_id)) {
                throw "REFUSED: unregistered worktree still has generated launcher '$($launcher.FullName)'."
            }
        }
    }
    $runtimeRoot = Join-Path (Split-Path -Parent $LeasePath) ("runtimes\" + [string]$Runtime.runtime_id)
    if (Test-Path -LiteralPath $runtimeRoot) {
        throw "REFUSED: unregistered worktree still has runtime state at '$runtimeRoot'."
    }
    foreach ($state in @(Get-AshAtlasWorldGroupStates)) {
        if (@($state.members_registered) -contains [string]$Runtime.runtime_id -or
            @($state.members_live) -contains [string]$Runtime.runtime_id) {
            throw "REFUSED: unregistered worktree runtime remains a member of World group $($state.group_id)."
        }
    }
}

function Write-GeneratedLauncher($Runtime, [string]$Name, [string]$Path) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force | Out-Null
    if (Test-Path -LiteralPath $Path) {
        if (-not (Test-AshAtlasGeneratedLauncher $Path $Runtime.runtime_id $LauncherRoot)) {
            throw "REFUSED: launcher path already contains a file not owned by runtime $($Runtime.runtime_id): $Path"
        }
    }
    $content = New-AshAtlasFeatureLauncherContent $Config $Runtime $Name $SupervisorRoot
    $temporary = "$Path.$PID.tmp"
    try {
        Set-Content -LiteralPath $temporary -Value $content -Encoding ascii -NoNewline
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Get-DefaultDisplayName([string]$Path) {
    $name = Split-Path -Leaf ([IO.Path]::GetFullPath($Path).TrimEnd('\'))
    $name = $name -replace '__t\d{3,4}$', ''
    $words = @($name -split '[-_]+' | Where-Object { $_ })
    if ($words.Count -ge 2 -and $words[$words.Count - 1] -match '^\d+$' -and $words[$words.Count - 2] -match '^\d+$') {
        $version = "$($words[$words.Count - 2]).$($words[$words.Count - 1])"
        $prefix = if ($words.Count -gt 2) { @($words[0..($words.Count - 3)]) } else { @() }
        $words = @($prefix + $version)
    }
    return (Get-Culture).TextInfo.ToTitleCase(($words -join ' ').ToLowerInvariant())
}

function Register-FeatureRuntime([string]$RequestedPath, [string]$RequestedDisplayName, [switch]$PreserveExistingPorts) {
    $safeDisplayName = ConvertTo-AshAtlasDisplayName $RequestedDisplayName
    $runtime = Resolve-FeatureWorktree $RequestedPath
    $leaseMutex = Enter-AshAtlasLeaseStoreMutex
    try {
    $store = Read-AshAtlasLeaseStore $LeasePath
    $sameWorktree = @($store.runtimes | Where-Object {
        [string]::Equals([IO.Path]::GetFullPath([string]$_.worktree).TrimEnd('\'), [string]$runtime.worktree, [StringComparison]::OrdinalIgnoreCase)
    })
    if ($sameWorktree.Count -gt 1 -or ($sameWorktree.Count -eq 1 -and [string]$sameWorktree[0].runtime_id -ne [string]$runtime.runtime_id)) {
        throw 'REFUSED: this worktree already has a different registration. Remove it before changing the branch identity.'
    }
    $existing = @($store.runtimes | Where-Object { [string]$_.runtime_id -eq [string]$runtime.runtime_id } | Select-Object -First 1)
    if ($existing.Count -eq 1 -and [string](Get-AshAtlasObjectPropertyValue $existing[0] 'integration_status' '') -eq 'merged_to_test') {
        throw 'REFUSED: this feature has merged into Integration Test and its runtime is retired.'
    }
    $existingPorts = if ($existing.Count -eq 1) { $existing[0].ports } else { $null }
    $dockerMappings = @(Get-AshAtlasDockerPortMappings)
    if ($existing.Count -eq 1) {
        $liveRecords = @(Get-LiveOwnedProcessRecords $existing[0])
        if ($liveRecords.Count -gt 0) {
            $dockerMappings += @(
                [pscustomobject]@{ port = [int]$existing[0].ports.frontend; container = 'launcher-owned frontend'; runtime_id = [string]$runtime.runtime_id },
                [pscustomobject]@{ port = [int]$existing[0].ports.backend; container = 'launcher-owned backend'; runtime_id = [string]$runtime.runtime_id }
            )
        }
        $existingPortClaim = Get-AshAtlasObjectPropertyValue $existing[0] 'port_claim' $null
        if ($null -ne $existingPortClaim) {
            Add-Member -InputObject $runtime -NotePropertyName port_claim -NotePropertyValue $existingPortClaim -Force
        }
    }
    $activeRuntimeIds = @($store.runtimes | ForEach-Object {
        $candidate = $_
        if ((Test-LiveOwnedSupervisor $candidate) -or @(Get-LiveOwnedProcessRecords $candidate).Count -gt 0 -or
            @($dockerMappings | Where-Object { [string]$_.runtime_id -eq [string]$candidate.runtime_id -and $_.running -eq $true }).Count -gt 0) {
            [string]$candidate.runtime_id
        }
    })
    $portBlockingLeases = @(Get-AshAtlasPortBlockingLeases @($store.runtimes) $activeRuntimeIds)
    if ($PreserveExistingPorts -and $null -ne $existingPorts) {
        $runtime.ports = $existingPorts
    } else {
        $runtime.ports = Select-AshAtlasFeaturePorts -Config $Config -RuntimeId $runtime.runtime_id `
            -ExcludedRanges @(Get-AshAtlasExcludedTcpRanges) -ListeningPorts @(Get-AshAtlasListeningPorts) `
            -DockerMappings $dockerMappings -Leases $portBlockingLeases -ExistingPorts $existingPorts
    }
    $worldDescriptor = Get-AshAtlasWorldRuntimeDescriptor (Join-Path $runtime.worktree 'config\world-runtime.lock.json')
    Add-Member -InputObject $runtime -NotePropertyName world_runtime -NotePropertyValue $worldDescriptor -Force
    $previousWorldRuntime = if ($existing.Count -eq 1) { Get-AshAtlasObjectPropertyValue $existing[0] 'world_runtime' $null } else { $null }
    $registeredRuntimeIds = @($store.runtimes | ForEach-Object { [string]$_.runtime_id })
    $runtime = Resolve-AshAtlasFeatureWorldRegistration `
        -Config $Config `
        -Runtime $runtime `
        -Store $store `
        -Persist `
        -PreviousWorldRuntime $previousWorldRuntime `
        -ExcludedRanges @(Get-AshAtlasExcludedTcpRanges) `
        -ListeningPorts @(Get-AshAtlasListeningPorts) `
        -DockerMappings @($dockerMappings) `
        -RegisteredRuntimeIds $registeredRuntimeIds `
        -ActiveRuntimeIds $activeRuntimeIds
    $baseGeneration = [string](Get-AshAtlasObjectPropertyValue $runtime 'base_test_generation' '')
    $launcherPath = Get-AshAtlasFeatureLauncherPath $LauncherRoot $safeDisplayName $baseGeneration
    $collision = @($store.runtimes | Where-Object {
        [string]$_.runtime_id -ne [string]$runtime.runtime_id -and
        [string]::Equals([string](Get-AshAtlasObjectPropertyValue $_ 'launcher_path' ''), $launcherPath, [StringComparison]::OrdinalIgnoreCase)
    })
    if ($collision.Count -gt 0) { throw "DisplayName collides with another registered feature launcher: $launcherPath" }
    $oldLauncher = if ($existing.Count -eq 1) { [string](Get-AshAtlasObjectPropertyValue $existing[0] 'launcher_path' '') } else { '' }
    if ($oldLauncher -and -not [string]::Equals($oldLauncher, $launcherPath, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $oldLauncher)) {
        if (-not (Test-AshAtlasGeneratedLauncher $oldLauncher $runtime.runtime_id $LauncherRoot)) { throw "REFUSED: old launcher is not safely owned: $oldLauncher" }
    }
    Add-Member -InputObject $runtime -NotePropertyName display_name -NotePropertyValue $safeDisplayName
    Add-Member -InputObject $runtime -NotePropertyName launcher_path -NotePropertyValue $launcherPath
    Write-GeneratedLauncher $runtime $safeDisplayName $launcherPath
    Set-AshAtlasLease $store $runtime | Out-Null
    Write-AshAtlasLeaseStore $store $LeasePath
    if ($oldLauncher -and -not [string]::Equals($oldLauncher, $launcherPath, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $oldLauncher)) {
        Remove-Item -LiteralPath $oldLauncher -Force
    }
    Write-Host "Registered feature runtime: $($runtime.runtime_id)" -ForegroundColor Green
    Write-Host "Launcher: $launcherPath"
    if ($baseGeneration) {
        Write-Host "Base test generation: $baseGeneration"
        Write-Host "Base integration SHA: $($runtime.base_test_sha)"
    }
    Write-Host "Frontend port is assigned on launch (preferred $($runtime.ports.frontend))."
    return $runtime
    } finally {
        Exit-AshAtlasLeaseStoreMutex $leaseMutex
    }
}

function Invoke-Create {
    if (-not $DisplayName) { throw '-DisplayName is required with create.' }
    Register-FeatureRuntime $WorktreePath $DisplayName | Out-Null
}

function Get-GitWorktreeRecords {
    $result = Invoke-AshAtlasNative git @('-C', $SupervisorRoot, 'worktree', 'list', '--porcelain')
    if ($result.ExitCode -ne 0) { throw 'Could not enumerate Git worktrees.' }
    $records = @()
    $current = $null
    foreach ($line in @($result.StdOut -split '\r?\n')) {
        if ($line -match '^worktree (.+)$') {
            if ($null -ne $current) { $records += $current }
            $current = [ordered]@{ worktree = $Matches[1]; head = ''; branch = ''; detached = $false; locked = $false; prunable = $false }
        } elseif ($null -ne $current -and $line -match '^HEAD (.+)$') { $current.head = $Matches[1] }
        elseif ($null -ne $current -and $line -match '^branch refs/heads/(.+)$') { $current.branch = $Matches[1] }
        elseif ($null -ne $current -and $line -eq 'detached') { $current.detached = $true }
        elseif ($null -ne $current -and $line -match '^locked') { $current.locked = $true }
        elseif ($null -ne $current -and $line -match '^prunable') { $current.prunable = $true }
    }
    if ($null -ne $current) { $records += $current }
    return @($records | ForEach-Object { [pscustomobject]$_ })
}

function Invoke-Sync {
    if ($WorktreePath -or $DisplayName) { throw 'sync discovers approved feature worktrees and does not accept -WorktreePath or -DisplayName.' }
    $approvedRoot = [IO.Path]::GetFullPath([string]$Config.feature_worktree_root).TrimEnd('\')
    $store = Read-AshAtlasLeaseStore $LeasePath
    $synced = 0
    foreach ($record in @(Get-GitWorktreeRecords)) {
        $path = [IO.Path]::GetFullPath(([string]$record.worktree).Replace('/', '\')).TrimEnd('\')
        if (-not $path.StartsWith($approvedRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { continue }
        $reason = ''
        if ($record.detached) { $reason = 'detached' }
        elseif ($record.locked) { $reason = 'locked' }
        elseif ($record.prunable -or -not (Test-Path -LiteralPath $path -PathType Container)) { $reason = 'missing or prunable' }
        elseif (-not $record.head -or -not $record.branch -or $record.branch -notmatch '^(feature|fix|chore|audit|integration)/[^/].+') { $reason = 'malformed branch metadata' }
        else {
            $lease = @($store.runtimes | Where-Object {
                [string]::Equals([IO.Path]::GetFullPath([string]$_.worktree).TrimEnd('\'), $path, [StringComparison]::OrdinalIgnoreCase)
            } | Select-Object -First 1)
            $runtimeId = if ($lease.Count -eq 1) { [string]$lease[0].runtime_id } else { '' }
            $cleanupMarker = if ($runtimeId) { Join-Path (Split-Path -Parent $LeasePath) "runtimes\$runtimeId\cleanup-in-progress" } else { '' }
            if ($lease.Count -eq 1 -and [string](Get-AshAtlasObjectPropertyValue $lease[0] 'integration_status' '') -eq 'merged_to_test') {
                $reason = 'merged into Integration Test'
            } elseif ($cleanupMarker -and (Test-Path -LiteralPath $cleanupMarker -PathType Leaf)) { $reason = 'cleanup in progress' }
        }
        if ($reason) {
            Write-Host "Ignored $path ($reason)." -ForegroundColor Yellow
            continue
        }
        try {
            $existing = @($store.runtimes | Where-Object {
                [string]::Equals([IO.Path]::GetFullPath([string]$_.worktree).TrimEnd('\'), $path, [StringComparison]::OrdinalIgnoreCase)
            } | Select-Object -First 1)
            $name = if ($existing.Count -eq 1 -and [string](Get-AshAtlasObjectPropertyValue $existing[0] 'display_name' '')) {
                [string]$existing[0].display_name
            } else { Get-DefaultDisplayName $path }
            Register-FeatureRuntime $path $name -PreserveExistingPorts | Out-Null
            $store = Read-AshAtlasLeaseStore $LeasePath
            $synced++
        } catch {
            Write-Host "Ignored $path ($($_.Exception.Message))." -ForegroundColor Yellow
        }
    }
    Write-Host "Sync completed: $synced feature launcher(s) created or refreshed; nothing was deleted." -ForegroundColor Green
}

function Invoke-Status {
    $store = Read-AshAtlasLeaseStore $LeasePath
    $dockerMappings = @(Get-AshAtlasDockerPortMappings -RequireAvailable)
    $activeRuntimeIds = @($store.runtimes | ForEach-Object {
        $candidate = $_
        if ((Test-LiveOwnedSupervisor $candidate) -or @(Get-LiveOwnedProcessRecords $candidate).Count -gt 0 -or
            @($dockerMappings | Where-Object { [string]$_.runtime_id -eq [string]$candidate.runtime_id -and $_.running -eq $true }).Count -gt 0) {
            [string]$candidate.runtime_id
        }
    })
    $rows = @($store.runtimes | ForEach-Object {
        $lease = $_
        $launcherPath = [string](Get-AshAtlasObjectPropertyValue $lease 'launcher_path' '')
        $mergedLauncherPath = [string](Get-AshAtlasObjectPropertyValue $lease 'merged_launcher_path' '')
        $live = @(Get-LiveOwnedProcessRecords $lease).Count -gt 0
        $docker = @($dockerMappings | Where-Object { [string]$_.runtime_id -eq [string]$lease.runtime_id -and $_.running -eq $true }).Count -gt 0
        $portClaimed = Test-AshAtlasFeaturePortClaimActive $lease
        $world = Get-AshAtlasObjectPropertyValue $lease 'world_runtime' $null
        $groupState = if ($null -ne $world -and [string]$world.group_id) { Read-AshAtlasWorldGroupState ([string]$world.group_id) } else { $null }
        $groupStatus = if ($null -ne $world) { Get-AshAtlasWorldGroupStatus (Convert-LeaseToRuntime $lease) } else { $null }
        [pscustomobject]@{
            display = [string](Get-AshAtlasObjectPropertyValue $lease 'display_name' $lease.runtime_id)
            state = $(if ($live -or $docker) { 'running' } elseif ($portClaimed) { 'starting' } else { 'parked' })
            frontend = $(if ($live -or $docker -or $portClaimed) { "http://127.0.0.1:$($lease.ports.frontend)" } else { "assigned on launch (last $($lease.ports.frontend))" })
            backend = [int]$lease.ports.backend
            postgres = [int]$lease.ports.postgres
            world_group = $(if ($null -ne $world) { [string]$world.group_id } else { 'legacy / sync required' })
            world_port = $(if ($null -ne $groupState) { [int]$groupState.port } else { [int]$lease.ports.world_api })
            world_pid = $(if ($null -ne $groupState) { [int]$groupState.pid } else { 0 })
            expected_pipeline = $(if ($null -ne $world) { "$($world.identity.pipeline.protected_branch)@$($world.identity.pipeline.sha)" } else { 'unknown' })
            actual_pipeline = $(if ($null -ne $groupStatus -and $null -ne $groupStatus.health) { "$($groupStatus.health.runtime.branch)@$($groupStatus.health.runtime.sha)" } else { 'stopped or unavailable' })
            expected_release = $(if ($null -ne $world) { "$($world.identity.release.release_id) / $($world.identity.release.manifest_sha256)" } else { 'unknown' })
            actual_release = $(if ($null -ne $groupStatus -and $null -ne $groupStatus.health) { "$($groupStatus.health.release.release_id) / $($groupStatus.health.release_verification.release_manifest_sha256)" } else { 'stopped or unavailable' })
            compatibility = $(if ($null -eq $groupStatus) { 'sync required' } elseif ($groupStatus.compatible) { 'compatible' } else { [string]$groupStatus.message })
            shared_with = $(if ($null -ne $groupState) { @($groupState.members_registered | Where-Object { [string]$_ -ne [string]$lease.runtime_id }) -join ', ' } else { '' })
            stale_members = $(if ($null -ne $groupState) { @($groupState.members_live | Where-Object { $activeRuntimeIds -notcontains [string]$_ }) -join ', ' } else { '' })
            port_conflict = $(if ($null -ne $groupState -and (Get-AshAtlasListeningPorts) -contains [int]$groupState.port -and ($null -eq $groupStatus -or $groupStatus.compatible -ne $true)) { 'active listener is not exact compatible group ownership' } else { '' })
            branch = $lease.branch
            base_test_generation = [string](Get-AshAtlasObjectPropertyValue $lease 'base_test_generation' 'legacy')
            base_test_sha = [string](Get-AshAtlasObjectPropertyValue $lease 'base_test_sha' 'not recorded')
            integration_status = [string](Get-AshAtlasObjectPropertyValue $lease 'integration_status' 'active')
            merged_test_generation = [string](Get-AshAtlasObjectPropertyValue $lease 'merged_test_generation' '')
            merged_test_sha = [string](Get-AshAtlasObjectPropertyValue $lease 'merged_test_sha' '')
            worktree = $lease.worktree
            launcher = $(if ($mergedLauncherPath -and (Test-Path -LiteralPath $mergedLauncherPath)) { $mergedLauncherPath } elseif ($launcherPath -and (Test-Path -LiteralPath $launcherPath)) { $launcherPath } else { 'missing' })
        }
    })
    $maxRunning = [int](Get-AshAtlasObjectPropertyValue $Config.feature.lifecycle 'max_running_features' 0)
    $limit = if ($maxRunning -gt 0) { [string]$maxRunning } else { 'unlimited' }
    Write-Host "running $(@($activeRuntimeIds | Select-Object -Unique).Count) / max $limit"
    if ($rows.Count -eq 0) { Write-Host 'No feature runtimes are registered.'; return }
    $rows | Format-List display, state, frontend, backend, postgres, world_group, world_port, world_pid, expected_pipeline, actual_pipeline, expected_release, actual_release, compatibility, shared_with, stale_members, port_conflict, branch, base_test_generation, base_test_sha, integration_status, merged_test_generation, merged_test_sha, worktree, launcher
}

function Get-FeatureRuntimeStatePaths($Lease) {
    $root = Join-Path (Split-Path -Parent $LeasePath) ("runtimes\" + [string]$Lease.runtime_id)
    return [pscustomobject]@{
        root = $root
        logs = Join-Path $root 'logs'
        supervisor = Join-Path $root 'supervisor.json'
        stop_signal = Join-Path $root 'stop-requested'
        ready_signal = Join-Path $root 'ready'
        supervisor_stdout = Join-Path $root 'logs\ready-supervisor.out.log'
        supervisor_stderr = Join-Path $root 'logs\ready-supervisor.err.log'
        frontend_stdout = Join-Path $root 'logs\frontend.out.log'
        frontend_stderr = Join-Path $root 'logs\frontend.err.log'
        backend_stdout = Join-Path $root 'logs\backend.out.log'
        backend_stderr = Join-Path $root 'logs\backend.err.log'
    }
}

function Get-CurrentExactFeatureLease($ExpectedLease) {
    $leaseMutex = Enter-AshAtlasLeaseStoreMutex
    try {
        $registration = Find-RegisteredLease ([string]$ExpectedLease.worktree)
        $current = $registration.lease
        if ([string]$current.runtime_id -ne [string]$ExpectedLease.runtime_id -or
            [string]$current.branch -ne [string]$ExpectedLease.branch -or
            -not [string]::Equals([string]$current.worktree, [string]$ExpectedLease.worktree, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'REFUSED: current feature lease no longer matches the exact registered runtime identity.'
        }
        $integrationStatus = [string](Get-AshAtlasObjectPropertyValue $current 'integration_status' '')
        if ($integrationStatus -and $integrationStatus -ne 'active') {
            throw "REFUSED: feature runtime is not active/unmerged (integration status '$integrationStatus')."
        }
        return $current
    } finally {
        Exit-AshAtlasLeaseStoreMutex $leaseMutex
    }
}

function Get-ExactActiveFeatureRegistration([string]$Path, [switch]$RequirePushedCleanHead) {
    $runtime = Resolve-FeatureWorktree $Path
    $registration = Find-RegisteredLease $runtime.worktree
    $lease = $registration.lease
    if ([string]$lease.runtime_id -ne [string]$runtime.runtime_id -or
        [string]$lease.branch -ne [string]$runtime.branch -or
        -not [string]::Equals([string]$lease.worktree, [string]$runtime.worktree, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'REFUSED: worktree identity does not match its exact registered feature runtime.'
    }
    $integrationStatus = [string](Get-AshAtlasObjectPropertyValue $lease 'integration_status' '')
    if ($integrationStatus -and $integrationStatus -ne 'active') {
        throw "REFUSED: feature runtime is not active/unmerged (integration status '$integrationStatus')."
    }
    $cleanupMarker = Join-Path (Get-FeatureRuntimeStatePaths $lease).root 'cleanup-in-progress'
    if (Test-Path -LiteralPath $cleanupMarker -PathType Leaf) { throw 'REFUSED: feature runtime cleanup is in progress.' }
    Assert-FeatureResourceOwnership $lease
    if ($RequirePushedCleanHead) {
        $dirty = Get-AshAtlasGitValue $runtime.worktree @('status', '--porcelain=v1', '--untracked-files=all')
        if ($dirty) { throw "REFUSED: feature worktree must be clean before it is handed off for testing.`n$dirty" }
        $head = Get-AshAtlasGitValue $runtime.worktree @('rev-parse', 'HEAD')
        $upstream = Get-AshAtlasGitValue $runtime.worktree @('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}')
        $expectedUpstream = "origin/$($runtime.branch)"
        if ($upstream -ne $expectedUpstream) { throw "REFUSED: feature branch must track exact upstream $expectedUpstream, not '$upstream'." }
        $remote = Invoke-AshAtlasNative git @('-C', $runtime.worktree, 'ls-remote', '--exit-code', 'origin', "refs/heads/$($runtime.branch)")
        if ($remote.ExitCode -ne 0 -or $remote.StdOut -notmatch '^([0-9a-f]{40})\s+refs/heads/') {
            throw "REFUSED: could not prove exact pushed upstream origin/$($runtime.branch)."
        }
        if ($Matches[1] -ne $head) { throw "REFUSED: origin/$($runtime.branch) is not exact pushed HEAD $head." }
        return [pscustomobject]@{ lease = $lease; sha = $head }
    }
    return [pscustomobject]@{ lease = $lease; sha = (Get-AshAtlasGitValue $runtime.worktree @('rev-parse', 'HEAD')) }
}

function Test-ExactFeatureRuntimeReady($Lease, $Paths, [string]$Sha) {
    if (-not (Test-Path -LiteralPath $Paths.ready_signal -PathType Leaf) -or
        -not (Test-Path -LiteralPath $Paths.supervisor -PathType Leaf) -or
        (Test-Path -LiteralPath $Paths.stop_signal -PathType Leaf)) { return $false }
    try { $supervisor = Get-Content -Raw -LiteralPath $Paths.supervisor | ConvertFrom-Json }
    catch { throw "REFUSED: runtime supervisor state is unreadable: $($Paths.supervisor)." }
    if ([string]$supervisor.runtime_id -ne [string]$Lease.runtime_id -or
        -not [string]::Equals([string]$supervisor.worktree, [string]$Lease.worktree, [StringComparison]::OrdinalIgnoreCase) -or
        [string]$supervisor.branch -ne [string]$Lease.branch -or [string]$supervisor.sha -ne $Sha -or
        [string]$supervisor.phase -ne 'healthy' -or
        [int]$supervisor.ports.frontend -ne [int]$Lease.ports.frontend -or
        [int]$supervisor.ports.backend -ne [int]$Lease.ports.backend -or
        [int]$supervisor.ports.postgres -ne [int]$Lease.ports.postgres -or
        [int]$supervisor.ports.world_api -ne [int]$Lease.ports.world_api) { return $false }
    if ((Get-AshAtlasRecordedProcessStatus $supervisor).status -ne 'match') { return $false }
    $frontendUrl = "http://127.0.0.1:$($Lease.ports.frontend)"
    $backendUrl = "http://127.0.0.1:$($Lease.ports.backend)"
    try {
        $health = Invoke-RestMethod -Uri "$backendUrl/health" -TimeoutSec 3
        $ready = Invoke-RestMethod -Uri "$backendUrl/ready" -TimeoutSec 3
        $frontend = Invoke-WebRequest -Uri $frontendUrl -UseBasicParsing -TimeoutSec 3
    } catch { return $false }
    $readyIdentity = $ready.checks.runtimeIdentity.identity
    return (
        $health.runtime.label -eq $Lease.runtime_id -and $health.runtime.branch -eq $Lease.branch -and $health.runtime.sha -eq $Sha -and
        $ready.ok -eq $true -and $ready.checks.database.ok -eq $true -and $ready.checks.worldAuthority.ok -eq $true -and
        $ready.checks.runtimeIdentity.ok -eq $true -and $readyIdentity.label -eq $Lease.runtime_id -and
        $readyIdentity.branch -eq $Lease.branch -and $readyIdentity.sha -eq $Sha -and [int]$frontend.StatusCode -eq 200
    )
}

function Write-FeatureRuntimeHandoffResult($Lease, $Paths, [string]$State, [string]$Sha) {
    [ordered]@{
        ok = $true
        state = $State
        test_url = $(if ($State -eq 'ready') { "http://127.0.0.1:$($Lease.ports.frontend)" } else { $null })
        runtime_id = [string]$Lease.runtime_id
        branch = [string]$Lease.branch
        sha = $Sha
        launcher = [string](Get-AshAtlasObjectPropertyValue $Lease 'launcher_path' '')
        logs = [ordered]@{
            root = $Paths.logs
            supervisor_stdout = $Paths.supervisor_stdout
            supervisor_stderr = $Paths.supervisor_stderr
            frontend_stdout = $Paths.frontend_stdout
            frontend_stderr = $Paths.frontend_stderr
            backend_stdout = $Paths.backend_stdout
            backend_stderr = $Paths.backend_stderr
        }
    } | ConvertTo-Json -Depth 4 -Compress
}

function Invoke-ParkExactFeatureRuntime($Lease) {
    $output = @(& (Join-Path $PSScriptRoot 'run-main.ps1') -RuntimeMode Feature -WorktreePath ([string]$Lease.worktree) -Stop 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "Exact feature runtime stop failed: $($output -join [Environment]::NewLine)" }
}

function Invoke-Ready {
    $identity = Get-ExactActiveFeatureRegistration $WorktreePath -RequirePushedCleanHead
    $lease = $identity.lease
    $paths = Get-FeatureRuntimeStatePaths $lease
    New-Item -ItemType Directory -Path $paths.logs -Force | Out-Null
    if (Test-ExactFeatureRuntimeReady $lease $paths $identity.sha) {
        Write-FeatureRuntimeHandoffResult $lease $paths 'ready' $identity.sha
        return
    }
    $attemptId = [Guid]::NewGuid().ToString('N')
    $paths.supervisor_stdout = Join-Path $paths.logs "ready-bootstrap-$attemptId.out.log"
    $paths.supervisor_stderr = Join-Path $paths.logs "ready-bootstrap-$attemptId.err.log"
    $powerShell = (Get-Process -Id $PID).Path
    $supervisorScript = Join-Path $PSScriptRoot 'run-main.ps1'
    $arguments = @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $supervisorScript,
        '-RuntimeMode', 'Feature', '-WorktreePath', [string]$lease.worktree, '-NoBrowser'
    )
    $argumentLine = @($arguments | ForEach-Object { ConvertTo-AshAtlasNativeArgument ([string]$_) }) -join ' '
    $process = Start-Process -FilePath $powerShell -ArgumentList $argumentLine `
        -WorkingDirectory ([string]$lease.worktree) -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $paths.supervisor_stdout -RedirectStandardError $paths.supervisor_stderr
    $timeoutSeconds = 420
    $deadline = (Get-Date).AddSeconds($timeoutSeconds)
    try {
        while ((Get-Date) -lt $deadline) {
            $currentLease = Get-CurrentExactFeatureLease $lease
            if (Test-ExactFeatureRuntimeReady $currentLease $paths $identity.sha) {
                $currentLease = Get-CurrentExactFeatureLease $lease
                if (-not (Test-ExactFeatureRuntimeReady $currentLease $paths $identity.sha)) { continue }
                Write-FeatureRuntimeHandoffResult $currentLease $paths 'ready' $identity.sha
                return
            }
            if ($process.HasExited) {
                $process.WaitForExit()
                $process.Refresh()
                $exitCode = if ($null -eq $process.ExitCode -or [string]::IsNullOrWhiteSpace([string]$process.ExitCode)) { 'unavailable' } else { [string]$process.ExitCode }
                throw "Feature runtime startup exited with code $exitCode. Logs: $($paths.supervisor_stdout); $($paths.supervisor_stderr); $($paths.backend_stderr); $($paths.frontend_stderr)"
            }
            Start-Sleep -Milliseconds ([int]$Config.feature.lifecycle.poll_milliseconds)
        }
        throw "Timed out after $timeoutSeconds seconds waiting for exact feature runtime readiness. Logs: $($paths.supervisor_stdout); $($paths.supervisor_stderr); $($paths.backend_stderr); $($paths.frontend_stderr)"
    } catch {
        $failure = $_
        try {
            $currentLease = Get-CurrentExactFeatureLease $lease
            Invoke-ParkExactFeatureRuntime $currentLease
        }
        catch { Write-Warning "Newly-started exact runtime cleanup failed: $($_.Exception.Message)" }
        throw $failure
    } finally {
        if ($null -ne $process) { $process.Dispose() }
    }
}

function Invoke-Park {
    $identity = Get-ExactActiveFeatureRegistration $WorktreePath
    $paths = Get-FeatureRuntimeStatePaths $identity.lease
    Invoke-ParkExactFeatureRuntime $identity.lease
    Write-FeatureRuntimeHandoffResult $identity.lease $paths 'parked' $identity.sha
}

function Read-MergedMarkerIdentity([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $content = Get-Content -Raw -LiteralPath $Path
    $pattern = '(?s)^# Merged to Integration Test\r?\n\r?\nFeature: (?<display>[^\r\n]+)\r?\nBranch: (?<branch>[^\r\n]+)\r?\nStarted from generation: (?<baseGeneration>t\d{3,4})\r?\nBase integration SHA: (?<baseSha>[0-9a-f]{40})\r?\nIncluded in generation: (?<mergedGeneration>t\d{3,4})\r?\nResulting integration SHA: (?<mergedSha>[0-9a-f]{40})\r?\nMerged at UTC: (?<mergedAt>[^\r\n]+)\r?\n(?:Batch operation ID: (?<batchOperation>[A-Za-z0-9][A-Za-z0-9._-]{0,127})\r?\n)?$'
    if ($content -notmatch $pattern) { throw "REFUSED: merged worktree marker is malformed: $Path" }
    return [pscustomobject]@{
        content = $content
        display_name = $Matches.display
        branch = $Matches.branch
        base_test_generation = $Matches.baseGeneration
        base_test_sha = $Matches.baseSha
        merged_test_generation = $Matches.mergedGeneration
        merged_test_sha = $Matches.mergedSha
        merged_at_utc = $Matches.mergedAt
        batch_operation_id = [string]$Matches['batchOperation']
    }
}

function Read-MergedLauncherIdentity([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $content = Get-Content -Raw -LiteralPath $Path
    $pattern = '(?s)^@echo off\r?\necho This feature has already been accepted into Integration Test\.\r?\necho Feature: (?<display>[^\r\n]+)\r?\necho Source branch: (?<branch>[^\r\n]+)\r?\necho Feature tip SHA: (?<featureSha>[0-9a-f]{40})\r?\necho Base test generation: (?<baseGeneration>t\d{3,4})\r?\necho Base integration SHA: (?<baseSha>[0-9a-f]{40})\r?\necho Merged test generation: (?<mergedGeneration>t\d{3,4})\r?\necho Merged integration SHA: (?<mergedSha>[0-9a-f]{40})\r?\n(?:echo Batch operation ID: (?<batchOperation>[A-Za-z0-9][A-Za-z0-9._-]{0,127})\r?\n)?pause\r?\n$'
    if ($content -notmatch $pattern) { throw "REFUSED: merged launcher receipt is malformed: $Path" }
    return [pscustomobject]@{
        content = $content
        display_name = $Matches.display
        branch = $Matches.branch
        feature_tip_sha = $Matches.featureSha
        base_test_generation = $Matches.baseGeneration
        base_test_sha = $Matches.baseSha
        merged_test_generation = $Matches.mergedGeneration
        merged_test_sha = $Matches.mergedSha
        batch_operation_id = [string]$Matches['batchOperation']
    }
}

function Add-BatchMergedIdentity {
    param(
        [Parameter(Mandatory = $true)][string]$Content,
        [string]$OperationId,
        [switch]$Launcher
    )
    if (-not $OperationId) { return $Content }
    if ($Launcher) {
        return $Content.Replace(
            "pause`r`n",
            "echo Batch operation ID: $OperationId`r`npause`r`n"
        )
    }
    return $Content + "Batch operation ID: $OperationId`r`n"
}

function Get-TargetedMergedRemoteState {
    param(
        [Parameter(Mandatory = $true)][string]$Branch,
        [Parameter(Mandatory = $true)][string]$MergedGeneration,
        [Parameter(Mandatory = $true)][string]$BaseGeneration
    )

    $requestedRefs = @(
        "refs/heads/$Branch",
        'refs/heads/integration/test',
        "refs/tags/test/$MergedGeneration",
        "refs/tags/test/$BaseGeneration"
    )
    $result = Invoke-AshAtlasNative git (@('-C', $SupervisorRoot, 'ls-remote', 'origin') + $requestedRefs)
    if ($result.ExitCode -ne 0) {
        throw "REFUSED: targeted remote integration validation failed: $($result.StdErr.Trim())"
    }
    $objects = @{}
    $peeled = @{}
    foreach ($line in @($result.StdOut -split '\r?\n' | Where-Object { $_ })) {
        if ($line -notmatch '^([0-9a-f]{40})\s+(.+)$') {
            throw "REFUSED: malformed targeted remote ref output: $line"
        }
        $sha = $Matches[1]
        $ref = $Matches[2]
        if ($ref -match '^(.+)\^\{\}$') { $peeled[$Matches[1]] = $sha }
        else { $objects[$ref] = $sha }
    }
    foreach ($ref in $requestedRefs) {
        if (-not $objects.ContainsKey($ref)) { throw "REFUSED: required remote ref is absent: $ref" }
    }
    return [pscustomobject]@{
        feature_sha = [string]$objects["refs/heads/$Branch"]
        integration_sha = [string]$objects['refs/heads/integration/test']
        merged_tag_sha = $(if ($peeled.ContainsKey("refs/tags/test/$MergedGeneration")) {
            [string]$peeled["refs/tags/test/$MergedGeneration"]
        } else { [string]$objects["refs/tags/test/$MergedGeneration"] })
        base_tag_sha = $(if ($peeled.ContainsKey("refs/tags/test/$BaseGeneration")) {
            [string]$peeled["refs/tags/test/$BaseGeneration"]
        } else { [string]$objects["refs/tags/test/$BaseGeneration"] })
    }
}

function Test-ReceiptInfrastructureInterval([string]$BaseSha, [string]$HeadSha) {
    $allowedPaths = @(
        'tools/dev/test-generation.ps1',
        'tools/dev/test-generation.tests.ps1',
        'tools/dev/integration-admission-policy.tests.ps1',
        'tools/dev/feature-runtime.ps1',
        'tools/dev/feature-merged-receipt.tests.ps1',
        'tools/release/accept-and-publish-test-server.ps1',
        'tools/release/install-vps-updater.ps1',
        'tools/release/promote-world-runtime.ps1',
        'tools/release/release-coordination.tests.ps1',
        'tools/release/release-flow.tests.ps1',
        'tools/release/vps/deploy-control.sh',
        'tools/release/vps/deploy-control.tests.sh',
        'tools/release/vps/deploy-test-update.sh',
        'tools/release/vps/deployment-controller.conf',
        'tools/release/vps/install-release-controller.sh',
        'tools/release/vps/promote-world-runtime.sh'
    )
    $commitsResult = Invoke-AshAtlasNative git @('-C', $SupervisorRoot, 'rev-list', '--reverse', "$BaseSha..$HeadSha")
    if ($commitsResult.ExitCode -ne 0) { return $false }
    foreach ($commit in @($commitsResult.StdOut -split '\r?\n' | Where-Object { $_ })) {
        $pathsResult = Invoke-AshAtlasNative git @(
            '-C', $SupervisorRoot, 'diff-tree', '--no-commit-id', '--name-only', '-r', $commit
        )
        if ($pathsResult.ExitCode -ne 0) { return $false }
        foreach ($path in @($pathsResult.StdOut -split '\r?\n' | Where-Object { $_ })) {
            if ($allowedPaths -cnotcontains $path) { return $false }
        }
    }
    return $true
}

function Invoke-MarkMerged {
    if (-not $ConfirmAcceptedIntegration) {
        throw 'mark-merged requires -ConfirmAcceptedIntegration after explicit authorization and focused post-merge admission.'
    }
    if (-not $MergedTestGeneration -or -not $MergedTestSha) {
        throw 'mark-merged requires -MergedTestGeneration and -MergedTestSha.'
    }
    if ([bool]$EffectiveBaseTestGeneration -ne [bool]$EffectiveBaseTestSha) {
        throw 'mark-merged requires -EffectiveBaseTestGeneration and -EffectiveBaseTestSha together.'
    }
    $MergedTestSha = $MergedTestSha.ToLowerInvariant()
    if ($EffectiveBaseTestSha) { $EffectiveBaseTestSha = $EffectiveBaseTestSha.ToLowerInvariant() }
    $runtime = Resolve-FeatureWorktree $WorktreePath
    $featureHead = Get-AshAtlasGitValue $runtime.worktree @('rev-parse', 'HEAD')
    $branch = [string]$runtime.branch
    $runtimeBaseGeneration = [string](Get-AshAtlasObjectPropertyValue $runtime 'base_test_generation' '')
    $runtimeBaseSha = [string](Get-AshAtlasObjectPropertyValue $runtime 'base_test_sha' '')
    if (-not $EffectiveBaseTestGeneration -and
        ($runtimeBaseGeneration -notmatch '^t\d{3,4}$' -or $runtimeBaseSha -notmatch '^[0-9a-f]{40}$')) {
        throw 'REFUSED: mark-merged requires exact generation-labeled feature base metadata.'
    }
    $baseGeneration = if ($EffectiveBaseTestGeneration) { $EffectiveBaseTestGeneration } else { $runtimeBaseGeneration }
    $baseSha = if ($EffectiveBaseTestSha) { $EffectiveBaseTestSha } else { $runtimeBaseSha }
    $remote = Get-TargetedMergedRemoteState $branch $MergedTestGeneration $baseGeneration
    if ($remote.feature_sha -ne $featureHead) {
        throw "REFUSED: origin/$branch does not record exact feature commit $featureHead."
    }
    if ($remote.merged_tag_sha -ne $MergedTestSha) {
        throw "REFUSED: test/$MergedTestGeneration does not point to exact merged SHA $MergedTestSha."
    }
    if ($remote.base_tag_sha -ne $baseSha) {
        throw "REFUSED: test/$baseGeneration resolves to $($remote.base_tag_sha), not proven base SHA $baseSha."
    }
    $currentIntegrationSha = [string]$remote.integration_sha
    $mergedStillAccepted = Invoke-AshAtlasNative git @('-C', $SupervisorRoot, 'merge-base', '--is-ancestor', $MergedTestSha, $currentIntegrationSha)
    if ($mergedStillAccepted.ExitCode -ne 0) {
        throw "REFUSED: current origin/integration/test $currentIntegrationSha does not contain accepted generation $MergedTestGeneration at $MergedTestSha."
    }
    $featureIncluded = Invoke-AshAtlasNative git @('-C', $SupervisorRoot, 'merge-base', '--is-ancestor', $featureHead, $MergedTestSha)
    if ($featureIncluded.ExitCode -ne 0) {
        throw "REFUSED: feature commit $featureHead is not an ancestor of $MergedTestGeneration at $MergedTestSha."
    }
    $baseIncluded = Invoke-AshAtlasNative git @('-C', $SupervisorRoot, 'merge-base', '--is-ancestor', $baseSha, $featureHead)
    if ($baseIncluded.ExitCode -ne 0) {
        throw "REFUSED: proven base $baseGeneration at $baseSha is not in feature commit $featureHead ancestry."
    }
    if ($featureHead -eq $baseSha) {
        throw "REFUSED: feature commit must be newer than proven base $baseGeneration at $baseSha."
    }
    if ([int]$MergedTestGeneration.Substring(1) -le [int]$baseGeneration.Substring(1)) {
        throw "REFUSED: included generation $MergedTestGeneration must be newer than base generation $baseGeneration."
    }
    if ($EffectiveBaseTestGeneration -and -not $BatchOperationId) {
        $parentsResult = Invoke-AshAtlasNative git @('-C', $SupervisorRoot, 'show', '-s', '--format=%P', $MergedTestSha)
        if ($parentsResult.ExitCode -ne 0) {
            throw "REFUSED: cannot inspect accepted merge $MergedTestSha."
        }
        $parents = @($parentsResult.StdOut.Trim() -split '\s+' | Where-Object { $_ })
        if ($parents.Count -ne 2) {
            throw "REFUSED: accepted integration $MergedTestSha is not an exact two-parent feature merge."
        }
        $mergeBaseResult = Invoke-AshAtlasNative git @('-C', $SupervisorRoot, 'merge-base', $featureHead, $parents[0])
        $featureMergeBase = $mergeBaseResult.StdOut.Trim()
        if ($mergeBaseResult.ExitCode -ne 0 -or
            ($featureMergeBase -ne $baseSha -and
                -not (Test-ReceiptInfrastructureInterval $baseSha $featureMergeBase))) {
            throw "REFUSED: feature merge base with original integration target $($parents[0]) is not proven base $baseSha."
        }
    }

    if ($branch -notmatch '^(feature|fix|chore|audit)/[^/].+') {
        throw "REFUSED: merged receipts are only for accepted feature, fix, chore, or audit branches, not '$branch'."
    }

    $leaseMutex = Enter-AshAtlasLeaseStoreMutex
    try {
        $store = Read-AshAtlasLeaseStore $LeasePath
        $matches = @($store.runtimes | Where-Object {
            [string]::Equals([IO.Path]::GetFullPath([string]$_.worktree).TrimEnd('\'), [string]$runtime.worktree, [StringComparison]::OrdinalIgnoreCase)
        })
        if ($matches.Count -gt 1) { throw 'REFUSED: multiple runtime leases claim this feature worktree.' }
        $lease = if ($matches.Count -eq 1) { $matches[0] } else { $null }
        if ($null -ne $lease -and
            ([string]$lease.runtime_id -ne [string]$runtime.runtime_id -or [string]$lease.branch -ne $branch)) {
            throw 'REFUSED: feature worktree no longer matches its registered lease identity.'
        }
        $storedBaseGeneration = if ($null -ne $lease) {
            [string](Get-AshAtlasObjectPropertyValue $lease 'base_test_generation' '')
        } else { [string](Get-AshAtlasObjectPropertyValue $runtime 'base_test_generation' '') }
        $storedBaseSha = if ($null -ne $lease) {
            [string](Get-AshAtlasObjectPropertyValue $lease 'base_test_sha' '')
        } else { [string](Get-AshAtlasObjectPropertyValue $runtime 'base_test_sha' '') }
        $displayName = if ($null -ne $lease) {
            [string](Get-AshAtlasObjectPropertyValue $lease 'display_name' '')
        } elseif ($DisplayName) {
            ConvertTo-AshAtlasDisplayName $DisplayName
        } else { Get-DefaultDisplayName $runtime.worktree }
        if (-not $displayName) {
            throw 'REFUSED: mark-merged requires a feature title.'
        }
        if ($null -ne $lease -and
            ($storedBaseGeneration -notmatch '^t\d{3,4}$' -or $storedBaseSha -notmatch '^[0-9a-f]{40}$')) {
            throw 'REFUSED: a registered runtime requires exact generation-labeled worktree metadata.'
        }
        if ($null -ne $lease -and
            ($storedBaseGeneration -ne $runtimeBaseGeneration -or $storedBaseSha -ne $runtimeBaseSha)) {
            throw 'REFUSED: registered feature base metadata differs from the exact worktree identity.'
        }
        if ($null -ne $lease -and
            ($storedBaseGeneration -ne $baseGeneration -or $storedBaseSha -ne $baseSha)) {
            throw "REFUSED: registered runtime lease base $storedBaseGeneration@$storedBaseSha differs from proven effective base $baseGeneration@$baseSha."
        }
        $activeLauncher = if ($null -ne $lease) { [string](Get-AshAtlasObjectPropertyValue $lease 'launcher_path' '') } else { '' }
        if ($null -ne $lease) {
            $expectedActiveLauncher = Get-AshAtlasFeatureLauncherPath $LauncherRoot $displayName $runtimeBaseGeneration
            Assert-ExactPath $activeLauncher $expectedActiveLauncher 'Active feature launcher'
        }
        $markerPath = Join-Path $runtime.worktree '__MERGED_TO_TEST__.md'
        $existingMarker = Read-MergedMarkerIdentity $markerPath
        if ($null -eq $lease -and $null -ne $existingMarker) {
            $displayName = [string]$existingMarker.display_name
        }
        $mergedLauncher = Get-AshAtlasMergedLauncherPath $LauncherRoot $displayName $baseGeneration $MergedTestGeneration
        $existingStatus = if ($null -ne $lease) { [string](Get-AshAtlasObjectPropertyValue $lease 'integration_status' '') } else { '' }
        $continuedAcceptance = $false

        if ($null -ne $existingMarker -or (Test-Path -LiteralPath $mergedLauncher) -or $existingStatus) {
            $expectedReceipt = Add-BatchMergedIdentity `
                (New-AshAtlasMergedLauncherContent $displayName $branch $featureHead `
                    $baseGeneration $baseSha $MergedTestGeneration $MergedTestSha) `
                $BatchOperationId -Launcher
            $markerMatches = $null -ne $existingMarker -and
                $existingMarker.content -ceq (Add-BatchMergedIdentity `
                    (New-AshAtlasMergedMarkerContent $displayName $branch $baseGeneration $baseSha `
                        $MergedTestGeneration $MergedTestSha $existingMarker.merged_at_utc) `
                    $BatchOperationId)
            $receiptMatches = (Test-Path -LiteralPath $mergedLauncher -PathType Leaf) -and
                (Get-Content -Raw -LiteralPath $mergedLauncher) -ceq $expectedReceipt
            $leaseMatches = $null -eq $lease -or
                ($null -ne $existingMarker -and $existingStatus -eq 'merged_to_test' -and
                 [string](Get-AshAtlasObjectPropertyValue $lease 'merged_test_generation' '') -eq $MergedTestGeneration -and
                 [string](Get-AshAtlasObjectPropertyValue $lease 'merged_test_sha' '') -eq $MergedTestSha -and
                 [string](Get-AshAtlasObjectPropertyValue $lease 'merged_batch_operation_id' '') -eq $BatchOperationId -and
                 (Test-AshAtlasUtcTimestampEquivalent (Get-AshAtlasObjectPropertyValue $lease 'merged_at_utc' $null) $existingMarker.merged_at_utc) -and
                 [string]::Equals([string](Get-AshAtlasObjectPropertyValue $lease 'merged_launcher_path' ''), $mergedLauncher, [StringComparison]::OrdinalIgnoreCase) -and
                 -not (Test-Path -LiteralPath $activeLauncher))
            if ($markerMatches -and $receiptMatches -and $leaseMatches) {
                Write-Host "Feature already marked merged into $MergedTestGeneration at $MergedTestSha." -ForegroundColor Green
                Exit-AshAtlasLeaseStoreMutex $leaseMutex
                $leaseMutex = $null
                Retire-MergedRuntimeReservation $runtime
                return
            }

            $priorLauncher = if ($null -ne $lease) {
                [string](Get-AshAtlasObjectPropertyValue $lease 'merged_launcher_path' '')
            } elseif ($null -ne $existingMarker) {
                Get-AshAtlasMergedLauncherPath $LauncherRoot $existingMarker.display_name `
                    $existingMarker.base_test_generation $existingMarker.merged_test_generation
            } else { '' }
            $priorReceipt = if ($priorLauncher) { Read-MergedLauncherIdentity $priorLauncher } else { $null }
            $priorGeneration = if ($null -ne $lease) {
                [string](Get-AshAtlasObjectPropertyValue $lease 'merged_test_generation' '')
            } elseif ($null -ne $existingMarker) { [string]$existingMarker.merged_test_generation } else { '' }
            $priorSha = if ($null -ne $lease) {
                [string](Get-AshAtlasObjectPropertyValue $lease 'merged_test_sha' '')
            } elseif ($null -ne $existingMarker) { [string]$existingMarker.merged_test_sha } else { '' }
            $priorBatch = if ($null -ne $lease) {
                [string](Get-AshAtlasObjectPropertyValue $lease 'merged_batch_operation_id' '')
            } elseif ($null -ne $existingMarker) { [string]$existingMarker.batch_operation_id } else { '' }
            $priorLeaseMatches = $null -eq $lease -or
                ($existingStatus -eq 'merged_to_test' -and
                 [string](Get-AshAtlasObjectPropertyValue $lease 'merged_test_generation' '') -eq $priorGeneration -and
                 [string](Get-AshAtlasObjectPropertyValue $lease 'merged_test_sha' '') -eq $priorSha -and
                 [string](Get-AshAtlasObjectPropertyValue $lease 'merged_batch_operation_id' '') -eq $priorBatch -and
                 (Test-AshAtlasUtcTimestampEquivalent (Get-AshAtlasObjectPropertyValue $lease 'merged_at_utc' $null) $existingMarker.merged_at_utc))
            $priorRecordMatches = $null -ne $existingMarker -and $null -ne $priorReceipt -and
                $priorLeaseMatches -and
                $existingMarker.display_name -ceq $displayName -and $priorReceipt.display_name -ceq $displayName -and
                $existingMarker.branch -ceq $branch -and $priorReceipt.branch -ceq $branch -and
                $existingMarker.base_test_generation -eq $baseGeneration -and $priorReceipt.base_test_generation -eq $baseGeneration -and
                $existingMarker.base_test_sha -eq $baseSha -and $priorReceipt.base_test_sha -eq $baseSha -and
                $existingMarker.merged_test_generation -eq $priorGeneration -and $priorReceipt.merged_test_generation -eq $priorGeneration -and
                $existingMarker.merged_test_sha -eq $priorSha -and $priorReceipt.merged_test_sha -eq $priorSha -and
                $existingMarker.batch_operation_id -eq $priorBatch -and $priorReceipt.batch_operation_id -eq $priorBatch -and
                $existingMarker.content -ceq (Add-BatchMergedIdentity `
                    (New-AshAtlasMergedMarkerContent $displayName $branch $baseGeneration $baseSha `
                        $priorGeneration $priorSha $existingMarker.merged_at_utc) $priorBatch) -and
                $priorReceipt.content -ceq (Add-BatchMergedIdentity `
                    (New-AshAtlasMergedLauncherContent $displayName $branch $priorReceipt.feature_tip_sha `
                        $baseGeneration $baseSha $priorGeneration $priorSha) $priorBatch -Launcher) -and
                ($null -eq $lease -or -not (Test-Path -LiteralPath $activeLauncher)) -and
                -not (Test-Path -LiteralPath $mergedLauncher) -and
                [int]$MergedTestGeneration.Substring(1) -gt [int]$priorGeneration.Substring(1)
            if ($priorRecordMatches) {
                $priorFeatureIncluded = Invoke-AshAtlasNative git @(
                    '-C', $SupervisorRoot, 'merge-base', '--is-ancestor', $priorReceipt.feature_tip_sha, $featureHead
                )
                $priorMergeIncluded = Invoke-AshAtlasNative git @(
                    '-C', $SupervisorRoot, 'merge-base', '--is-ancestor', $priorSha, $MergedTestSha
                )
                $continuedAcceptance = $priorFeatureIncluded.ExitCode -eq 0 -and
                    $priorMergeIncluded.ExitCode -eq 0 -and $priorReceipt.feature_tip_sha -ne $featureHead
            }
            if (-not $continuedAcceptance) {
                throw 'REFUSED: existing merged record is incomplete or differs from the requested accepted integration.'
            }
        }

        if ($null -ne $lease -and -not $continuedAcceptance -and
            -not (Test-AshAtlasGeneratedLauncher $activeLauncher $runtime.runtime_id $LauncherRoot)) {
            throw "REFUSED: active launcher is missing or not owned by runtime $($runtime.runtime_id): $activeLauncher"
        }

        $mergedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
        $markerContent = Add-BatchMergedIdentity `
            (New-AshAtlasMergedMarkerContent $displayName $branch $baseGeneration $baseSha `
                $MergedTestGeneration $MergedTestSha $mergedAtUtc) `
            $BatchOperationId
        $receiptContent = Add-BatchMergedIdentity `
            (New-AshAtlasMergedLauncherContent $displayName $branch $featureHead `
                $baseGeneration $baseSha $MergedTestGeneration $MergedTestSha) `
            $BatchOperationId -Launcher
        $markerTemporary = "$markerPath.$PID.tmp"
        $receiptTemporary = "$mergedLauncher.$PID.tmp"
        $storeSnapshot = $store | ConvertTo-Json -Depth 8
        $activeContent = if ($null -ne $lease -and -not $continuedAcceptance) { Get-Content -Raw -LiteralPath $activeLauncher } else { '' }
        $previousMarkerContent = if ($continuedAcceptance) { $existingMarker.content } else { '' }
        $leaseWritten = $false
        try {
            New-Item -ItemType Directory -Path $MergedLauncherRoot -Force | Out-Null
            Set-Content -LiteralPath $markerTemporary -Value $markerContent -Encoding utf8 -NoNewline
            Set-Content -LiteralPath $receiptTemporary -Value $receiptContent -Encoding ascii -NoNewline
            Move-Item -LiteralPath $markerTemporary -Destination $markerPath -Force
            Move-Item -LiteralPath $receiptTemporary -Destination $mergedLauncher
            if ($null -ne $lease) {
                Add-Member -InputObject $lease -NotePropertyName integration_status -NotePropertyValue 'merged_to_test' -Force
                Add-Member -InputObject $lease -NotePropertyName merged_test_generation -NotePropertyValue $MergedTestGeneration -Force
                Add-Member -InputObject $lease -NotePropertyName merged_test_sha -NotePropertyValue $MergedTestSha -Force
                Add-Member -InputObject $lease -NotePropertyName merged_at_utc -NotePropertyValue $mergedAtUtc -Force
                Add-Member -InputObject $lease -NotePropertyName merged_launcher_path -NotePropertyValue $mergedLauncher -Force
                Add-Member -InputObject $lease -NotePropertyName merged_batch_operation_id -NotePropertyValue $BatchOperationId -Force
                Write-AshAtlasLeaseStore $store $LeasePath
                $leaseWritten = $true
                if (-not $continuedAcceptance) { Remove-Item -LiteralPath $activeLauncher -Force }
            }
        } catch {
            $failure = $_.Exception.Message
            $rollbackFailures = @()
            if ($leaseWritten) {
                try { Write-AshAtlasLeaseStore ($storeSnapshot | ConvertFrom-Json) $LeasePath }
                catch { $rollbackFailures += "lease rollback failed: $($_.Exception.Message)" }
            }
            if ($null -ne $lease -and -not $continuedAcceptance -and -not (Test-Path -LiteralPath $activeLauncher)) {
                try { Set-Content -LiteralPath $activeLauncher -Value $activeContent -Encoding ascii -NoNewline }
                catch { $rollbackFailures += "active launcher restore failed: $($_.Exception.Message)" }
            }
            if (Test-Path -LiteralPath $mergedLauncher) {
                try { Remove-Item -LiteralPath $mergedLauncher -Force }
                catch { $rollbackFailures += "could not remove incomplete '$mergedLauncher': $($_.Exception.Message)" }
            }
            try {
                if ($continuedAcceptance) {
                    Set-Content -LiteralPath $markerPath -Value $previousMarkerContent -Encoding utf8 -NoNewline
                } elseif (Test-Path -LiteralPath $markerPath) {
                    Remove-Item -LiteralPath $markerPath -Force
                }
            } catch {
                $rollbackFailures += "could not restore merged marker '$markerPath': $($_.Exception.Message)"
            }
            try {
                $currentStore = Read-AshAtlasLeaseStore $LeasePath
                $currentLease = @($currentStore.runtimes | Where-Object { [string]$_.runtime_id -eq [string]$runtime.runtime_id } | Select-Object -First 1)
                $currentStatus = if ($currentLease.Count -eq 1) { [string](Get-AshAtlasObjectPropertyValue $currentLease[0] 'integration_status' 'active') } else { 'missing' }
            } catch { $currentStatus = "unreadable ($($_.Exception.Message))" }
            $activeExists = $activeLauncher -and (Test-Path -LiteralPath $activeLauncher)
            $state = "active=$([bool]$activeExists); marker=$([bool](Test-Path -LiteralPath $markerPath)); archived=$([bool](Test-Path -LiteralPath $mergedLauncher)); lease_status=$currentStatus"
            $rollback = if ($rollbackFailures.Count) { " Rollback problems: $($rollbackFailures -join '; ')." } else { ' Visible merged state was rolled back.' }
            throw "mark-merged failed: $failure. Incomplete state: $state.$rollback"
        } finally {
            foreach ($path in @($markerTemporary, $receiptTemporary)) {
                if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
            }
        }
        Write-Host "Feature merged into Integration Test: $displayName" -ForegroundColor Green
        Write-Host "Historical name-derived generation: $runtimeBaseGeneration"
        Write-Host "Started from: $baseGeneration"
        Write-Host "Included in: $MergedTestGeneration"
        Write-Host "Integration SHA: $MergedTestSha"
        Write-Host "Archived launcher: $mergedLauncher"
    } finally {
        if ($null -ne $leaseMutex) { Exit-AshAtlasLeaseStoreMutex $leaseMutex }
    }
    Retire-MergedRuntimeReservation $runtime
}

function Remove-RegisteredRuntime($Registration, [switch]$AcceptedIntegrationCleanup) {
    $lease = $Registration.lease
    if ([string](Get-AshAtlasObjectPropertyValue $lease 'integration_status' '') -eq 'merged_to_test' -and -not $AcceptedIntegrationCleanup) {
        throw 'REFUSED: a merged runtime must be removed by ownership-verified cleanup so its archived receipt remains authoritative.'
    }
    $launcherPath = [string](Get-AshAtlasObjectPropertyValue $lease 'launcher_path' '')
    if ($launcherPath -and (Test-Path -LiteralPath $launcherPath) -and -not (Test-AshAtlasGeneratedLauncher $launcherPath $lease.runtime_id $LauncherRoot)) {
        throw "REFUSED: registered launcher is not safely owned: $launcherPath"
    }
    Assert-FeatureResourceOwnership $lease
    & (Join-Path $PSScriptRoot 'run-main.ps1') -RuntimeMode Feature -WorktreePath ([string]$lease.worktree) `
        -RemoveFeature -AcceptedIntegrationCleanup:$AcceptedIntegrationCleanup
    if ($LASTEXITCODE -ne 0) { throw "Runtime removal failed for $($lease.runtime_id)." }
    if ($launcherPath -and (Test-Path -LiteralPath $launcherPath)) { Remove-Item -LiteralPath $launcherPath -Force }
}

function Retire-MergedRuntimeReservation($Runtime) {
    $registration = Find-OptionalRegisteredLease $Runtime.worktree
    if ($null -eq $registration) { return }
    if ([string](Get-AshAtlasObjectPropertyValue $registration.lease 'integration_status' '') -ne 'merged_to_test') {
        throw 'REFUSED: only an exactly marked merged runtime can be retired automatically.'
    }
    if ($env:ASH_ATLAS_RUNTIME_TEST_MODE -eq '1') {
        $leaseMutex = Enter-AshAtlasLeaseStoreMutex
        try {
            $store = Read-AshAtlasLeaseStore $LeasePath
            $store.runtimes = @($store.runtimes | Where-Object { [string]$_.runtime_id -ne [string]$Runtime.runtime_id })
            Write-AshAtlasLeaseStore $store $LeasePath
        } finally {
            Exit-AshAtlasLeaseStoreMutex $leaseMutex
        }
        Write-Host "Retired merged runtime reservation in isolated test mode." -ForegroundColor Green
        return
    }
    $runtimeRoot = Join-Path (Split-Path -Parent $LeasePath) ("runtimes\" + [string]$Runtime.runtime_id)
    $cleanupMarker = Join-Path $runtimeRoot 'cleanup-in-progress'
    New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
    [IO.File]::WriteAllText($cleanupMarker, (Get-Date).ToUniversalTime().ToString('o'), [Text.Encoding]::ASCII)
    try {
        Remove-RegisteredRuntime $registration -AcceptedIntegrationCleanup
    } finally {
        if (Test-Path -LiteralPath $cleanupMarker -PathType Leaf) { Remove-Item -LiteralPath $cleanupMarker -Force }
        if ((Test-Path -LiteralPath $runtimeRoot -PathType Container) -and
            @(Get-ChildItem -LiteralPath $runtimeRoot -Force).Count -eq 0) {
            Remove-Item -LiteralPath $runtimeRoot -Force
        }
    }
    Write-Host "Retired merged runtime reservation; archived receipt and worktree marker remain." -ForegroundColor Green
}

function Get-ProcessIdsUsingWorktree([string]$Path) {
    $escaped = [regex]::Escape([IO.Path]::GetFullPath($Path).TrimEnd('\'))
    return @(
        Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            Where-Object { [string]$_.CommandLine -match $escaped } |
            ForEach-Object { [int]$_.ProcessId }
    )
}

function Get-ProcessTreeIds([int[]]$RootIds) {
    $processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $ids = [System.Collections.Generic.HashSet[int]]::new()
    $queue = [System.Collections.Generic.Queue[int]]::new()
    foreach ($rootId in $RootIds) { if ($ids.Add($rootId)) { $queue.Enqueue($rootId) } }
    while ($queue.Count -gt 0) {
        $parent = $queue.Dequeue()
        foreach ($child in @($processes | Where-Object { [int]$_.ParentProcessId -eq $parent })) {
            $childId = [int]$child.ProcessId
            if ($ids.Add($childId)) { $queue.Enqueue($childId) }
        }
    }
    return @($ids)
}

function Invoke-Remove {
    $registration = Find-RegisteredLease $WorktreePath
    Remove-RegisteredRuntime $registration
    Write-Host "Removed generated launcher and disposable runtime for $($registration.lease.runtime_id)." -ForegroundColor Green
}

function Invoke-Cleanup {
    $runtime = Resolve-FeatureWorktree $WorktreePath
    $registration = Find-OptionalRegisteredLease $runtime.worktree
    $lease = if ($null -ne $registration) { $registration.lease } else { $null }
    if ($null -ne $lease -and
        ([string]$runtime.runtime_id -ne [string]$lease.runtime_id -or [string]$runtime.branch -ne [string]$lease.branch)) {
        throw 'REFUSED: worktree branch no longer matches its registered runtime identity.'
    }
    $permanent = [IO.Path]::GetFullPath([string]$Config.permanent_checkout).TrimEnd('\')
    Assert-ExactPath $SupervisorRoot $permanent 'Post-merge cleanup supervisor checkout'
    Assert-ExactPath (Get-AshAtlasGitValue $permanent @('rev-parse', '--show-toplevel')) $permanent 'Permanent checkout'
    $permanentBranch = Get-AshAtlasGitValue $permanent @('branch', '--show-current')
    if ($permanentBranch -ne [string]$Config.main.branch) { throw "Permanent checkout must remain on $($Config.main.branch)." }
    & git -C $permanent fetch origin --prune
    if ($LASTEXITCODE -ne 0) { throw 'Could not fetch origin with pruning.' }
    $targetRef = if ($IntegratedRef) { $IntegratedRef } else { 'origin/master' }
    if ($targetRef -notmatch '^origin/[A-Za-z0-9][A-Za-z0-9._/-]*$' -or
        $targetRef.Contains('..') -or $targetRef.Contains('//') -or $targetRef.EndsWith('/')) {
        throw "REFUSED: -IntegratedRef must name a safe origin remote-tracking branch, not '$targetRef'."
    }
    & git -C $permanent show-ref --verify --quiet "refs/remotes/$targetRef"
    if ($LASTEXITCODE -ne 0) { throw "REFUSED: integrated remote ref '$targetRef' does not exist after fetch." }
    $integratedSha = Get-AshAtlasGitValue $permanent @('rev-parse', "$targetRef^{commit}")
    $head = Get-AshAtlasGitValue $runtime.worktree @('rev-parse', 'HEAD')
    & git -C $permanent merge-base --is-ancestor $head $integratedSha
    if ($LASTEXITCODE -ne 0) { throw "REFUSED: $targetRef at $integratedSha does not contain feature commit $head." }
    $mergedMarkerPath = Join-Path $runtime.worktree '__MERGED_TO_TEST__.md'
    $markerIdentity = Read-MergedMarkerIdentity $mergedMarkerPath
    $integrationStatus = if ($null -ne $lease) { [string](Get-AshAtlasObjectPropertyValue $lease 'integration_status' '') } else { '' }
    $allowedDirtyLine = ''
    if ($integrationStatus -or $null -ne $markerIdentity) {
        if ($null -ne $lease -and $integrationStatus -ne 'merged_to_test') {
            throw "REFUSED: unsupported feature integration status '$integrationStatus'."
        }
        if ($null -eq $markerIdentity) { throw 'REFUSED: accepted feature is missing its merged worktree marker.' }
        $baseGeneration = if ($null -ne $lease) {
            [string](Get-AshAtlasObjectPropertyValue $lease 'base_test_generation' '')
        } else { [string]$markerIdentity.base_test_generation }
        $baseSha = if ($null -ne $lease) {
            [string](Get-AshAtlasObjectPropertyValue $lease 'base_test_sha' '')
        } else { [string]$markerIdentity.base_test_sha }
        $mergedGeneration = if ($null -ne $lease) {
            [string](Get-AshAtlasObjectPropertyValue $lease 'merged_test_generation' '')
        } else { [string]$markerIdentity.merged_test_generation }
        $mergedSha = if ($null -ne $lease) {
            [string](Get-AshAtlasObjectPropertyValue $lease 'merged_test_sha' '')
        } else { [string]$markerIdentity.merged_test_sha }
        $mergedAt = if ($null -ne $lease) {
            [string](Get-AshAtlasObjectPropertyValue $lease 'merged_at_utc' '')
        } else { [string]$markerIdentity.merged_at_utc }
        $mergedBatchOperationId = if ($null -ne $lease) {
            [string](Get-AshAtlasObjectPropertyValue $lease 'merged_batch_operation_id' '')
        } else { [string]$markerIdentity.batch_operation_id }
        $displayName = if ($null -ne $lease) {
            [string](Get-AshAtlasObjectPropertyValue $lease 'display_name' '')
        } else { [string]$markerIdentity.display_name }
        $archivedLauncher = if ($null -ne $lease) {
            [string](Get-AshAtlasObjectPropertyValue $lease 'merged_launcher_path' '')
        } else { Get-AshAtlasMergedLauncherPath $LauncherRoot $displayName $baseGeneration $mergedGeneration }
        if (-not $baseGeneration -or -not $mergedGeneration -or $baseSha -notmatch '^[0-9a-f]{40}$' -or
            $mergedSha -notmatch '^[0-9a-f]{40}$' -or -not $mergedAt -or -not $displayName -or -not $archivedLauncher) {
            throw 'REFUSED: accepted feature is missing its exact receipt identity.'
        }
        if ([string]$markerIdentity.branch -ne [string]$runtime.branch -or
            [string]$markerIdentity.base_test_generation -ne $baseGeneration -or
            [string]$markerIdentity.base_test_sha -ne $baseSha -or
            [string]$markerIdentity.merged_test_generation -ne $mergedGeneration -or
            [string]$markerIdentity.merged_test_sha -ne $mergedSha -or
            [string]$markerIdentity.merged_at_utc -ne $mergedAt -or
            [string]$markerIdentity.batch_operation_id -ne $mergedBatchOperationId -or
            [string]$markerIdentity.display_name -ne $displayName) {
            throw 'REFUSED: merged worktree marker differs from the accepted feature identity.'
        }
        if ($targetRef -eq 'origin/integration/test' -and $mergedSha -ne $integratedSha) {
            $acceptedAncestor = Invoke-AshAtlasNative git @('-C', $permanent, 'merge-base', '--is-ancestor', $mergedSha, $integratedSha)
            if ($acceptedAncestor.ExitCode -ne 0) { throw "REFUSED: $targetRef does not contain recorded merged SHA $mergedSha." }
        }
        $tagSha = Get-AshAtlasGitValue $permanent @('rev-parse', "refs/tags/test/$mergedGeneration^{commit}")
        if ($tagSha -ne $mergedSha) { throw "REFUSED: test/$mergedGeneration does not point to recorded merged SHA $mergedSha." }
        $expectedArchivedLauncher = Get-AshAtlasMergedLauncherPath $LauncherRoot $displayName $baseGeneration $mergedGeneration
        Assert-ExactPath $archivedLauncher $expectedArchivedLauncher 'Archived merged launcher'
        $expectedReceipt = Add-BatchMergedIdentity `
            (New-AshAtlasMergedLauncherContent $displayName $runtime.branch $head `
                $baseGeneration $baseSha $mergedGeneration $mergedSha) `
            $mergedBatchOperationId -Launcher
        if (-not (Test-Path -LiteralPath $archivedLauncher -PathType Leaf) -or
            (Get-Content -Raw -LiteralPath $archivedLauncher) -cne $expectedReceipt) {
            throw "REFUSED: archived merged launcher is missing or differs from the stored receipt: $archivedLauncher"
        }
        $expectedMarker = Add-BatchMergedIdentity `
            (New-AshAtlasMergedMarkerContent $displayName $runtime.branch $baseGeneration $baseSha `
                $mergedGeneration $mergedSha $mergedAt) `
            $mergedBatchOperationId
        if (-not (Test-Path -LiteralPath $mergedMarkerPath -PathType Leaf) -or
            (Get-Content -Raw -LiteralPath $mergedMarkerPath) -cne $expectedMarker) {
            throw "REFUSED: merged worktree marker is missing or differs from the stored receipt: $mergedMarkerPath"
        }
        $activeLauncher = [string](Get-AshAtlasObjectPropertyValue $lease 'launcher_path' '')
        if ($activeLauncher -and (Test-Path -LiteralPath $activeLauncher)) {
            throw "REFUSED: merged feature still has an active launcher: $activeLauncher"
        }
        $allowedDirtyLine = '?? __MERGED_TO_TEST__.md'
    } else {
        $mergedMarkerPath = ''
    }
    $dirty = @((Get-AshAtlasGitValue $runtime.worktree @('status', '--porcelain=v1', '--untracked-files=all')) -split '\r?\n' | Where-Object { $_ })
    $unexpectedDirty = @($dirty | Where-Object { -not $allowedDirtyLine -or $_ -cne $allowedDirtyLine })
    if ($unexpectedDirty.Count -gt 0 -or ($allowedDirtyLine -and $dirty.Count -ne 1)) {
        throw "REFUSED: feature worktree has unexpected changes.`n$($dirty -join [Environment]::NewLine)"
    }
    $untracked = @((Get-AshAtlasGitValue $runtime.worktree @('ls-files', '--others', '--exclude-standard')) -split '\r?\n' | Where-Object { $_ })
    $unexpectedUntracked = @($untracked | Where-Object { -not $allowedDirtyLine -or $_ -cne '__MERGED_TO_TEST__.md' })
    if ($unexpectedUntracked.Count -gt 0 -or ($allowedDirtyLine -and $untracked.Count -ne 1)) {
        throw "REFUSED: feature worktree has unique untracked files.`n$($untracked -join [Environment]::NewLine)"
    }
    if ($null -ne $lease) { Assert-FeatureResourceOwnership $lease }
    else { Assert-NoUnregisteredFeatureRuntimeArtifacts $runtime }
    $ownedRoots = if ($null -ne $lease) { @(Get-LiveOwnedProcessRecords $lease | ForEach-Object { [int]$_.pid }) } else { @() }
    $ownedPids = @(Get-ProcessTreeIds $ownedRoots)
    $pathPids = @(Get-ProcessIdsUsingWorktree $runtime.worktree)
    $unknownPids = @($pathPids | Where-Object { $ownedPids -notcontains $_ -and $_ -ne $PID })
    if ($unknownPids.Count -gt 0) { throw "REFUSED: unowned processes reference the feature worktree: $($unknownPids -join ', ')." }

    $cleanupRoot = Join-Path (Split-Path -Parent $LeasePath) ("runtimes\" + [string]$runtime.runtime_id)
    New-Item -ItemType Directory -Path $cleanupRoot -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $cleanupRoot 'cleanup-in-progress'), (Get-Date).ToUniversalTime().ToString('o'), [Text.Encoding]::ASCII)
    if ($null -ne $registration) { Remove-RegisteredRuntime $registration -AcceptedIntegrationCleanup:($integrationStatus -eq 'merged_to_test') }
    $remainingPids = @(Get-ProcessIdsUsingWorktree $runtime.worktree | Where-Object { $_ -ne $PID })
    if ($remainingPids.Count -gt 0) { throw "REFUSED: processes still use the feature worktree: $($remainingPids -join ', ')." }
    if ($mergedMarkerPath) {
        Remove-Item -LiteralPath $mergedMarkerPath -Force
        $remainingWorktreeChanges = Get-AshAtlasGitValue $runtime.worktree @('status', '--porcelain=v1', '--untracked-files=all')
        if ($remainingWorktreeChanges) {
            throw "REFUSED: worktree did not become clean after removing its verified merged marker.`n$remainingWorktreeChanges"
        }
    }
    & git -C $permanent worktree remove $runtime.worktree
    if ($LASTEXITCODE -ne 0) { throw 'Git refused to remove the feature worktree.' }
    & git -C $permanent branch --delete --force $runtime.branch
    if ($LASTEXITCODE -ne 0) { throw "Git refused to delete the local feature branch proven contained by $targetRef." }
    $remote = @(& git -C $permanent ls-remote --heads origin $runtime.branch)
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the remote feature branch.' }
    if ($remote.Count -gt 0) {
        & git -C $permanent push origin --delete $runtime.branch
        if ($LASTEXITCODE -ne 0) { throw 'Could not delete the merged remote feature branch.' }
    }
    & git -C $permanent worktree prune
    if ($LASTEXITCODE -ne 0) { throw 'git worktree prune failed.' }
    & git -C $permanent fetch origin --prune
    if ($LASTEXITCODE -ne 0) { throw 'Final fetch with pruning failed.' }
    if ($null -eq $registration) {
        $cleanupMarker = Join-Path $cleanupRoot 'cleanup-in-progress'
        if (Test-Path -LiteralPath $cleanupMarker -PathType Leaf) { Remove-Item -LiteralPath $cleanupMarker -Force }
        if ((Test-Path -LiteralPath $cleanupRoot -PathType Container) -and
            @(Get-ChildItem -LiteralPath $cleanupRoot -Force).Count -eq 0) {
            Remove-Item -LiteralPath $cleanupRoot -Force
        }
    }
    Write-Host "Post-integration cleanup completed for $($runtime.branch); verified in $targetRef at $integratedSha." -ForegroundColor Green
}

if ($Operation -ne 'cleanup' -and $IntegratedRef) {
    throw '-IntegratedRef is valid only with cleanup.'
}
if ($Operation -ne 'mark-merged' -and
    ($MergedTestGeneration -or $MergedTestSha -or $EffectiveBaseTestGeneration -or $EffectiveBaseTestSha -or
     $BatchOperationId -or $ConfirmAcceptedIntegration)) {
    throw '-MergedTestGeneration, -MergedTestSha, -EffectiveBaseTestGeneration, -EffectiveBaseTestSha, -BatchOperationId, and -ConfirmAcceptedIntegration are valid only with mark-merged.'
}

switch ($Operation) {
    'create' { Invoke-Create }
    'sync' { Invoke-Sync }
    'status' { Invoke-Status }
    'ready' { Invoke-Ready }
    'park' { Invoke-Park }
    'mark-merged' { Invoke-MarkMerged }
    'remove' { Invoke-Remove }
    'cleanup' { Invoke-Cleanup }
}
