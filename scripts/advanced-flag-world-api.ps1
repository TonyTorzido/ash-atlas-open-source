$ErrorActionPreference = "Stop"

$script:WorldRuntimeLockPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\config\world-runtime.lock.json"))
if (-not (Test-Path -LiteralPath $script:WorldRuntimeLockPath -PathType Leaf)) {
    throw "World runtime lock is missing: $($script:WorldRuntimeLockPath)"
}
$script:WorldRuntimeLock = Get-Content -Raw -LiteralPath $script:WorldRuntimeLockPath | ConvertFrom-Json
$script:ExpectedWorldRuntimeBranch = [string]$script:WorldRuntimeLock.pipeline.protected_branch
$script:ExpectedWorldRuntimeSha = [string]$script:WorldRuntimeLock.pipeline.sha
$script:ExpectedWorldReleaseId = [string]$script:WorldRuntimeLock.release.release_id
$script:ExpectedWorldProfileFingerprint = [string]$script:WorldRuntimeLock.release.profile_set_fingerprint
$script:ExpectedWorldContractFingerprint = [string]$script:WorldRuntimeLock.release.build_contract_fingerprint
$script:ExpectedWorldBoundaryReleaseId = [string]$script:WorldRuntimeLock.release.boundary_release_id
$script:ExpectedWorldPackageCount = [int]$script:WorldRuntimeLock.release.package_count
$script:ExpectedRiverSurface = $script:WorldRuntimeLock.river_surface
$script:ExpectedWorldSchema = "world-profile-v2"
$script:WorldLookupLatitude = 35.087035
$script:WorldLookupLongitude = -106.674748

function Get-FeatureWorldApiPortOwners {
    param([Parameter(Mandatory)][int]$Port)

    return @(
        Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique
    )
}

function Test-FeatureWorldApiProperty {
    param(
        [AllowNull()][object]$InputObject,
        [Parameter(Mandatory)][string]$Name
    )

    return $null -ne $InputObject -and $null -ne $InputObject.PSObject.Properties[$Name]
}

function Test-FeatureWorldApiCompatibility {
    param(
        [Parameter(Mandatory)][object]$Health,
        [Parameter(Mandatory)][object]$Lookup
    )

    if ($Health.ok -ne $true) {
        return [pscustomobject]@{ Compatible = $false; Message = "World API health did not report ok=true." }
    }
    $release = $Health.release
    if ($null -eq $release -or
        $release.release_id -ne $script:ExpectedWorldReleaseId -or
        $release.profile_set_fingerprint -ne $script:ExpectedWorldProfileFingerprint -or
        $release.build_contract_fingerprint -ne $script:ExpectedWorldContractFingerprint -or
        $release.boundary_release_id -ne $script:ExpectedWorldBoundaryReleaseId -or
        [int]$release.package_count -ne $script:ExpectedWorldPackageCount) {
        return [pscustomobject]@{
            Compatible = $false
            Message = "Incompatible World API release: expected $($script:ExpectedWorldReleaseId) with the published fingerprints and $($script:ExpectedWorldPackageCount) packages."
        }
    }
    $riverSurface = $Health.river_surface
    if ($null -eq $riverSurface -or
        $riverSurface.mode -ne [string]$script:ExpectedRiverSurface.release_id -or
        $riverSurface.identity.release_id -ne [string]$script:ExpectedRiverSurface.release_id -or
        $riverSurface.identity.manifest_sha256 -ne [string]$script:ExpectedRiverSurface.manifest_sha256 -or
        $riverSurface.identity.policy -ne [string]$script:ExpectedRiverSurface.policy -or
        [int]$riverSurface.cell_size_m -ne [int]$script:ExpectedRiverSurface.cell_size_m -or
        [int]$riverSurface.cache.max_packages -ne 12) {
        return [pscustomobject]@{
            Compatible = $false
            Message = "Incompatible World API river surface: expected the locked river-surface-v1 identity and bounded cache."
        }
    }

    if ($Lookup.profile.environment_schema_version -ne $script:ExpectedWorldSchema) {
        return [pscustomobject]@{
            Compatible = $false
            Message = "Incompatible World API runtime: expected world-profile-v2"
        }
    }

    $requiredEnvironmentKeys = @(
        "ecology_resolution",
        "ecology_search_complete",
        "land_cover_conflict",
        "coastline_search_radius_m",
        "coastline_search_complete",
        "coastal_threshold_m"
    )
    $requiredWaterKeys = @(
        "nearest_water_resolution",
        "nearest_water_search_radius_m",
        "nearest_water_search_complete",
        "named_river_search_radius_m",
        "named_river_search_complete",
        "major_lake_search_radius_m",
        "major_lake_search_complete",
        "supporting_river_search_radius_m",
        "supporting_river_search_complete"
    )
    foreach ($key in $requiredEnvironmentKeys) {
        if (-not (Test-FeatureWorldApiProperty $Lookup.profile.environment $key)) {
            return [pscustomobject]@{
                Compatible = $false
                Message = "Incompatible World API runtime: expected world-profile-v2 contract key profile.environment.$key"
            }
        }
    }
    foreach ($key in $requiredWaterKeys) {
        if (-not (Test-FeatureWorldApiProperty $Lookup.profile.water $key)) {
            return [pscustomobject]@{
                Compatible = $false
                Message = "Incompatible World API runtime: expected world-profile-v2 contract key profile.water.$key"
            }
        }
    }
    return [pscustomobject]@{
        Compatible = $true
        Message = "Compatible world-profile-v2 runtime."
    }
}

