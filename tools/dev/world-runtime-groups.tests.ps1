$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
. (Join-Path $PSScriptRoot 'runtime-lib.ps1')
$config = Read-AshAtlasRuntimeDefaults (Join-Path $root 'config\dev-runtime.defaults.json')
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

function Copy-JsonObject($Value) {
    return ($Value | ConvertTo-Json -Depth 12 | ConvertFrom-Json)
}

$admissionBudget = Get-AshAtlasWorldGroupAdmissionBudget
Assert-Equal $admissionBudget.manifest_only_health_timeout_seconds 600 'ordinary manifest-only World admission remains 600 seconds'
Assert-Equal $admissionBudget.full_health_timeout_seconds 720 'full World admission uses the measured 720-second budget'
Assert-Equal (Get-AshAtlasWorldGroupHealthTimeoutSeconds) 600 'ordinary startup selects the manifest-only budget'
Assert-Equal (Get-AshAtlasWorldGroupHealthTimeoutSeconds -FullWorldVerify) 720 'full startup selects the exhaustive budget'
Assert-Equal $admissionBudget.full_verification_mode 'exhaustive' 'full startup remains exhaustive'
Assert-Equal $admissionBudget.full_observed_peak_wall_seconds 605.532 'full budget records the observed peak wall time'
Assert-Equal $admissionBudget.full_observed_peak_private_memory_bytes ([int64]3251499008) 'full budget records the observed private memory peak'
Assert-Equal $admissionBudget.private_memory_hard_cap_bytes ([int64]4294967296) 'full budget retains the 4 GiB private memory cap'

