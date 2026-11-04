$ErrorActionPreference = "Stop"

$GameRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$MapRepository = "C:\Users\dev\Documents\world-pipeline"
$ReleaseRoot = "C:\Users\dev\Documents\world-pipeline\data\intermediate\global-packages\world-packages-v1"
$TestLogRoot = Join-Path $env:TEMP "ash-atlas-advanced-flag-intelligence-world-api-tests"
$Passed = 0
$Failed = 0

. (Join-Path $PSScriptRoot "advanced-flag-world-api.ps1")

function Assert-True {
    param([bool]$Condition, [string]$Message)

    if (-not $Condition) { throw $Message }
}

function Assert-Equal {
    param([AllowNull()][object]$Actual, [AllowNull()][object]$Expected, [string]$Message)

    if ($Actual -ne $Expected) {
        throw "$Message (expected '$Expected', got '$Actual')"
    }
}

function Invoke-Test {
    param([string]$Name, [scriptblock]$Body)

    try {
        & $Body
        $script:Passed++
        Write-Host "PASS $Name" -ForegroundColor Green
    } catch {
        $script:Failed++
        Write-Host "FAIL $Name`: $($_.Exception.Message)" -ForegroundColor Red
    }
}

function Get-FreeTcpPort {
    $listener = [System.Net.Sockets.TcpListener]::new(
        [System.Net.IPAddress]::Loopback,
        0
    )
    $listener.Start()
    try {
        return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
    } finally {
        $listener.Stop()
    }
}

function New-CompatibleHealth {
    return [pscustomobject]@{
        ok = $true
        release = [pscustomobject]@{
            release_id = $script:ExpectedWorldReleaseId
            profile_set_fingerprint = $script:ExpectedWorldProfileFingerprint
            build_contract_fingerprint = $script:ExpectedWorldContractFingerprint
            boundary_release_id = $script:ExpectedWorldBoundaryReleaseId
            package_count = $script:ExpectedWorldPackageCount
        }
        river_surface = [pscustomobject]@{
            mode = [string]$script:ExpectedRiverSurface.release_id
            cell_size_m = [int]$script:ExpectedRiverSurface.cell_size_m
            identity = [pscustomobject]@{
                release_id = [string]$script:ExpectedRiverSurface.release_id
                manifest_sha256 = [string]$script:ExpectedRiverSurface.manifest_sha256
                policy = [string]$script:ExpectedRiverSurface.policy
            }
            cache = [pscustomobject]@{ max_packages = 12 }
        }
    }
}

function New-CompatibleLookup {
    return [pscustomobject]@{
        profile = [pscustomobject]@{
            environment_schema_version = $script:ExpectedWorldSchema
            environment = [pscustomobject]@{
                ecology_resolution = "exact"
                ecology_search_complete = $true
                land_cover_conflict = $false
                coastline_search_radius_m = 100000
                coastline_search_complete = $true
                coastal_threshold_m = 5000
            }
            water = [pscustomobject]@{
                nearest_water_resolution = "within_search_radius"
                nearest_water_search_radius_m = 100000
                nearest_water_search_complete = $true
                named_river_search_radius_m = 100000
                named_river_search_complete = $true
                major_lake_search_radius_m = 100000
                major_lake_search_complete = $true
                supporting_river_search_radius_m = 100000
                supporting_river_search_complete = $true
            }
        }
    }
}

Invoke-Test "compatible v2 contract is accepted" {
    $result = Test-FeatureWorldApiCompatibility (New-CompatibleHealth) (New-CompatibleLookup)
    Assert-True $result.Compatible $result.Message
}

Invoke-Test "v1 runtime is rejected with an exact diagnostic" {
    $lookup = New-CompatibleLookup
    $lookup.profile.environment_schema_version = "world-profile-v1"
    $result = Test-FeatureWorldApiCompatibility (New-CompatibleHealth) $lookup
    Assert-True (-not $result.Compatible) "v1 lookup was unexpectedly accepted"
    Assert-Equal $result.Message "Incompatible World API runtime: expected world-profile-v2" "v1 diagnostic changed"
}