function Get-FeatureWorldApiSnapshot {
    param(
        [Parameter(Mandatory)][string]$BaseUrl,
        [int]$TimeoutSeconds = 5
    )

    $health = Invoke-RestMethod -Uri "$BaseUrl/api/health" -TimeoutSec $TimeoutSeconds
    $lookup = Invoke-RestMethod -Uri "$BaseUrl/api/lookup?lat=$($script:WorldLookupLatitude)&lon=$($script:WorldLookupLongitude)" -TimeoutSec ([Math]::Max($TimeoutSeconds, 30))
    $resourceBody = @{
        points = @(@{
            latitude = $script:WorldLookupLatitude
            longitude = $script:WorldLookupLongitude
        })
    } | ConvertTo-Json -Depth 4 -Compress
    $resource = Invoke-RestMethod `
        -Method Post `
        -Uri "$BaseUrl/api/resource-environment-batch" `
        -ContentType "application/json" `
        -Body $resourceBody `
        -TimeoutSec ([Math]::Max($TimeoutSeconds, 30))
    if ($resource.contract_version -ne "resource-environment-v1" -or
        $resource.release.release_id -ne $script:ExpectedWorldReleaseId -or
        @($resource.results).Count -ne 1) {
        throw "Incompatible World API runtime: expected resource-environment-v1"
    }
    return [pscustomobject]@{
        Health = $health
        Lookup = $lookup
        Resource = $resource
        Compatibility = Test-FeatureWorldApiCompatibility $health $lookup
    }
}

function Get-FeatureWorldApiErrorTail {
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return "World API stderr log was not created: $Path"
    }
    $tail = @(Get-Content -LiteralPath $Path -Tail 60 -ErrorAction SilentlyContinue)
    if ($tail.Count -gt 0) {
        return $tail -join [Environment]::NewLine
    }
    return "World API stderr log is empty: $Path"
}

function Stop-FeatureWorldApi {
    param([AllowNull()][object]$State)

    if ($null -eq $State -or $State.Owned -ne $true -or $null -eq $State.ProcessId) {
        return
    }
    $process = Get-Process -Id ([int]$State.ProcessId) -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        return
    }
    if ($State.StartTime -and $process.StartTime.ToUniversalTime().ToString("o") -ne $State.StartTime) {
        throw "Refusing to stop PID $($State.ProcessId) because it no longer matches the launcher-owned process."
    }
    Stop-Process -Id $process.Id -ErrorAction SilentlyContinue
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline -and (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) {
        Start-Sleep -Milliseconds 250
    }
    if (Get-Process -Id $process.Id -ErrorAction SilentlyContinue) {
        throw "Launcher-owned World API PID $($process.Id) did not exit."
    }
}

function Start-FeatureWorldApi {
    param(
        [Parameter(Mandatory)][string]$MapRepository,
        [Parameter(Mandatory)][string]$ReleaseRoot,
        [Parameter(Mandatory)][string]$LogRoot,
        [int]$Port = 8765,
        [ValidateRange(1, 256)][int]$CachePackages = 64,
        [string]$PythonExecutable = "python",
        [int]$StartupTimeoutSeconds = 300
    )

    $mapRoot = (Resolve-Path -LiteralPath $MapRepository).Path
    $mapSha = (& git -C $mapRoot rev-parse HEAD).Trim()
    $mapBranch = (& git -C $mapRoot branch --show-current).Trim()
    if ($mapSha -notmatch '^[0-9a-f]{40}$' -or [string]::IsNullOrWhiteSpace($mapBranch)) {
        throw "Map repository did not provide an exact branch and Git SHA: $mapRoot"
    }
    if ($mapBranch -ne $script:ExpectedWorldRuntimeBranch -or $mapSha -ne $script:ExpectedWorldRuntimeSha) {
        throw "Map repository identity '$mapBranch' @ '$mapSha' does not match locked runtime '$($script:ExpectedWorldRuntimeBranch)' @ '$($script:ExpectedWorldRuntimeSha)'."
    }
    $sourceRoot = (Resolve-Path -LiteralPath (Join-Path $mapRoot "src")).Path
    $resolvedReleaseRoot = (Resolve-Path -LiteralPath $ReleaseRoot).Path
    $riverSurfaceReleaseRoot = (Resolve-Path -LiteralPath (Join-Path (Split-Path -Parent $resolvedReleaseRoot) ([string]$script:ExpectedRiverSurface.release_id))).Path
    foreach ($required in @(
        (Join-Path $sourceRoot "map_world_pipeline\world_runtime.py"),
        (Join-Path $resolvedReleaseRoot "manifest.json"),
        (Join-Path $riverSurfaceReleaseRoot "manifest.json")
    )) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
            throw "Required World API file is missing: $required"
        }
    }

    $baseUrl = "http://127.0.0.1:$Port"
    $owners = @(Get-FeatureWorldApiPortOwners $Port)
    if ($owners.Count -gt 0) {
        $ownerLabel = $owners -join ", "
        try {
            $snapshot = Get-FeatureWorldApiSnapshot $baseUrl
        } catch {
            throw "Port $Port is occupied by PID $ownerLabel, but World API validation failed: $($_.Exception.Message)"
        }
        if ($snapshot.Compatibility.Compatible -ne $true) {
            throw "Port $Port is occupied by PID $ownerLabel. $($snapshot.Compatibility.Message)"
        }
        if ($snapshot.Health.runtime.sha -ne $mapSha) {
            throw "Port $Port is occupied by PID $ownerLabel with runtime SHA $($snapshot.Health.runtime.sha); expected $mapSha."
        }
        Write-Host "Compatible World API PID $ownerLabel is already running; reusing it." -ForegroundColor Green
        Write-Host "World API health validation: passed" -ForegroundColor Green
        Write-Host "World API schema validation: $($script:ExpectedWorldSchema)" -ForegroundColor Green
        return [pscustomobject]@{
            Owned = $false
            ProcessId = [int]$owners[0]
            StartTime = $null
            BaseUrl = $baseUrl
            SourceRoot = $sourceRoot
            ReleaseRoot = $resolvedReleaseRoot
            StandardOutputLog = $null
            StandardErrorLog = $null
            Health = $snapshot.Health
            Lookup = $snapshot.Lookup
            Resource = $snapshot.Resource
        }
    }

    New-Item -ItemType Directory -Path $LogRoot -Force | Out-Null
    $stdout = Join-Path $LogRoot "world-api.out.log"
    $stderr = Join-Path $LogRoot "world-api.err.log"
    Remove-Item -LiteralPath $stdout, $stderr -Force -ErrorAction SilentlyContinue
    $python = (Get-Command $PythonExecutable -ErrorAction Stop).Source
    $arguments = @(
        "-m", "map_world_pipeline", "serve-world-release",
        "--release-root", $resolvedReleaseRoot,
        "--host", "127.0.0.1", "--port", "$Port",
        "--cache-packages", "$CachePackages",
        "--overlay-max-features", "2000",
        "--overlay-max-packages", "64",
        "--runtime-branch", $mapBranch,
        "--runtime-sha", $mapSha,
        "--river-surface-mode", [string]$script:ExpectedRiverSurface.release_id,
        "--river-surface-release-root", $riverSurfaceReleaseRoot,
        "--river-surface-manifest-sha256", [string]$script:ExpectedRiverSurface.manifest_sha256,
        "--river-surface-policy", [string]$script:ExpectedRiverSurface.policy,
        "--river-surface-cache-packages", "12"
    )
    $command = "$python $($arguments -join ' ')"
    Write-Host "World API command: $command"
    Write-Host "Map source root: $sourceRoot"
    Write-Host "World release root: $resolvedReleaseRoot"
    Write-Host "World API logs: $stdout and $stderr"

    $previousPythonPath = $env:PYTHONPATH
    $process = $null
    try {
        $env:PYTHONPATH = $sourceRoot
        $process = Start-Process -FilePath $python -ArgumentList $arguments `
            -WorkingDirectory $mapRoot -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    } finally {
        $env:PYTHONPATH = $previousPythonPath
    }
    $state = [pscustomobject]@{
        Owned = $true
        ProcessId = $process.Id
        StartTime = $process.StartTime.ToUniversalTime().ToString("o")
        BaseUrl = $baseUrl
        SourceRoot = $sourceRoot
        ReleaseRoot = $resolvedReleaseRoot
        StandardOutputLog = $stdout
        StandardErrorLog = $stderr
        Health = $null
        Lookup = $null
        Resource = $null
    }
    Write-Host "World API PID: $($process.Id)"

    try {
        $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
        while ((Get-Date) -lt $deadline) {
            $process.Refresh()
            if ($process.HasExited) {
                $tail = Get-FeatureWorldApiErrorTail $stderr
                throw "World API process exited with code $($process.ExitCode). World API stderr:`n$tail"
            }
            try {
                $snapshot = Get-FeatureWorldApiSnapshot $baseUrl
                if ($snapshot.Compatibility.Compatible -ne $true) {
                    throw $snapshot.Compatibility.Message
                }
                $state.Health = $snapshot.Health
                $state.Lookup = $snapshot.Lookup
                $state.Resource = $snapshot.Resource
                Write-Host "World API health validation: passed" -ForegroundColor Green
                Write-Host "World API schema validation: $($script:ExpectedWorldSchema)" -ForegroundColor Green
                return $state
            } catch {
                if ($_.Exception.Message -like "Incompatible World API*") {
                    throw
                }
                Start-Sleep -Milliseconds 500
            }
        }
        $tail = Get-FeatureWorldApiErrorTail $stderr
        throw "Timed out waiting for World API readiness. World API stderr:`n$tail"
    } catch {
        Stop-FeatureWorldApi $state
        throw
    }
}