$tempRoot = Join-Path ([IO.Path]::GetFullPath($env:TEMP)) ('ash-atlas-world-groups-tests-' + [guid]::NewGuid().ToString('n'))
$oldWorldRoot = $env:ASH_ATLAS_WORLD_RUNTIME_ROOT
$oldLeasePath = $env:ASH_ATLAS_DEV_RUNTIME_LEASE_PATH
$oldTestMode = $env:ASH_ATLAS_RUNTIME_TEST_MODE
$listener = $null
$ownedProcess = $null
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
$env:ASH_ATLAS_WORLD_RUNTIME_ROOT = Join-Path $tempRoot 'world-runtimes'
$env:ASH_ATLAS_DEV_RUNTIME_LEASE_PATH = Join-Path $tempRoot 'dev-runtimes.json'
$env:ASH_ATLAS_RUNTIME_TEST_MODE = '1'
try {
    $lockPath = Join-Path $root 'config\world-runtime.lock.json'
    $sameA = Get-AshAtlasWorldRuntimeDescriptor $lockPath
    $artifactParent = Join-Path $tempRoot 'artifacts'
    $config.release_root = Join-Path $artifactParent 'world-packages-v1'
    $riverRoot = Join-Path $artifactParent $sameA.identity.river_surface.release_id
    New-Item -ItemType Directory -Path $riverRoot -Force | Out-Null
    $riverManifest = Join-Path $riverRoot 'manifest.json'
    $riverFixture = '{"release_id":"river-surface-v1","fixture":"pinned"}'
    Set-Content -LiteralPath $riverManifest -Value $riverFixture -Encoding ascii -NoNewline
    $sameA.identity.river_surface.manifest_sha256 = Get-AshAtlasFileSha256 $riverManifest
    $sameA.group_id = Get-AshAtlasWorldGroupId $sameA.identity
    $sameA.canonical_identity = ConvertTo-AshAtlasCanonicalWorldIdentity $sameA.identity
    $sameB = Copy-JsonObject $sameA
    $preservedRiverRoot = "$riverRoot.previous-$($sameA.identity.river_surface.manifest_sha256.Substring(0, 8))"
    New-Item -ItemType Directory -Path $preservedRiverRoot -Force | Out-Null
    $preservedRiverManifest = Join-Path $preservedRiverRoot 'manifest.json'
    Copy-Item -LiteralPath $riverManifest -Destination $preservedRiverManifest
    Assert-Equal (Resolve-AshAtlasRiverSurfaceReleaseRoot $config $sameA.identity.river_surface) $riverRoot 'a matching canonical manifest takes precedence over its preserved copy'
    Set-Content -LiteralPath $riverManifest -Value 'rebuilt release' -Encoding ascii
    Assert-Equal (Resolve-AshAtlasRiverSurfaceReleaseRoot $config $sameA.identity.river_surface) $preservedRiverRoot 'an existing preserved sibling is selected only by its full pinned manifest hash'
    $duplicateRiverRoot = "$riverRoot.previous-11111111"
    New-Item -ItemType Directory -Path $duplicateRiverRoot -Force | Out-Null
    Copy-Item -LiteralPath $preservedRiverManifest -Destination (Join-Path $duplicateRiverRoot 'manifest.json')
    Assert-Throws { Resolve-AshAtlasRiverSurfaceReleaseRoot $config $sameA.identity.river_surface | Out-Null } 'found 2' 'multiple matching preserved copies fail closed rather than choosing an ambiguous path'
    Remove-Item -LiteralPath (Join-Path $duplicateRiverRoot 'manifest.json') -Force
    [IO.Directory]::Delete($duplicateRiverRoot)
    Set-Content -LiteralPath $preservedRiverManifest -Value 'wrong hash despite matching directory suffix' -Encoding ascii
    Assert-Throws { Resolve-AshAtlasRiverSurfaceReleaseRoot $config $sameA.identity.river_surface | Out-Null } 'found 0' 'a matching hash prefix in the directory name cannot authorize wrong manifest bytes'
    Remove-Item -LiteralPath $preservedRiverManifest -Force
    Remove-Item -LiteralPath $riverManifest -Force
    Assert-Throws { Resolve-AshAtlasRiverSurfaceReleaseRoot $config $sameA.identity.river_surface | Out-Null } 'found 0' 'missing current and preserved manifests fail closed'
    Set-Content -LiteralPath $preservedRiverManifest -Value $riverFixture -Encoding ascii -NoNewline
    $escapingRiver = Copy-JsonObject $sameA.identity.river_surface
    $escapingRiver.release_id = '..\outside-release'
    Assert-Throws { Resolve-AshAtlasRiverSurfaceReleaseRoot $config $escapingRiver | Out-Null } 'release ID.*invalid' 'release IDs cannot escape the configured artifacts parent'
    $outsideRoot = Join-Path $tempRoot 'outside-release'
    New-Item -ItemType Directory -Path $outsideRoot -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $outsideRoot 'manifest.json') -Value $riverFixture -Encoding ascii -NoNewline
    $junctionRoot = "$riverRoot.previous-00000000"
    New-Item -ItemType Junction -Path $junctionRoot -Target $outsideRoot | Out-Null
    try {
        Assert-Throws { Resolve-AshAtlasRiverSurfaceReleaseRoot $config $sameA.identity.river_surface | Out-Null } 'may not redirect' 'a preserved release junction cannot redirect outside the intended artifacts parent'
    } finally { [IO.Directory]::Delete($junctionRoot) }
    Set-Content -LiteralPath $riverManifest -Value $riverFixture -Encoding ascii -NoNewline
    $differentLock = Copy-JsonObject $sameA.identity
    $differentLock.pipeline.sha = '6aeea2be05fe6f64971ef7b4ffd34adb05617949'
    $differentIdentity = ConvertTo-AshAtlasWorldIdentity $differentLock
    $different = [pscustomobject][ordered]@{
        group_id = Get-AshAtlasWorldGroupId $differentIdentity
        canonical_identity = ConvertTo-AshAtlasCanonicalWorldIdentity $differentIdentity
        identity = $differentIdentity
        port = 0
    }
    Assert-Equal $sameA.group_id $sameB.group_id 'identical complete locks produce one stable group ID'
    Assert-True ($sameA.group_id -ne $different.group_id) 'different pipeline identities produce different group IDs'

    $releaseVariant = Copy-JsonObject $sameA.identity
    $releaseVariant.release.release_id = 'world-packages-v2'
    Assert-True ((Get-AshAtlasWorldGroupId (ConvertTo-AshAtlasWorldIdentity $releaseVariant)) -ne $sameA.group_id) 'grouping is not based only on pipeline SHA'
    Assert-True ($sameA.canonical_identity -match 'manifest_sha256' -and
        $sameA.canonical_identity -match 'artifact_count' -and
        $sameA.canonical_identity -match 'river_surface' -and
        $sameA.canonical_identity -match 'lake_surface' -and
        $sameA.canonical_identity -match 'ocean_coast_surface' -and
        $sameA.canonical_identity -match 'waterbody_identity_overlay' -and
        $sameA.canonical_identity -match 'water_name_index' -and
        $sameA.canonical_identity -match 'water_visual_tiles' -and
        $sameA.canonical_identity -notmatch '(?:river|lake|ocean_coast)_visual_tiles') 'canonical identity includes all immutable World and water release identities'

    $importFixture = Join-Path $tempRoot 'src-layout-fixture'
    $fixturePackage = Join-Path $importFixture 'src\map_world_pipeline'
    New-Item -ItemType Directory -Path $fixturePackage -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $fixturePackage '__init__.py') -Value "SOURCE_MARKER = 'immutable-src-layout'" -Encoding utf8
    Set-Content -LiteralPath (Join-Path $fixturePackage '__main__.py') -Value '' -Encoding utf8
    $moduleRoot = Get-AshAtlasWorldModuleRoot $importFixture
    Assert-Equal $moduleRoot ([IO.Path]::GetFullPath((Join-Path $importFixture 'src')).TrimEnd('\')) 'immutable module root resolves to the repository src directory'
    $importProbe = Invoke-AshAtlasNative (Get-Command python -ErrorAction Stop).Source @(
        '-c', 'import sys;sys.path.insert(0,sys.argv[1]);import map_world_pipeline;print(map_world_pipeline.SOURCE_MARKER);print(map_world_pipeline.__file__)',
        $moduleRoot
    )
    Assert-Equal $importProbe.ExitCode 0 'immutable src-layout package imports successfully'
    Assert-True ($importProbe.StdOut -match 'immutable-src-layout') 'immutable source wins over an installed or editable package'
    Assert-True ($importProbe.StdOut -match [regex]::Escape($fixturePackage)) 'import provenance points inside the materialized source root'
    Assert-Throws { Get-AshAtlasWorldModuleRoot (Join-Path $tempRoot 'missing-src-layout') | Out-Null } 'missing its src-layout entry point' 'missing immutable package entry point is refused'

    $activeWorldPorts = @((Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort))
    $samePort = Select-AshAtlasWorldGroupPort $config $sameA.group_id 0 @() $activeWorldPorts
    $samePortAgain = Select-AshAtlasWorldGroupPort $config $sameA.group_id $samePort @() $activeWorldPorts
    $differentPort = Select-AshAtlasWorldGroupPort $config $different.group_id 0 @() $activeWorldPorts @() @([pscustomobject]@{ group_id = $sameA.group_id; port = $samePort })
    Assert-Equal $samePortAgain $samePort 'a safe group port is stable between launches'
    Assert-True ($samePort -ne $differentPort) 'different groups cannot receive duplicate ports'
    Assert-True ($samePort -ge 41900 -and $samePort -le 42199 -and $samePort -ne 8765) 'feature World API port stays in its dedicated non-Main pool'
    Assert-Throws { Test-AshAtlasWorldGroupPortAvailable 8765 $sameA.group_id $config | Out-Null } 'never use protected Main port 8765' 'feature group refuses Main port'
    Assert-Throws { Test-AshAtlasWorldGroupPortAvailable 41925 $sameA.group_id $config @([pscustomobject]@{ start = 41920; end = 41930 }) | Out-Null } 'excluded TCP range' 'Windows excluded ranges are rejected'
    Assert-Throws { Test-AshAtlasWorldGroupPortAvailable 41926 $sameA.group_id $config @() @() @([pscustomobject]@{ port = 41926; container = 'foreign-container' }) | Out-Null } 'published by Docker' 'Docker-published World API ports are rejected'

    $occupied = 41900
    while (@(Get-NetTCPConnection -LocalPort $occupied -State Listen -ErrorAction SilentlyContinue).Count -gt 0) { $occupied++ }
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $occupied)
    $listener.Start()
    $replacement = Select-AshAtlasWorldGroupPort $config $sameA.group_id $occupied @() @($occupied)
    Assert-True ($replacement -ne $occupied) 'an occupied preferred port is skipped safely'
    Assert-True (@(Get-NetTCPConnection -LocalPort $occupied -State Listen -ErrorAction SilentlyContinue).Count -eq 1) 'port allocation does not kill an occupying process'
    $listener.Stop()
    $listener = $null

    $staleState = New-AshAtlasWorldGroupState $config $sameA $samePort
    $staleState.pid = $PID
    $staleState.process_start_time_utc = '2000-01-01T00:00:00.0000000Z'
    $staleState = Copy-JsonObject $staleState
    Assert-Throws { Get-AshAtlasWorldGroupProcessStatus $staleState | Out-Null } 'PID .* reused' 'stale group state refuses PID reuse'
    Assert-True ($null -ne (Get-Process -Id $PID -ErrorAction SilentlyContinue)) 'stale-state refusal never stops the unrelated process'

    $health = [pscustomobject][ordered]@{
        ok = $true
        runtime = [pscustomobject]@{ branch = $sameA.identity.pipeline.protected_branch; sha = $sameA.identity.pipeline.sha }
        release = [pscustomobject]@{
            release_id = $sameA.identity.release.release_id
            profile_set_fingerprint = $sameA.identity.release.profile_set_fingerprint
            build_contract_fingerprint = $sameA.identity.release.build_contract_fingerprint
            boundary_release_id = $sameA.identity.release.boundary_release_id
            package_count = $sameA.identity.release.package_count
        }
        release_verification = [pscustomobject]@{
            contract_version = 'world-release-manifest-admission-v1'
            verification_mode = 'manifest-only'
            package_artifacts_verified = $false
            release_root = [IO.Path]::GetFullPath((Join-Path $tempRoot 'locked-release'))
            release_manifest_sha256 = $sameA.identity.release.manifest_sha256
            package_count = $sameA.identity.release.package_count
            artifact_count = $sameA.identity.release.artifact_count
            verified_bytes = 0
        }
        river_surface = [pscustomobject]@{
            mode = $sameA.identity.river_surface.release_id
            cell_size_m = $sameA.identity.river_surface.cell_size_m
            identity = [pscustomobject]@{
                release_id = $sameA.identity.river_surface.release_id
                manifest_sha256 = $sameA.identity.river_surface.manifest_sha256
                policy = $sameA.identity.river_surface.policy
            }
            cache = [pscustomobject]@{ max_packages = 12 }
        }
        lake_surface = [pscustomobject]@{
            mode = $sameA.identity.lake_surface.release_id
            identity = [pscustomobject]@{
                release_id = $sameA.identity.lake_surface.release_id
                manifest_sha256 = $sameA.identity.lake_surface.manifest_sha256
                policy = $sameA.identity.lake_surface.policy
                cell_size_m = $sameA.identity.lake_surface.cell_size_m
            }
            cache = [pscustomobject]@{ max_packages = 12 }
        }
        ocean_coast_surface = [pscustomobject]@{
            mode = $sameA.identity.ocean_coast_surface.release_id
            identity = [pscustomobject]@{
                release_id = $sameA.identity.ocean_coast_surface.release_id
                manifest_sha256 = $sameA.identity.ocean_coast_surface.manifest_sha256
                policy = $sameA.identity.ocean_coast_surface.policy
                cell_size_m = $sameA.identity.ocean_coast_surface.cell_size_m
            }
            cache = [pscustomobject]@{ max_packages = 12 }
        }
        riverbank_lakeshore = [pscustomobject]@{
            mode = $sameA.identity.riverbank_lakeshore.release_id
            identity = [pscustomobject]@{
                release_id = $sameA.identity.riverbank_lakeshore.release_id
                manifest_sha256 = $sameA.identity.riverbank_lakeshore.manifest_sha256
                schema = $sameA.identity.riverbank_lakeshore.schema
                policy = $sameA.identity.riverbank_lakeshore.policy
                pipeline_sha = $sameA.identity.riverbank_lakeshore.pipeline_sha
                contract_fingerprint = $sameA.identity.riverbank_lakeshore.contract_fingerprint
                distance_m = $sameA.identity.riverbank_lakeshore.distance_m
                cell_size_m = $sameA.identity.riverbank_lakeshore.cell_size_m
                grid_fingerprint = $sameA.identity.riverbank_lakeshore.grid_fingerprint
                source = $sameA.identity.riverbank_lakeshore.source
            }
            cache = [pscustomobject]@{ max_packages = 12 }
        }
        waterbody_identity_overlay = [pscustomobject]@{
            release_id = $sameA.identity.waterbody_identity_overlay.release_id
            manifest_sha256 = $sameA.identity.waterbody_identity_overlay.manifest_sha256
            schema = $sameA.identity.waterbody_identity_overlay.schema
            schema_version = $sameA.identity.waterbody_identity_overlay.schema_version
            policy = $sameA.identity.waterbody_identity_overlay.policy
            policy_version = $sameA.identity.waterbody_identity_overlay.policy_version
        }
        water_name_index = [pscustomobject]@{
            release_id = $sameA.identity.water_name_index.release_id
            manifest_sha256 = $sameA.identity.water_name_index.manifest_sha256
            schema = $sameA.identity.water_name_index.schema
            policy = $sameA.identity.water_name_index.policy
            index_hash = $sameA.identity.water_name_index.index_hash
            entry_count = $sameA.identity.water_name_index.entry_count
            classes = [pscustomobject]@{
                river = $sameA.identity.water_name_index.classes.river
                lake = $sameA.identity.water_name_index.classes.lake
                ocean = $sameA.identity.water_name_index.classes.ocean
            }
        }
        capabilities = [pscustomobject]@{ flagPlacementWater = $true; waterNoBuildOverlay = $true; unionedWaterSurface = $true; riverWaterAuthorityV1 = $true; lakeWaterAuthorityV1 = $true; oceanCoastWaterAuthorityV1 = $true; riverbankLakeshoreV1 = $true; waterbodyIdentityV1 = $true; waterNameFallbackV1 = $true }
    }
    Assert-True (Assert-AshAtlasWorldHealthIdentity $health $sameA.identity 'manifest-only' $health.release_verification.release_root) 'complete compatible fast-admission health identity is accepted'
    foreach ($mutation in @(
        @{ path = 'branch'; apply = { param($x) $x.runtime.branch = 'wrong' }; pattern = 'branch differs' },
        @{ path = 'sha'; apply = { param($x) $x.runtime.sha = ('0' * 40) }; pattern = 'SHA differs' },
        @{ path = 'release'; apply = { param($x) $x.release.release_id = 'wrong' }; pattern = 'release ID differs' },
        @{ path = 'profile'; apply = { param($x) $x.release.profile_set_fingerprint = ('0' * 64) }; pattern = 'profile-set fingerprint differs' },
        @{ path = 'contract'; apply = { param($x) $x.release.build_contract_fingerprint = ('0' * 64) }; pattern = 'build-contract fingerprint differs' },
        @{ path = 'boundary'; apply = { param($x) $x.release.boundary_release_id = 'wrong' }; pattern = 'boundary release ID differs' },
        @{ path = 'manifest'; apply = { param($x) $x.release_verification.release_manifest_sha256 = ('0' * 64) }; pattern = 'manifest SHA-256 differs' },
        @{ path = 'packages'; apply = { param($x) $x.release.package_count = 1 }; pattern = 'package count differs' },
        @{ path = 'verified packages'; apply = { param($x) $x.release_verification.package_count = 1 }; pattern = 'verified package count differs' },
        @{ path = 'river mode'; apply = { param($x) $x.river_surface.mode = 'wide-v2' }; pattern = 'river surface mode differs' },
        @{ path = 'river manifest'; apply = { param($x) $x.river_surface.identity.manifest_sha256 = ('0' * 64) }; pattern = 'river surface manifest SHA-256 differs' },
        @{ path = 'river cache'; apply = { param($x) $x.river_surface.cache.max_packages = 13 }; pattern = 'river surface cache bound differs' },
        @{ path = 'lake mode'; apply = { param($x) $x.lake_surface.mode = 'legacy-polygon' }; pattern = 'lake surface mode differs' },
        @{ path = 'lake manifest'; apply = { param($x) $x.lake_surface.identity.manifest_sha256 = ('0' * 64) }; pattern = 'lake surface manifest SHA-256 differs' },
        @{ path = 'lake cache'; apply = { param($x) $x.lake_surface.cache.max_packages = 13 }; pattern = 'lake surface cache bound differs' },
        @{ path = 'ocean coast mode'; apply = { param($x) $x.ocean_coast_surface.mode = 'legacy-polygon' }; pattern = 'ocean coast surface mode differs' },
        @{ path = 'ocean coast manifest'; apply = { param($x) $x.ocean_coast_surface.identity.manifest_sha256 = ('0' * 64) }; pattern = 'ocean coast surface manifest SHA-256 differs' },
        @{ path = 'ocean coast cache'; apply = { param($x) $x.ocean_coast_surface.cache.max_packages = 13 }; pattern = 'ocean coast surface cache bound differs' },
        @{ path = 'waterbody overlay release'; apply = { param($x) $x.waterbody_identity_overlay.release_id = 'wrong' }; pattern = 'waterbody identity overlay release_id differs' },
        @{ path = 'waterbody overlay manifest'; apply = { param($x) $x.waterbody_identity_overlay.manifest_sha256 = ('0' * 64) }; pattern = 'waterbody identity overlay manifest_sha256 differs' },
        @{ path = 'waterbody overlay schema'; apply = { param($x) $x.waterbody_identity_overlay.schema = 'wrong' }; pattern = 'waterbody identity overlay schema differs' },
        @{ path = 'waterbody capability'; apply = { param($x) $x.capabilities.waterbodyIdentityV1 = $false }; pattern = 'missing capability waterbodyIdentityV1' },
        @{ path = 'water-name index manifest'; apply = { param($x) $x.water_name_index.manifest_sha256 = ('0' * 64) }; pattern = 'water-name index manifest_sha256 differs' },
        @{ path = 'water-name index capability'; apply = { param($x) $x.capabilities.waterNameFallbackV1 = $false }; pattern = 'missing capability waterNameFallbackV1' },
        @{ path = 'mode'; apply = { param($x) $x.release_verification.verification_mode = 'full' }; pattern = 'verification mode differs' },
        @{ path = 'artifact scan'; apply = { param($x) $x.release_verification.package_artifacts_verified = $true }; pattern = 'explicitly reported as unverified' },
        @{ path = 'release path'; apply = { param($x) $x.release_verification.release_root = (Join-Path $tempRoot 'wrong-release') }; pattern = 'release root differs' }
    )) {
        $wrong = Copy-JsonObject $health
        & $mutation.apply $wrong
        Assert-Throws { Assert-AshAtlasWorldHealthIdentity $wrong $sameA.identity 'manifest-only' $health.release_verification.release_root | Out-Null } $mutation.pattern "wrong $($mutation.path) health identity is rejected"
    }

    $legacyRuntime = New-AshAtlasFeatureIdentity $config 'C:\Users\dev\Documents\worktrees\group-test-alpha' 'fix/group-test-alpha'
    $legacyRuntime.ports = [pscustomobject][ordered]@{ frontend = 41010; backend = 41011; postgres = 41012; world_api = 8765 }
    Add-Member -InputObject $legacyRuntime -NotePropertyName world_runtime -NotePropertyValue (Copy-JsonObject $sameA)
    $legacyRuntime | Add-Member display_name 'Group Test Alpha'
    $legacyRuntime | Add-Member launcher_path (Join-Path $tempRoot 'Run Group Test Alpha.cmd')
    $store = [pscustomobject][ordered]@{ schema_version = 2; runtimes = @() }
    $resolved = Resolve-AshAtlasFeatureWorldRegistration $config $legacyRuntime $store -Persist -ExcludedRanges @() -ListeningPorts $activeWorldPorts -DockerMappings @()
    $firstResolvedPort = $resolved.ports.world_api
    $resolvedAgain = Resolve-AshAtlasFeatureWorldRegistration $config $resolved $store -Persist -PreviousWorldRuntime $resolved.world_runtime -ExcludedRanges @() -ListeningPorts $activeWorldPorts -DockerMappings @()
    $registeredState = Read-AshAtlasWorldGroupState $sameA.group_id
    Assert-Equal $resolvedAgain.ports.frontend 41010 'legacy migration preserves frontend port'
    Assert-Equal $resolvedAgain.ports.backend 41011 'legacy migration preserves backend port'
    Assert-Equal $resolvedAgain.ports.postgres 41012 'legacy migration preserves PostgreSQL port'
    Assert-Equal $resolvedAgain.database $legacyRuntime.database 'legacy migration preserves disposable database identity'
    Assert-Equal $resolvedAgain.compose_project $legacyRuntime.compose_project 'legacy migration preserves Compose identity'
    Assert-Equal $resolvedAgain.volume $legacyRuntime.volume 'legacy migration preserves disposable volume identity'
    Assert-Equal $resolvedAgain.ports.world_api $firstResolvedPort 'sync-style registration is idempotent'
    Assert-Equal @($registeredState.members_registered).Count 1 'idempotent registration records one member'

    Set-Content -LiteralPath $riverManifest -Value 'rebuilt release' -Encoding ascii
    $activeRiverState = Copy-JsonObject $registeredState
    $activeRiverState.members_live = @($resolved.runtime_id)
    Assert-Throws { Repair-AshAtlasInactiveWorldGroupRiverRoot $activeRiverState $sameA $config } 'group is live' 'a live group member blocks river path reconciliation'
    Assert-Equal $activeRiverState.river_surface_release_root $riverRoot 'live group refusal preserves the stored path'
    $activeRiverState.members_live = @()
    $activeRiverState.pid = $PID
    Assert-Throws { Repair-AshAtlasInactiveWorldGroupRiverRoot $activeRiverState $sameA $config } 'group is live' 'a live process blocks reconciliation even without recorded live members'
    $foreignRiverState = Copy-JsonObject $registeredState
    $foreignRiverState.river_surface_release_root = $outsideRoot
    Assert-Throws { Repair-AshAtlasInactiveWorldGroupRiverRoot $foreignRiverState $sameA $config } 'only the canonical' 'reconciliation cannot normalize a foreign recorded artifact path'
    $wrongIdentityState = Copy-JsonObject $registeredState
    $wrongIdentityState.canonical_identity = 'foreign identity'
    Assert-Throws { Repair-AshAtlasInactiveWorldGroupRiverRoot $wrongIdentityState $sameA $config } 'identity differs' 'reconciliation preserves complete group lock identity checks'
    $resolvedAgain = Resolve-AshAtlasFeatureWorldRegistration $config $resolved $store -Persist -PreviousWorldRuntime $resolved.world_runtime -ExcludedRanges @() -ListeningPorts $activeWorldPorts -DockerMappings @()
    $registeredState = Read-AshAtlasWorldGroupState $sameA.group_id
    Assert-Equal $registeredState.river_surface_release_root $preservedRiverRoot 'canonical registration persists the pinned sibling only for an inactive group'
    Assert-Equal $registeredState.group_id $sameA.group_id 'artifact path reconciliation preserves the complete pinned World group identity'
    Assert-Equal $resolvedAgain.ports.world_api $firstResolvedPort 'artifact path reconciliation preserves the registered World port'

    $repairFixture = Copy-JsonObject $registeredState
    $repairFixture.members_registered = @($resolved.runtime_id, 'stale-registered-runtime')
    $repairFixture.members_live = @($resolved.runtime_id, 'stale-live-runtime')
    Repair-AshAtlasWorldGroupMembership $repairFixture @($resolved.runtime_id) @($resolved.runtime_id) | Out-Null
    Assert-Equal @($repairFixture.members_registered).Count 1 'stale registered membership is removed only when absent from the lease store'
    Assert-Equal @($repairFixture.members_live).Count 1 'stale live membership is removed only when absent from active ownership records'

    $runtimeB = New-AshAtlasFeatureIdentity $config 'C:\Users\dev\Documents\worktrees\group-test-beta' 'fix/group-test-beta'
    $runtimeB.ports = [pscustomobject][ordered]@{ frontend = 41020; backend = 41021; postgres = 41022; world_api = 0 }
    Add-Member -InputObject $runtimeB -NotePropertyName world_runtime -NotePropertyValue (Copy-JsonObject $sameA)
    $runtimeB = Resolve-AshAtlasFeatureWorldRegistration $config $runtimeB $store -Persist -ExcludedRanges @() -ListeningPorts $activeWorldPorts -DockerMappings @()
    $registeredState = Read-AshAtlasWorldGroupState $sameA.group_id
    Assert-Equal $runtimeB.ports.world_api $resolved.ports.world_api 'matching features share one group port'
    Assert-Equal @($registeredState.members_registered).Count 2 'matching features share one registered group lease'

    $ownedPort = $firstResolvedPort
    $python = (Get-Command python -ErrorAction Stop).Source
    $code = 'import http.server,json,sys;p=int(sys.argv[1]);payload={"ok":True,"runtime":{"branch":sys.argv[5],"sha":sys.argv[6]},"release":{"release_id":sys.argv[10],"profile_set_fingerprint":sys.argv[8],"build_contract_fingerprint":sys.argv[9],"boundary_release_id":sys.argv[11],"package_count":int(sys.argv[12])},"release_verification":{"contract_version":"world-release-manifest-admission-v1","verification_mode":"manifest-only","package_artifacts_verified":False,"release_root":sys.argv[4],"release_manifest_sha256":sys.argv[7],"package_count":int(sys.argv[12]),"artifact_count":int(sys.argv[13]),"verified_bytes":0},"river_surface":{"mode":sys.argv[14],"cell_size_m":int(sys.argv[17]),"identity":{"release_id":sys.argv[14],"manifest_sha256":sys.argv[15],"policy":sys.argv[16]},"cache":{"max_packages":12}},"lake_surface":{"mode":sys.argv[20],"identity":{"release_id":sys.argv[20],"manifest_sha256":sys.argv[21],"policy":sys.argv[22],"cell_size_m":int(sys.argv[23])},"cache":{"max_packages":12}},"ocean_coast_surface":{"mode":sys.argv[25],"identity":{"release_id":sys.argv[25],"manifest_sha256":sys.argv[26],"policy":sys.argv[27],"cell_size_m":int(sys.argv[28])},"cache":{"max_packages":12}},"waterbody_identity_overlay":{"release_id":sys.argv[30],"manifest_sha256":sys.argv[31],"schema":sys.argv[32],"schema_version":sys.argv[33],"policy":sys.argv[34],"policy_version":sys.argv[35]},"water_name_index":{"release_id":sys.argv[36],"manifest_sha256":sys.argv[37],"schema":sys.argv[38],"policy":sys.argv[39],"index_hash":sys.argv[40],"entry_count":int(sys.argv[41]),"classes":{"river":int(sys.argv[42]),"lake":int(sys.argv[43]),"ocean":int(sys.argv[44])}},"capabilities":{"flagPlacementWater":True,"waterNoBuildOverlay":True,"unionedWaterSurface":True,"riverWaterAuthorityV1":True,"lakeWaterAuthorityV1":True,"oceanCoastWaterAuthorityV1":True,"waterbodyIdentityV1":True,"waterNameFallbackV1":True}};H=type("H",(http.server.BaseHTTPRequestHandler,),{"do_GET":lambda s:(s.send_response(200),s.send_header("Content-Type","application/json"),s.end_headers(),s.wfile.write(json.dumps(payload).encode())),"log_message":lambda *a:None});http.server.HTTPServer(("127.0.0.1",p),H).serve_forever()'
    $code = 'import http.server,json,sys;p=int(sys.argv[1]);payload={"ok":True,"runtime":{"branch":sys.argv[5],"sha":sys.argv[6]},"release":{"release_id":sys.argv[10],"profile_set_fingerprint":sys.argv[8],"build_contract_fingerprint":sys.argv[9],"boundary_release_id":sys.argv[11],"package_count":int(sys.argv[12])},"release_verification":{"contract_version":"world-release-manifest-admission-v1","verification_mode":"manifest-only","package_artifacts_verified":False,"release_root":sys.argv[4],"release_manifest_sha256":sys.argv[7],"package_count":int(sys.argv[12]),"artifact_count":int(sys.argv[13]),"verified_bytes":0},"river_surface":{"mode":sys.argv[14],"cell_size_m":int(sys.argv[17]),"identity":{"release_id":sys.argv[14],"manifest_sha256":sys.argv[15],"policy":sys.argv[16]},"cache":{"max_packages":12}},"lake_surface":{"mode":sys.argv[20],"identity":{"release_id":sys.argv[20],"manifest_sha256":sys.argv[21],"policy":sys.argv[22],"cell_size_m":int(sys.argv[23])},"cache":{"max_packages":12}},"ocean_coast_surface":{"mode":sys.argv[25],"identity":{"release_id":sys.argv[25],"manifest_sha256":sys.argv[26],"policy":sys.argv[27],"cell_size_m":int(sys.argv[28])},"cache":{"max_packages":12}},"riverbank_lakeshore":{"mode":sys.argv[30],"identity":{"release_id":sys.argv[30],"manifest_sha256":sys.argv[31],"schema":"riverbank-lakeshore-row-spans-v1","policy":sys.argv[32],"pipeline_sha":"4d3448ae3f719e678d864e04679008294f72df8c","contract_fingerprint":"32572021050b078ba856469a705631902e8036c8bf4512334d056732b35000ce","distance_m":500.0,"cell_size_m":125.0,"grid_fingerprint":"44e1b2d53f5b3d38b6f5370d30c94403d6d4f90a6207f12ccdee799713a6229b","source":{"river":{"release_id":"river-surface-v1","manifest_sha256":"c605631193ff786e33182fb8b6d7cfa3ab868b35d0a47fec5e1aa717ace447d5","policy":"osm-medium-plus-v1"},"lake":{"release_id":"lake-surface-v1","manifest_sha256":"d0c25c2b6a4e9349091a5f483a294fac7988cd098a1f77e354343cb2f27f42b9","policy":"hydrolakes-center-membership-v1"},"world":{"release_id":"world-packages-v1","manifest_sha256":"80bfe7152f2b4f16cc182cc38a86a72950634d5799fbb31b6bad4ef686bb5578"}}},"cache":{"max_packages":12}},"waterbody_identity_overlay":{"release_id":sys.argv[35],"manifest_sha256":sys.argv[36],"schema":sys.argv[37],"schema_version":sys.argv[38],"policy":sys.argv[39],"policy_version":sys.argv[40]},"water_name_index":{"release_id":sys.argv[41],"manifest_sha256":sys.argv[42],"schema":sys.argv[43],"policy":sys.argv[44],"index_hash":sys.argv[45],"entry_count":int(sys.argv[46]),"classes":{"river":int(sys.argv[47]),"lake":int(sys.argv[48]),"ocean":int(sys.argv[49])}},"capabilities":{"flagPlacementWater":True,"waterNoBuildOverlay":True,"unionedWaterSurface":True,"riverWaterAuthorityV1":True,"lakeWaterAuthorityV1":True,"oceanCoastWaterAuthorityV1":True,"riverbankLakeshoreV1":True,"waterbodyIdentityV1":True,"waterNameFallbackV1":True}};H=type("H",(http.server.BaseHTTPRequestHandler,),{"do_GET":lambda s:(s.send_response(200),s.send_header("Content-Type","application/json"),s.end_headers(),s.wfile.write(json.dumps(payload).encode())),"log_message":lambda *a:None});http.server.HTTPServer(("127.0.0.1",p),H).serve_forever()'
    $code = 'import http.server,json,sys;p=int(sys.argv[1]);payload={"ok":True,"runtime":{"branch":sys.argv[5],"sha":sys.argv[6]},"release":{"release_id":sys.argv[10],"profile_set_fingerprint":sys.argv[8],"build_contract_fingerprint":sys.argv[9],"boundary_release_id":sys.argv[11],"package_count":int(sys.argv[12])},"release_verification":{"contract_version":"world-release-manifest-admission-v1","verification_mode":"manifest-only","package_artifacts_verified":False,"release_root":sys.argv[4],"release_manifest_sha256":sys.argv[7],"package_count":int(sys.argv[12]),"artifact_count":int(sys.argv[13]),"verified_bytes":0},"river_surface":{"mode":sys.argv[14],"cell_size_m":int(sys.argv[17]),"identity":{"release_id":sys.argv[14],"manifest_sha256":sys.argv[15],"policy":sys.argv[16]},"cache":{"max_packages":12}},"lake_surface":{"mode":sys.argv[20],"identity":{"release_id":sys.argv[20],"manifest_sha256":sys.argv[21],"policy":sys.argv[22],"cell_size_m":int(sys.argv[23])},"cache":{"max_packages":12}},"ocean_coast_surface":{"mode":sys.argv[25],"identity":{"release_id":sys.argv[25],"manifest_sha256":sys.argv[26],"policy":sys.argv[27],"cell_size_m":int(sys.argv[28])},"cache":{"max_packages":12}},"riverbank_lakeshore":{"mode":sys.argv[30],"identity":{"release_id":sys.argv[30],"manifest_sha256":sys.argv[31],"schema":"riverbank-lakeshore-row-spans-v1","policy":sys.argv[32],"pipeline_sha":"4d3448ae3f719e678d864e04679008294f72df8c","contract_fingerprint":"32572021050b078ba856469a705631902e8036c8bf4512334d056732b35000ce","distance_m":500.0,"cell_size_m":125.0,"grid_fingerprint":"44e1b2d53f5b3d38b6f5370d30c94403d6d4f90a6207f12ccdee799713a6229b","source":{"river":{"release_id":"river-surface-v1","manifest_sha256":"c605631193ff786e33182fb8b6d7cfa3ab868b35d0a47fec5e1aa717ace447d5","policy":"osm-medium-plus-v1"},"lake":{"release_id":"lake-surface-v1","manifest_sha256":"d0c25c2b6a4e9349091a5f483a294fac7988cd098a1f77e354343cb2f27f42b9","policy":"hydrolakes-center-membership-v1"},"world":{"release_id":"world-packages-v1","manifest_sha256":"80bfe7152f2b4f16cc182cc38a86a72950634d5799fbb31b6bad4ef686bb5578"}}},"cache":{"max_packages":12}},"waterbody_identity_overlay":{"release_id":"waterbody-identity-overlay-v4","manifest_sha256":"f81deb9fb441ec5644095b1d4ea8f430c652948f5e7a64e9beac5a6ea005020c","schema":"waterbody-identity-overlay-v1","schema_version":"waterbody-identity-overlay-v1","policy":"existing-cell-candidate-precedence-v1","policy_version":"existing-cell-candidate-precedence-v1"},"water_name_index":{"release_id":"water-names-v1","manifest_sha256":"bb73ebeac7c48d4adcedf9dd10e9a0a6cf591bd8ef7dfe01dca2a141a9e6317b","schema":"water-names-v1","policy":"same-class-nearest-authoritative-name-v1","index_hash":"90482d2633df3cc869e1c1162aa7b1da0503f051740122eeeb65612cd33c3bd2","entry_count":526218,"classes":{"river":523086,"lake":3021,"ocean":111}},"capabilities":{"flagPlacementWater":True,"waterNoBuildOverlay":True,"unionedWaterSurface":True,"riverWaterAuthorityV1":True,"lakeWaterAuthorityV1":True,"oceanCoastWaterAuthorityV1":True,"riverbankLakeshoreV1":True,"waterbodyIdentityV1":True,"waterNameFallbackV1":True}};H=type("H",(http.server.BaseHTTPRequestHandler,),{"do_GET":lambda s:(s.send_response(200),s.send_header("Content-Type","application/json"),s.end_headers(),s.wfile.write(json.dumps(payload).encode())),"log_message":lambda *a:None});http.server.HTTPServer(("127.0.0.1",p),H).serve_forever()'
    $sourceToken = [IO.Path]::GetFullPath((Join-Path $tempRoot 'owned-source'))
    $releaseToken = [IO.Path]::GetFullPath((Join-Path $tempRoot 'owned-release'))
    $riverToken = [IO.Path]::GetFullPath((Join-Path $tempRoot 'owned-river-release'))
    $lakeToken = [IO.Path]::GetFullPath((Join-Path $tempRoot 'owned-lake-release'))
    $oceanCoastToken = [IO.Path]::GetFullPath((Join-Path $tempRoot 'owned-ocean-coast-release'))
    $riverbankLakeshoreToken = [IO.Path]::GetFullPath((Join-Path $tempRoot 'owned-riverbank-lakeshore-release'))
    $overlayToken = [IO.Path]::GetFullPath((Join-Path $tempRoot 'owned-waterbody-identity-overlay-release'))
    $waterNameIndexToken = [IO.Path]::GetFullPath((Join-Path $tempRoot 'owned-water-names-v1'))
    $mapToken = [IO.Path]::GetFullPath((Join-Path $tempRoot 'owned-map-repository'))
    $arguments = @(
        '-c', $code, [string]$ownedPort, $mapToken, $sourceToken, $releaseToken,
        $sameA.identity.pipeline.protected_branch, $sameA.identity.pipeline.sha,
        $sameA.identity.release.manifest_sha256, $sameA.identity.release.profile_set_fingerprint,
        $sameA.identity.release.build_contract_fingerprint, $sameA.identity.release.release_id,
        $sameA.identity.release.boundary_release_id, [string]$sameA.identity.release.package_count,
        [string]$sameA.identity.release.artifact_count,
        $sameA.identity.river_surface.release_id, $sameA.identity.river_surface.manifest_sha256,
        $sameA.identity.river_surface.policy, [string]$sameA.identity.river_surface.cell_size_m,
        $riverToken, $lakeToken,
        $sameA.identity.lake_surface.release_id, $sameA.identity.lake_surface.manifest_sha256,
        $sameA.identity.lake_surface.policy, [string]$sameA.identity.lake_surface.cell_size_m,
        $oceanCoastToken, $sameA.identity.ocean_coast_surface.release_id,
        $sameA.identity.ocean_coast_surface.manifest_sha256, $sameA.identity.ocean_coast_surface.policy,
        [string]$sameA.identity.ocean_coast_surface.cell_size_m,
        $riverbankLakeshoreToken, $sameA.identity.riverbank_lakeshore.release_id,
        $sameA.identity.riverbank_lakeshore.manifest_sha256, $sameA.identity.riverbank_lakeshore.policy,
        $overlayToken, $sameA.identity.waterbody_identity_overlay.release_id,
        $sameA.identity.waterbody_identity_overlay.manifest_sha256,
        $sameA.identity.waterbody_identity_overlay.schema,
        $sameA.identity.waterbody_identity_overlay.schema_version,
        $sameA.identity.waterbody_identity_overlay.policy,
        $sameA.identity.waterbody_identity_overlay.policy_version,
        $sameA.identity.water_name_index.release_id,
        $sameA.identity.water_name_index.manifest_sha256,
        $sameA.identity.water_name_index.schema,
        $sameA.identity.water_name_index.policy,
        $sameA.identity.water_name_index.index_hash,
        [string]$sameA.identity.water_name_index.entry_count,
        [string]$sameA.identity.water_name_index.classes.river,
        [string]$sameA.identity.water_name_index.classes.lake,
        [string]$sameA.identity.water_name_index.classes.ocean,
        $waterNameIndexToken
    )
    $ownedProcess = Start-Process -FilePath $python -ArgumentList (@($arguments | ForEach-Object { ConvertTo-AshAtlasNativeArgument ([string]$_) }) -join ' ') -WindowStyle Hidden -PassThru
    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline -and @(Get-NetTCPConnection -LocalPort $ownedPort -State Listen -ErrorAction SilentlyContinue).Count -eq 0) { Start-Sleep -Milliseconds 50 }
    Assert-True (@(Get-NetTCPConnection -LocalPort $ownedPort -State Listen -ErrorAction SilentlyContinue).Count -eq 1) 'owned-process fixture listens on the group port'
    $native = Get-CimInstance Win32_Process -Filter "ProcessId = $($ownedProcess.Id)"
    $registeredState.pid = $ownedProcess.Id
    $registeredState.process_start_time_utc = $ownedProcess.StartTime.ToUniversalTime().ToString('o')
    $registeredState.python_executable = [string]$native.ExecutablePath
    $registeredState.command_line = [string]$native.CommandLine
    $registeredState.source_root = $sourceToken
    $registeredState.release_root = $releaseToken
    $registeredState.river_surface_release_root = $riverToken
    $registeredState.lake_surface_release_root = $lakeToken
    $registeredState.ocean_coast_surface_release_root = $oceanCoastToken
    $registeredState.riverbank_lakeshore_release_root = $riverbankLakeshoreToken
    $registeredState.waterbody_identity_overlay_release_root = $overlayToken
    $registeredState.water_name_index_release_root = $waterNameIndexToken
    $registeredState.map_repository = $mapToken
    $registeredState.members_live = @($resolved.runtime_id, $runtimeB.runtime_id)
    Write-AshAtlasWorldGroupState $registeredState
    $persistedRegisteredState = Read-AshAtlasWorldGroupState $sameA.group_id
    Assert-Equal (Get-AshAtlasWorldGroupProcessStatus $persistedRegisteredState).status 'match' 'persisted shared World process timestamps preserve exact live-process reuse identity'

    $mutex = Enter-AshAtlasWorldRuntimeMutex
    try { Remove-AshAtlasWorldGroupMember $sameA.group_id $resolved.runtime_id -Live }
    finally { Exit-AshAtlasWorldRuntimeMutex $mutex }
    Assert-True ($null -ne (Get-Process -Id $ownedProcess.Id -ErrorAction SilentlyContinue)) 'stopping one shared member leaves the exact World API running'
    Assert-Equal @((Read-AshAtlasWorldGroupState $sameA.group_id).members_live).Count 1 'one live member remains after first stop'

    $mutex = Enter-AshAtlasWorldRuntimeMutex
    try { Remove-AshAtlasWorldGroupMember $sameA.group_id $runtimeB.runtime_id -Live }
    finally { Exit-AshAtlasWorldRuntimeMutex $mutex }
    $ownedProcess.WaitForExit(10000) | Out-Null
    Assert-True ($null -eq (Get-Process -Id $ownedProcess.Id -ErrorAction SilentlyContinue)) 'stopping the final member stops only the exact group-owned process'
    Assert-Equal (Read-AshAtlasWorldGroupState $sameA.group_id).pid 0 'final stop clears the owned PID while retaining the stable group lease'
    $ownedProcess = $null

    $mutex = Enter-AshAtlasWorldRuntimeMutex
    try { Remove-AshAtlasWorldGroupMember $sameA.group_id $resolved.runtime_id -Registered }
    finally { Exit-AshAtlasWorldRuntimeMutex $mutex }
    Assert-True ($null -ne (Read-AshAtlasWorldGroupState $sameA.group_id)) 'removing one registration cannot delete a group used by another feature'
    $mutex = Enter-AshAtlasWorldRuntimeMutex
    try { Remove-AshAtlasWorldGroupMember $sameA.group_id $runtimeB.runtime_id -Registered }
    finally { Exit-AshAtlasWorldRuntimeMutex $mutex }
    Assert-True ($null -eq (Read-AshAtlasWorldGroupState $sameA.group_id)) 'unused group lease is removed only after its final registration'

    $changedRuntime = Copy-JsonObject $resolved
    $changedRuntime.world_runtime = $different
    $changedRuntime.ports.world_api = $differentPort
    Assert-Equal $changedRuntime.ports.frontend $resolved.ports.frontend 'lock change preserves frontend identity'
    Assert-Equal $changedRuntime.ports.backend $resolved.ports.backend 'lock change preserves backend identity'
    Assert-Equal $changedRuntime.ports.postgres $resolved.ports.postgres 'lock change preserves PostgreSQL identity'
    Assert-True ($changedRuntime.world_runtime.group_id -ne $resolved.world_runtime.group_id) 'lock change moves the feature to a different group'

    $launcher = New-AshAtlasFeatureLauncherContent $config $resolved 'World Group Fixture'
    Assert-True ($launcher -notmatch 'DATABASE_URL|PASSWORD|ash_atlas_game|ash_atlas_stability') 'generated launchers contain no secrets or database identities'
    $runScript = Get-Content -Raw -LiteralPath (Join-Path $root 'tools\dev\run-main.ps1')
    Assert-True ($config.main.ports.world_api -eq 8765 -and $runScript -match 'Ensure-MainWorldRuntime') 'Main startup remains protected on 8765'
    Assert-True ($runScript -match 'Remove-CurrentRuntimeSupervisorState' -and $runScript -match 'ready_signal' -and $runScript -match 'Stop-RecordedProcesses') 'failed startup removes false ready state and owned feature processes'
} finally {
    if ($null -ne $listener) { $listener.Stop() }
    if ($null -ne $ownedProcess) { Stop-Process -Id $ownedProcess.Id -Force -ErrorAction SilentlyContinue }
    $env:ASH_ATLAS_WORLD_RUNTIME_ROOT = $oldWorldRoot
    $env:ASH_ATLAS_DEV_RUNTIME_LEASE_PATH = $oldLeasePath
    $env:ASH_ATLAS_RUNTIME_TEST_MODE = $oldTestMode
    if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}

Write-Host "world-runtime-groups.tests.ps1: $script:Passed assertions passed." -ForegroundColor Green