Invoke-Test "wrong release identity is rejected" {
    $health = New-CompatibleHealth
    $health.release.release_id = "wrong-release"
    $result = Test-FeatureWorldApiCompatibility $health (New-CompatibleLookup)
    Assert-True (-not $result.Compatible) "wrong release was unexpectedly accepted"
    Assert-True ($result.Message -like "Incompatible World API release:*") "wrong-release diagnostic was not specific"
}

Invoke-Test "missing v2 contract key is rejected" {
    $lookup = New-CompatibleLookup
    $lookup.profile.water.PSObject.Properties.Remove("nearest_water_search_complete")
    $result = Test-FeatureWorldApiCompatibility (New-CompatibleHealth) $lookup
    Assert-True (-not $result.Compatible) "incomplete v2 lookup was unexpectedly accepted"
    Assert-True ($result.Message -like "*nearest_water_search_complete") "missing-key diagnostic omitted the key"
}

Invoke-Test "no listener never reports ready" {
    $port = Get-FreeTcpPort
    $threw = $false
    try {
        Get-FeatureWorldApiSnapshot "http://127.0.0.1:$port" 1 | Out-Null
    } catch {
        $threw = $true
    }
    Assert-True $threw "an unused port was reported as ready"
}

Invoke-Test "canonical World API provides the real locked compatibility contract" {
    $ownersBefore = @(Get-FeatureWorldApiPortOwners 8765)
    Assert-True ($ownersBefore.Count -eq 1) "canonical World API must be running on port 8765 for the real compatibility smoke"
    $reused = Start-FeatureWorldApi `
        -MapRepository $MapRepository `
        -ReleaseRoot $ReleaseRoot `
        -LogRoot $TestLogRoot `
        -Port 8765 `
        -StartupTimeoutSeconds 10
    Assert-True (-not $reused.Owned) "existing compatible service was claimed as owned"
    Assert-Equal $reused.ProcessId $ownersBefore[0] "reused PID differs"
    Assert-Equal $reused.SourceRoot (Join-Path $MapRepository "src") "World API source root differs"
    Assert-Equal $reused.Lookup.profile.environment_schema_version "world-profile-v2" "real lookup schema differs"
    Assert-Equal $reused.Resource.contract_version "resource-environment-v1" "real resource lookup contract differs"
    Assert-True (Test-FeatureWorldApiProperty $reused.Lookup.profile.environment "ecology_resolution") "real lookup lacks ecology resolution"
    Assert-True (Test-FeatureWorldApiProperty $reused.Lookup.profile.water "nearest_water_resolution") "real lookup lacks water resolution"
    Stop-FeatureWorldApi $reused
    Assert-True ($null -ne (Get-Process -Id $ownersBefore[0] -ErrorAction SilentlyContinue)) "reuse cleanup stopped the shared service"
}

Invoke-Test "failed Python startup reports stderr and leaves no listener" {
    $port = Get-FreeTcpPort
    $message = $null
    try {
        Start-FeatureWorldApi `
            -MapRepository $MapRepository `
            -ReleaseRoot $ReleaseRoot `
            -LogRoot (Join-Path $TestLogRoot "failed-python") `
            -Port $port `
            -PythonExecutable "powershell.exe" `
            -StartupTimeoutSeconds 10 | Out-Null
    } catch {
        $message = $_.Exception.Message
    }
    Assert-True ($null -ne $message) "failed executable was not reported"
    Assert-True ($message -like "*World API process exited*") "failure omitted process-exit context"
    Assert-True ($message -like "*World API stderr*") "failure omitted stderr context"
    Assert-Equal @(Get-FeatureWorldApiPortOwners $port).Count 0 "failed startup left a listener"
}

Write-Host "Launcher smoke tests: $Passed passed, $Failed failed."
if ($Failed -gt 0) { exit 1 }
