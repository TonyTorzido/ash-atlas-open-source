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

$ports = [pscustomobject]@{ frontend = 41000; backend = 41001; postgres = 41002; world_api = 41900 }
Assert-Throws { Assert-AshAtlasPortSetAvailable $ports @([pscustomobject]@{ start = 41000; end = 41050 }) } 'excluded' 'excluded-port rejection'
Assert-Throws { Assert-AshAtlasPortSetAvailable $ports @() @(41001) } 'listener' 'occupied-port rejection'
Assert-Throws {
    Assert-AshAtlasPortSetAvailable $ports @() @() @([pscustomobject]@{ port = 41002; container = 'foreign-db'; runtime_id = 'foreign' })
} 'published by Docker' 'Docker-published-port rejection'

$identityA = New-AshAtlasFeatureIdentity $config 'C:\Users\dev\Documents\worktrees\alpha-feature' 'feature/alpha-feature'
$identityB = New-AshAtlasFeatureIdentity $config 'C:\Users\dev\Documents\worktrees\beta-feature' 'feature/beta-feature'
Assert-True ($identityA.runtime_id -ne $identityB.runtime_id) 'runtime IDs must be unique'
Assert-True ($identityA.compose_project -ne $identityB.compose_project) 'Compose projects must be unique'
Assert-True ($identityA.postgres_container -ne $identityB.postgres_container) 'containers must be unique'
Assert-True ($identityA.network -ne $identityB.network) 'networks must be unique'
Assert-True ($identityA.volume -ne $identityB.volume) 'volumes must be unique'
Assert-True ($identityA.database.StartsWith('ash_atlas_stability')) 'feature database prefix'
Assert-True (Test-AshAtlasSafeFeatureRuntime $config $identityA) 'safe feature identity accepted'
$generationSha = 'a' * 40
$generatedIdentity = New-AshAtlasFeatureIdentity $config `
    'C:\Users\dev\Documents\worktrees\wolf-behavior__t004' `
    'feature/wolf-behavior--from-t004' $generationSha
Assert-True ($generatedIdentity.runtime_id -match '^wolf-behavior-t004-') 'runtime identity includes feature slug and generation'
Assert-True ($generatedIdentity.database -match 'wolf_behavior_t004') 'database identity includes feature slug and generation'
Assert-Equal $generatedIdentity.base_test_generation 't004' 'runtime stores exact readable base generation'
Assert-Equal $generatedIdentity.base_test_sha $generationSha 'runtime stores exact immutable base SHA'
$fourDigitIdentity = New-AshAtlasFeatureIdentity $config `
    'C:\Users\dev\Documents\worktrees\wolf-variant__t1000' `
    'feature/wolf-variant--from-t1000' $generationSha
Assert-True ($fourDigitIdentity.runtime_id -match '^wolf-variant-t1000-') 'runtime identity accepts four-digit generations'
Assert-Equal $fourDigitIdentity.base_test_generation 't1000' 'runtime stores the first four-digit generation'
Assert-Throws {
    New-AshAtlasFeatureIdentity $config `
        'C:\Users\dev\Documents\worktrees\wolf-behavior__t004' `
        'feature/wolf-behavior--from-t003' $generationSha | Out-Null
} 'do not match' 'mismatched branch and worktree generations are refused'
$identityA.ports = [pscustomobject]@{ frontend = 41000; backend = 41001; postgres = 41002; world_api = 41900 }
Add-Member -InputObject $identityA -NotePropertyName world_runtime -NotePropertyValue ([pscustomobject]@{ group_id = 'world-0123456789abcdef'; port = 41900 })
$launcherName = ConvertTo-AshAtlasLauncherFileName 'Kingdom Update 1.0'
$launcherContent = New-AshAtlasFeatureLauncherContent $config $identityA 'Kingdom Update 1.0'
$branchLauncherContent = New-AshAtlasFeatureLauncherContent $config $identityA 'Kingdom Update 1.0' $root
Assert-Equal $launcherName 'Run Kingdom Update 1.0.cmd' 'display name becomes expected clickable filename'
Assert-Equal (ConvertTo-AshAtlasLauncherFileName 'Wolf Behavior' 't004') 'Run Wolf Behavior [t004].cmd' 'generation launcher filename is visible'
Assert-Equal (ConvertTo-AshAtlasLauncherFileName 'Wolf Variant' 't1000') 'Run Wolf Variant [t1000].cmd' 'four-digit generation launcher filename is visible'
Assert-Equal (ConvertTo-AshAtlasLauncherFileName 'Kingdom & Update') 'Run Kingdom Update.cmd' 'command metacharacters are removed from display names'
Assert-Equal (Get-AshAtlasFeatureLauncherPath 'C:\Launchers' 'Wolf Behavior' 't004') 'C:\Launchers\Active\Run Wolf Behavior [t004].cmd' 'generation launcher is created under Active'
Assert-Equal (Get-AshAtlasFeatureLauncherPath 'C:\Launchers' 'Legacy Feature' '') 'C:\Launchers\Run Legacy Feature.cmd' 'legacy launcher remains at its existing root'
Assert-Equal (Get-AshAtlasMergedLauncherPath 'C:\Launchers' 'Wolf Behavior' 't004' 't005') 'C:\Launchers\Merged\[MERGED] Wolf Behavior [t004 to t005].cmd' 'merged receipt path shows both generations'
Assert-True ($launcherContent.Contains('C:\Users\dev\Documents\worktrees\alpha-feature')) 'launcher targets exact worktree'
Assert-True ($launcherContent.Contains('C:\Users\dev\Documents\game\tools\dev\run-main.ps1')) 'launcher targets permanent supervisor'
Assert-True ($launcherContent.Contains('Frontend port is assigned when this launcher starts. Preferred port: 41000.')) 'launcher explains session-time frontend assignment'
Assert-True ($launcherContent.Contains('World API: http://127.0.0.1:41900')) 'launcher displays assigned feature World API URL'
Assert-True ($launcherContent.Contains('%LOCALAPPDATA%\AshAtlas\runtimes\')) 'launcher displays its diagnostic log directory'
Assert-True ($launcherContent.Contains('-RuntimeMode Feature')) 'launcher explicitly selects Feature mode'
Assert-True ($launcherContent -notmatch 'ash_atlas_game|ash_atlas_stability|DATABASE_URL|PASSWORD') 'launcher contains no database identity or secret'
Assert-True ($launcherContent -match 'if not "%ASH_ATLAS_EXIT%"=="0"[\s\S]*pause') 'feature launcher pauses only after failure'
Assert-True ($branchLauncherContent.Contains((Join-Path $root 'tools\dev\run-main.ps1'))) 'pre-merge launcher can use the task supervisor'
$generatedIdentity.ports = [pscustomobject]@{ frontend = 41003; backend = 41004; postgres = 41005; world_api = 41900 }
$generatedLauncher = New-AshAtlasFeatureLauncherContent $config $generatedIdentity 'Wolf Behavior'
Assert-True ($generatedLauncher.Contains('Base test generation: t004') -and $generatedLauncher.Contains("Base integration SHA: $generationSha")) 'generated launcher records exact base identity'
$identityA.database = 'ash_atlas_game'
Assert-True (-not (Test-AshAtlasSafeFeatureRuntime $config $identityA)) 'feature ash_atlas_game refused'
$identityA = New-AshAtlasFeatureIdentity $config 'C:\Users\dev\Documents\worktrees\alpha-feature' 'feature/alpha-feature'
$identityA.postgres_container = [string]$config.main.postgres_container
Assert-True (-not (Test-AshAtlasSafeFeatureRuntime $config $identityA)) 'feature Main PostgreSQL container refused'
$identityA = New-AshAtlasFeatureIdentity $config 'C:\Users\dev\Documents\worktrees\alpha-feature' 'feature/alpha-feature'
$identityA.volume = [string]$config.main.database.volume
Assert-True (-not (Test-AshAtlasSafeFeatureRuntime $config $identityA)) 'feature retained Main PostgreSQL volume refused'
$identityA = New-AshAtlasFeatureIdentity $config 'C:\Users\dev\Documents\worktrees\alpha-feature' 'feature/alpha-feature'
$identityA.compose_project = [string]$config.main.compose_project
Assert-True (-not (Test-AshAtlasSafeFeatureRuntime $config $identityA)) 'feature Main Compose project refused'
$identityA = New-AshAtlasFeatureIdentity $config 'C:\Users\dev\Documents\worktrees\alpha-feature' 'feature/alpha-feature'
$originalDatabaseUrl = [Environment]::GetEnvironmentVariable('DATABASE_URL')
try {
    $env:DATABASE_URL = 'postgres://ash_atlas:secret@127.0.0.1:35432/ash_atlas_game'
    Clear-AshAtlasInheritedFeatureDatabaseEnvironment $identityA
    Assert-True ($null -eq [Environment]::GetEnvironmentVariable('DATABASE_URL')) 'Feature clears inherited Main DATABASE_URL'
} finally {
    if ($null -eq $originalDatabaseUrl) { Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue }
    else { $env:DATABASE_URL = $originalDatabaseUrl }
}

$assigned = Select-AshAtlasFeaturePorts $config $identityA.runtime_id
$reused = Select-AshAtlasFeaturePorts $config $identityA.runtime_id @() @() @() @() $assigned
Assert-Equal $reused.frontend $assigned.frontend 'deterministic reusable frontend assignment'
Assert-Equal $reused.backend $assigned.backend 'deterministic reusable backend assignment'
Assert-Equal $reused.postgres $assigned.postgres 'deterministic reusable database assignment'
Assert-True ($assigned.frontend -ge 41000 -and $assigned.postgres -le 41899) 'assignment stays in bounded pool'
Assert-True ($assigned.postgres -lt 49152) 'assignment stays below dynamic range'

$duplicateLease = [pscustomobject]@{ runtime_id = 'other-runtime'; ports = $assigned }
Assert-Throws {
    Assert-AshAtlasPortSetAvailable $assigned @() @() @() @($duplicateLease) $identityA.runtime_id
} 'another Ash Atlas runtime lease' 'duplicate port lease prevention'

$leases = @(
    [pscustomobject]@{ runtime_id = 'missing'; worktree = 'C:\missing-worktree' },
    [pscustomobject]@{ runtime_id = 'active-missing'; worktree = 'C:\also-missing' },
    [pscustomobject]@{ runtime_id = 'existing'; worktree = 'C:\existing-worktree' }
)
$stale = @(Get-AshAtlasStaleLeases $leases @('C:\existing-worktree') @('active-missing'))
Assert-Equal $stale.Count 1 'only inactive missing worktree lease is stale'
$store = [pscustomobject]@{ schema_version = 1; runtimes = $leases }
Remove-AshAtlasStaleLeasesFromStore $store $stale | Out-Null
Assert-Equal $store.runtimes.Count 2 'stale lease cleanup removes only stale entry'
Assert-True (@($store.runtimes.runtime_id) -contains 'active-missing') 'cleanup preserves active resource lease'
$leaseStore = [pscustomobject]@{ schema_version = 2; runtimes = @() }
Set-AshAtlasLease $leaseStore $generatedIdentity | Out-Null
Assert-Equal $leaseStore.runtimes[0].base_test_generation 't004' 'lease persists base generation'
Assert-Equal $leaseStore.runtimes[0].base_test_sha $generationSha 'lease persists exact base SHA'
$mergedAt = '2026-07-18T01:02:03.0000000Z'
Add-Member -InputObject $generatedIdentity -NotePropertyName integration_status -NotePropertyValue 'merged_to_test'
Add-Member -InputObject $generatedIdentity -NotePropertyName merged_test_generation -NotePropertyValue 't005'
Add-Member -InputObject $generatedIdentity -NotePropertyName merged_test_sha -NotePropertyValue ('b' * 40)
Add-Member -InputObject $generatedIdentity -NotePropertyName merged_at_utc -NotePropertyValue $mergedAt
Add-Member -InputObject $generatedIdentity -NotePropertyName merged_launcher_path -NotePropertyValue 'C:\Launchers\Merged\[MERGED] Wolf Behavior [t004 to t005].cmd'
$mergedLeaseStore = [pscustomobject]@{ schema_version = 2; runtimes = @() }
Set-AshAtlasLease $mergedLeaseStore $generatedIdentity | Out-Null
Assert-Equal $mergedLeaseStore.runtimes[0].integration_status 'merged_to_test' 'lease persists merged Integration Test status'
Assert-Equal $mergedLeaseStore.runtimes[0].merged_test_generation 't005' 'lease persists accepted merged generation'
Assert-Equal $mergedLeaseStore.runtimes[0].merged_test_sha ('b' * 40) 'lease persists exact resulting Integration Test SHA'
Assert-Equal $mergedLeaseStore.runtimes[0].merged_at_utc $mergedAt 'lease persists merged UTC timestamp'
$legacyLeaseStore = [pscustomobject]@{ schema_version = 2; runtimes = @() }
Set-AshAtlasLease $legacyLeaseStore $identityB | Out-Null
Assert-True ($null -eq $legacyLeaseStore.runtimes[0].PSObject.Properties['base_test_generation']) 'legacy runtime lease remains valid without generation fields'
Assert-True ($null -eq $legacyLeaseStore.runtimes[0].PSObject.Properties['integration_status']) 'legacy runtime lease remains valid without merged fields'

$compose = Get-Content -Raw -LiteralPath (Join-Path $root 'docker-compose.yml')
$launcher = Get-Content -Raw -LiteralPath (Join-Path $root 'tools\dev\run-main.ps1')
$wrapper = Get-Content -Raw -LiteralPath (Join-Path $root 'Run Ash Atlas.cmd')
$docs = Get-Content -Raw -LiteralPath (Join-Path $root 'docs/history/DEV_WORKTREES.md')
$envExample = Get-Content -Raw -LiteralPath (Join-Path $root '.env.example')
$featureRuntime = Get-Content -Raw -LiteralPath (Join-Path $root 'tools\dev\feature-runtime.ps1')
$worldGroups = Get-Content -Raw -LiteralPath (Join-Path $root 'tools\dev\world-runtime-groups.ps1')
Assert-True ($config.main.database.retained -eq $true) 'Main database is marked retained'
Assert-True ($compose -match 'postgres_data:\s*\r?\n\s+name:.*\r?\n\s+external: true') 'retained-capable Compose volume is external'
Assert-True ($launcher -notmatch 'compose\s+down\s+-v') 'supervisor has no destructive volume command'
Assert-True ($wrapper -match 'if not "%ASH_ATLAS_EXIT%"=="0"[\s\S]*pause') 'root launcher pauses only in failure branch'
Assert-True ($wrapper -match 'run-main\.ps1" %\*') 'root launcher passes all arguments'
Assert-True ($docs -match '127\.0\.0\.1:35432') 'documentation matches Main PostgreSQL port'
Assert-True ($envExample -match '127\.0\.0\.1:35432/ash_atlas_game') '.env example matches Main PostgreSQL port'
Assert-True ($compose -match 'ASH_ATLAS_POSTGRES_PORT') 'Compose receives PostgreSQL port from supervisor'
Assert-True ($compose -match 'pg_isready.+ASH_ATLAS_DATABASE_NAME') 'Compose health probes the selected runtime database'
Assert-True ($config.feature_launcher_root -eq 'C:\Users\dev\Documents\Ash Atlas Feature Launchers') 'feature launchers live outside Git at the canonical path'
Assert-True ($featureRuntime -match "ValidateSet\('create', 'sync', 'status', 'ready', 'park', 'mark-merged', 'remove', 'cleanup'\)") 'feature runtime exposes focused lifecycle commands'
Assert-True ($featureRuntime -match 'function Invoke-Ready' -and $featureRuntime -match 'RequirePushedCleanHead' -and
    $featureRuntime -match 'ls-remote.+refs/heads/' -and $featureRuntime -match 'WindowStyle Hidden' -and
    $featureRuntime.Contains("'-File', `$supervisorScript") -and $featureRuntime -match "'-RuntimeMode', 'Feature'.+'-WorktreePath'.+'-NoBrowser'" -and
    $featureRuntime -match 'ConvertTo-AshAtlasNativeArgument' -and $featureRuntime -match 'Test-ExactFeatureRuntimeReady') 'ready requires a clean exact pushed tip and starts the canonical hidden no-browser supervisor with visible quoted identity arguments'
Assert-True ($featureRuntime -notmatch 'EncodedCommand') 'ready bootstrap does not hide its script and worktree identity behind an encoded command'
Assert-True ($featureRuntime -match 'function Get-CurrentExactFeatureLease' -and
    ([regex]::Matches($featureRuntime, 'Get-CurrentExactFeatureLease \$lease')).Count -ge 3 -and
    $featureRuntime -match 'Write-FeatureRuntimeHandoffResult \$currentLease') 'ready refreshes and revalidates the current lease for launch-time ports, success output, and cleanup'
Assert-True ($featureRuntime -match 'function Get-CurrentExactFeatureLease[\s\S]+Enter-AshAtlasLeaseStoreMutex[\s\S]+Find-RegisteredLease[\s\S]+finally[\s\S]+Exit-AshAtlasLeaseStoreMutex') 'ready lease refresh is serialized with atomic lease-store replacement'
Assert-True ($featureRuntime -match '\[Guid\]::NewGuid\(\)\.ToString\(''N''\)' -and
    $featureRuntime -match 'ready-bootstrap-\$attemptId\.out\.log' -and
    $featureRuntime -match 'ready-bootstrap-\$attemptId\.err\.log') 'each spawned ready bootstrap uses collision-proof output logs'
Assert-True ($featureRuntime -match '\$process\.HasExited[\s\S]+\$process\.WaitForExit\(\)[\s\S]+\$process\.Refresh\(\)[\s\S]+\$exitCode = if') 'ready finalizes an exited bootstrap process before reporting its exit code'
Assert-True ($featureRuntime -match "ExitCode[\s\S]+IsNullOrWhiteSpace[\s\S]+\{ 'unavailable' \}") 'ready reports unavailable rather than a blank bootstrap exit code'
Assert-True ($featureRuntime -match 'ready\.checks\.database\.ok' -and $featureRuntime -match 'ready\.checks\.worldAuthority\.ok' -and
    $featureRuntime -match 'readyIdentity\.sha' -and $featureRuntime -match 'test_url' -and
    $featureRuntime -match 'supervisor_stderr') 'ready independently verifies exact runtime, DB, and World authority and returns URL and logs'
Assert-True ($featureRuntime -match 'function Invoke-Park' -and $featureRuntime -match 'Invoke-ParkExactFeatureRuntime' -and
    $featureRuntime -match '-WorktreePath \(\[string\]\$Lease\.worktree\) -Stop') 'park delegates to the canonical exact-runtime stop path'
Assert-True ($featureRuntime -match 'ConfirmAcceptedIntegration' -and $featureRuntime -match 'Get-TargetedMergedRemoteState' -and
    $featureRuntime -match 'remote\.merged_tag_sha' -and
    $featureRuntime -match 'merge-base.+--is-ancestor.+featureHead.+MergedTestSha') 'mark-merged requires explicit admission confirmation, targeted generation validation, and feature ancestry'
Assert-True ($featureRuntime -match 'Get-AshAtlasFeatureLauncherPath' -and $featureRuntime -match 'Get-AshAtlasMergedLauncherPath') 'active and merged launchers use the canonical directory helpers'
Assert-True ($featureRuntime -match '__MERGED_TO_TEST__\.md' -and $featureRuntime -match 'merged_launcher_path') 'merged marker and archived receipt identities are recorded'
Assert-True ($featureRuntime -match 'merged worktree marker is missing or differs' -and
    $featureRuntime -match 'Remove-Item -LiteralPath \$mergedMarkerPath') 'cleanup verifies and removes only the exact merged worktree marker'
Assert-True ($featureRuntime -match 'archived merged launcher is missing or differs' -and
    $featureRuntime -notmatch 'Remove-Item -LiteralPath \$archivedLauncher') 'cleanup validates and preserves the archived merged launcher'
Assert-True ($featureRuntime -match 'merged runtime must be removed by ownership-verified cleanup' -and
    $launcher -match 'merged runtime removal requires the ownership-verified integration cleanup marker') 'merged lease cannot be removed outside exact cleanup'
Assert-True ($featureRuntime -match 'worktree.+list.+--porcelain' -and $featureRuntime -match 'PreserveExistingPorts') 'sync discovers worktrees and preserves existing port leases'
Assert-True ($featureRuntime -match 'nothing was deleted') 'sync reports its non-destructive contract'
Assert-True ($featureRuntime -match 'cleanup-in-progress') 'sync and cleanup share an explicit cleanup marker'
Assert-True ($featureRuntime -match '\[string\]\$IntegratedRef' -and $featureRuntime -match '\$targetRef = if \(\$IntegratedRef\)') 'cleanup accepts an explicit integrated remote ref'
Assert-True ($featureRuntime -match 'refs/remotes/\$targetRef' -and $featureRuntime -match 'merge-base --is-ancestor \$head \$integratedSha') 'cleanup verifies exact supplied remote-ref ancestry'
Assert-True ($featureRuntime -match "else \{ 'origin/master' \}") 'cleanup preserves origin/master as a compatibility default'
Assert-True ($featureRuntime -match 'Find-OptionalRegisteredLease' -and $featureRuntime -match 'Assert-NoUnregisteredFeatureRuntimeArtifacts') 'never-registered Level 0 worktrees receive absence proofs before cleanup'
Assert-True ($featureRuntime -match 'members_registered' -and $featureRuntime -match 'members_live') 'unregistered cleanup refuses residual World group membership'
Assert-True ($featureRuntime -match "'ls-files', '--others', '--exclude-standard'") 'cleanup checks unique untracked files'
Assert-True ($featureRuntime -match 'Assert-FeatureResourceOwnership') 'cleanup verifies exact disposable resource ownership'
Assert-True ($featureRuntime -match 'worktree remove' -and $featureRuntime -match 'branch --delete --force') 'cleanup removes the local branch only after explicit remote-ref containment proof'
Assert-True ($featureRuntime.IndexOf('merge-base --is-ancestor $head $integratedSha') -lt $featureRuntime.IndexOf('branch --delete --force')) 'remote containment proof precedes local branch deletion'
Assert-True ($featureRuntime -notmatch '\bgit\s+merge\b') 'merge commands cannot trigger cleanup'
Assert-True ($launcher -match 'RequiredSuccesses = 4' -and $launcher -match 'MinimumStableSeconds = 3') 'PostgreSQL requires consecutive stable readiness'
Assert-True ($launcher -match 'State\.StartedAt' -and $launcher -match '\[string\]\$Runtime\.database') 'PostgreSQL readiness verifies stable container identity and exact database SQL'
Assert-True ($launcher -match 'function Test-WarmReusableRuntimePostgres' -and
    $launcher -match 'Assert-OwnedDockerResource \$before \$Runtime ''container''' -and
    $launcher -match '\[string\]\$after\.Id -eq \$beforeId' -and
    $launcher -match '\[int\]\$after\.State\.Pid -eq \$beforePid' -and
    $launcher -match '\[string\]\$after\.State\.StartedAt -eq \$beforeStartedAt' -and
    $launcher -match "'-d', \[string\]\`$Runtime\.database, '-tAc', 'SELECT 1;'" -and
    $launcher.IndexOf('if (Test-WarmReusableRuntimePostgres $Runtime)') -lt $launcher.IndexOf("Invoke-RuntimeCompose `$Runtime @('up', '-d', 'postgres')")) 'warm PostgreSQL reuse requires exact ownership, stable container identity, and SQL reachability before skipping Compose and stability delay'
Assert-True ($launcher -match 'maximumAttempts = 3' -and $launcher -match 'Test-TransientMigrationStartupFailure') 'migration retry is bounded and startup-transient only'
Assert-True ($launcher -match 'function Ensure-FeatureTelemetryExporterRole' -and
    $launcher -match "Runtime\.mode -ne 'Feature'.+telemetry exporter bootstrap is Feature-only" -and
    $launcher -match 'CREATE ROLE \$roleName NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS' -and
    $launcher -match 'NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit AND NOT rolreplication AND NOT rolbypassrls' -and
    $launcher -match "verify\.StdOut\.Trim\(\) -ne '1'") 'fresh Feature databases bootstrap and verify only the canonically restricted telemetry exporter group role'
Assert-True ($launcher.IndexOf('Invoke-ParallelRuntimePrerequisites $Runtime $paths') -lt $launcher.IndexOf('Ensure-FeatureTelemetryExporterRole $Runtime') -and
    $launcher.IndexOf('Ensure-FeatureTelemetryExporterRole $Runtime') -lt $launcher.IndexOf('Invoke-RuntimeMigrations $Runtime $paths')) 'Feature telemetry exporter bootstrap runs after owned PostgreSQL readiness and before migrations'
Assert-True ($launcher -match 'Ensure-AshAtlasFeatureWorldRuntime' -and $launcher -match 'Ensure-MainWorldRuntime') 'Main and grouped feature World API lifecycles are separated'
Assert-True ($launcher -match '\[switch\]\$FullWorldVerify' -and $launcher -notmatch 'FullWorldVerify is valid only with') 'full World verification is an explicit Main or Feature override'
Assert-True ($launcher -match '\$verificationMode = if \(\$FullWorldVerify\) \{ ''full'' \} else \{ ''manifest-only'' \}' -and $launcher.Contains("'--artifact-verification-mode', `$verificationMode")) 'Main defaults to manifest-only and selects full verification only explicitly'
Assert-True ($launcher -match 'Ensure-MainWorldRuntime \$Runtime -FullWorldVerify:\$FullWorldVerify') 'Main startup forwards the explicit full-verification override'
Assert-True ($launcher -match 'Ensure-AshAtlasFeatureWorldRuntime \$Config \$Runtime -FullWorldVerify:\$FullWorldVerify') 'Feature startup forwards the explicit full-verification override'
Assert-True ($worldGroups -match '\$verificationMode = if \(\$FullWorldVerify\) \{ ''full'' \} else \{ ''manifest-only'' \}') 'Feature groups default to manifest-only World admission'
Assert-True ($worldGroups.Contains("'--artifact-verification-mode', `$verificationMode") -and $worldGroups -match 'expected-manifest-sha256') 'Feature World admission receives the locked manifest identity'
Assert-True ($worldGroups -match 'Fast local World admission: manifest and identity verified; exhaustive package scan skipped') 'fast admission output is explicit'
Assert-True ($launcher -match 'Fast local World admission: manifest and identity verified; exhaustive package scan skipped') 'ordinary Main startup explicitly reports manifest-only admission'
Assert-True ($launcher -match 'Full World verification requested: verifying all 64,800 packages') 'explicit Main full verification remains visible'
Assert-True ($config.feature.world_api_group_port_pool.start -eq 41900 -and $config.feature.world_api_group_port_pool.end -eq 42199) 'tracked World API group pool is 41900-42199'
Assert-True ((Get-Content -Raw -LiteralPath (Join-Path $root 'tools\dev\world-runtime-groups.ps1')) -match 'Global\\AshAtlas_WorldRuntimeGroups') 'World API group mutation uses one machine-wide mutex'
Assert-True ($launcher -match 'Invoke-HealthyRuntimeReuse' -and $launcher -match 'Runtime is already healthy; reusing it') 'healthy repeat launch reuses and opens the exact runtime'
Assert-True ($launcher -match 'Test-LiveRecordedRuntimeSupervisor' -and $launcher -match 'PreserveExistingPorts -or \$hasLiveExactRuntime') 'active exact-runtime supervisor preserves stable feature ports'
Assert-True ($launcher -match 'Get-AshAtlasPortBlockingLeases' -and $launcher -match 'New-AshAtlasFeaturePortClaim' -and $launcher -match 'Release-FeaturePortClaim') 'feature ports are claimed only for a launcher session and released afterward'
Assert-True ($launcher -match 'function Resolve-FeatureInternalWorkerLease' -and
    $launcher -match 'Get-CimInstance -ClassName Win32_Process' -and
    $launcher -match 'ParentProcessId -ne \$ParentProcessId' -and
    $launcher -match 'Enter-AshAtlasLeaseStoreMutex' -and
    $launcher -match 'Test-AshAtlasFeaturePortClaimActive \$lease' -and
    $launcher -match "integration_status' ''\) -eq 'merged_to_test'" -and
    $launcher -match 'world\.canonical_identity -ne \[string\]\$expectedWorld\.canonical_identity') 'feature prerequisite workers borrow only their live parent exact registered lease and matching World identity under the lease mutex'
Assert-True ($launcher -match "(?s)'-InternalParentRuntimeId'.+'-InternalParentProcessId'.+'-InternalParentProcessStartTimeUtc'" -and
    $launcher -match 'Resolve-FeatureInternalWorkerLease \$runtime \$InternalParentRuntimeId \$InternalParentProcessId \$InternalParentProcessStartTimeUtc') 'parallel feature prerequisites receive and validate the exact parent process claim without full port discovery'
Assert-True ($featureRuntime -match 'Retire-MergedRuntimeReservation' -and $featureRuntime -match 'Retired merged runtime reservation') 'accepted features automatically retire their runtime reservation while preserving receipts'
Assert-True ($launcher -match 'supervisor\.json' -and $launcher -match 'start_time_utc' -and $launcher -match "'starting', 'healthy', 'stopping'") 'supervisor lifecycle records PID, process start, and phase'
Assert-True ($launcher -match 'Complete-RuntimeQuiescence' -and $launcher -match 'RuntimeShutdownWaitSeconds') 'stale or unhealthy exact runtime shutdown is bounded'
Assert-True ($launcher -notmatch 'WaitOne\(0\).+already active' -and $launcher -notmatch 'Read-Host') 'repeat launch neither fails immediately nor blocks external stop signals'
Assert-True ($launcher -match '--configLoader runner' -and $launcher -match "apps\\client'\) 'frontend'") 'feature frontend uses the verified Vite runner working directory'
Assert-True ($launcher -match 'retainedIdentityBefore' -and $launcher -match 'retained Main volume identity changed') 'Main repair proves retained volume identity is unchanged'
Assert-True ($launcher -notmatch 'Start Main first') 'Feature startup is independent of Main'
Assert-True ($launcher -match 'Feature merged into Integration Test; its runtime is retired') 'direct startup cannot resurrect a merged feature runtime'
Assert-True ((Get-Content -Raw -LiteralPath (Join-Path $root 'tools\dev\runtime-lib.ps1')) -match 'Global\\AshAtlas_DevRuntimeLeaseStore') 'lease updates are serialized across concurrent launchers'
Assert-True ($launcher.Contains("Join-Path `$Runtime.worktree 'config\world-runtime.lock.json'")) 'selected verified runtime worktree provides the world lock'
Assert-True (-not $launcher.Contains("Join-Path `$SupervisorRoot 'config\world-runtime.lock.json'")) 'supervisor checkout is not hardcoded as the Feature world lock source'
Assert-True ($launcher.IndexOf('$runtime = Resolve-SelectedRuntime') -lt $launcher.IndexOf('Set-WorldRuntimePolicy $runtime')) 'runtime identity is verified before its world lock is loaded'

$parkingRoot = Join-Path $env:TEMP ("ash-atlas-parking-policy-" + [guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Path $parkingRoot -Force | Out-Null
try {
    & {
        $Config = $config
        foreach ($name in @('Get-FeatureRuntimeParkingCandidates', 'Stop-ExcessFeatureRuntimes')) {
            $source = [regex]::Match($launcher, "(?ms)^function $name \{.*?(?=^function |\z)").Value
            Assert-True ([bool]$source) "$name is present in the launcher"
            . ([scriptblock]::Create($source))
        }
        $script:testLeases = @(
            [pscustomobject]@{ runtime_id = 'old'; worktree = 'C:\feature\old'; branch = 'feature/old'; updated_at_utc = '2026-01-04T00:00:00Z'; display_name = 'Old'; compose_project = 'old-project'; postgres_container = 'old-db'; network = 'old-net'; volume = 'old-volume'; database = 'ash_atlas_stability_old'; ports = [pscustomobject]@{ frontend = 41000; backend = 41001; postgres = 41002 } },
            [pscustomobject]@{ runtime_id = 'middle'; worktree = 'C:\feature\middle'; branch = 'feature/middle'; updated_at_utc = '2026-01-02T00:00:00Z'; display_name = 'Middle'; compose_project = 'middle-project'; postgres_container = 'middle-db'; network = 'middle-net'; volume = 'middle-volume'; database = 'ash_atlas_stability_middle'; ports = [pscustomobject]@{ frontend = 41003; backend = 41004; postgres = 41005 } },
            [pscustomobject]@{ runtime_id = 'new'; worktree = 'C:\feature\new'; branch = 'feature/new'; updated_at_utc = '2026-01-03T00:00:00Z'; display_name = 'New'; compose_project = 'new-project'; postgres_container = 'new-db'; network = 'new-net'; volume = 'new-volume'; database = 'ash_atlas_stability_new'; ports = [pscustomobject]@{ frontend = 41006; backend = 41007; postgres = 41008 } },
            [pscustomobject]@{ runtime_id = 'self'; worktree = 'C:\feature\self'; branch = 'feature/self'; updated_at_utc = '2026-01-01T00:00:00Z' },
            [pscustomobject]@{ runtime_id = 'main'; worktree = 'C:\Users\dev\Documents\game'; branch = 'master'; updated_at_utc = '2025-01-01T00:00:00Z' }
        )
        $script:parked = @()
        $script:attemptedStops = @()
        $script:holdMutexId = ''
        $script:supervisorPhase = 'starting'
        $script:stopFailureId = 'old'
        function Get-AshAtlasLeasePath { Join-Path $parkingRoot 'leases.json' }
        function Read-AshAtlasLeaseStore { [pscustomobject]@{ runtimes = $script:testLeases } }
        function Get-RunningAshAtlasRuntimeIds { return ,@('main', 'self', 'old', 'middle', 'new', 'unregistered') }
        function New-AshAtlasFeatureIdentity { param($Config, $WorktreePath, $Branch) $script:testLeases | Where-Object { $_.worktree -eq $WorktreePath } | Select-Object -First 1 | ForEach-Object {
            [pscustomobject]@{ runtime_id = $_.runtime_id; mode = 'Feature'; worktree = $_.worktree; branch = $_.branch; compose_project = $_.compose_project; postgres_container = $_.postgres_container; network = $_.network; volume = $_.volume; database = $_.database; ports = $_.ports }
        } }
        function Test-AshAtlasSafeFeatureRuntime { param($Config, $Runtime) $true }
        function Enter-AshAtlasRuntimeLifecycleMutex { param($RuntimeId, $TimeoutSeconds) if ($RuntimeId -eq $script:holdMutexId) { throw "Timed out after 0 seconds waiting for runtime $RuntimeId to finish shutdown" }; [pscustomobject]@{ runtime_id = $RuntimeId } }
        function Exit-AshAtlasRuntimeLifecycleMutex { param($Handle) }
        function Get-RuntimeStatePaths { param($Runtime) [pscustomobject]@{ root = $parkingRoot } }
        function Get-RuntimeSupervisorStatus { param($Runtime, $Paths) [pscustomobject]@{ status = 'match'; state = [pscustomobject]@{ phase = $script:supervisorPhase } } }
        function Stop-SelectedRuntime { param($Runtime) $script:attemptedStops += [string]$Runtime.runtime_id; if ($Runtime.runtime_id -eq $script:stopFailureId) { throw 'simulated stop failure' }; $script:parked += [string]$Runtime.runtime_id }

        $oldStateRoot = Join-Path $parkingRoot 'runtimes\old'
        New-Item -ItemType Directory -Path $oldStateRoot -Force | Out-Null
        [pscustomobject]@{ runtime_id = 'old'; worktree = 'C:\feature\old'; started_at_utc = '2026-01-01T00:00:00Z' } |
            ConvertTo-Json | Set-Content -LiteralPath (Join-Path $oldStateRoot 'supervisor.json')
        $runningIds = Get-RunningAshAtlasRuntimeIds
        $candidates = @(Get-FeatureRuntimeParkingCandidates 'self' $runningIds $script:testLeases)
        Assert-Equal (($candidates | ForEach-Object { $_.runtime_id }) -join ',') 'old,middle,new' 'supervisor start sorts first, lease time falls back, and Main, self, and unregistered runtimes are excluded'
        Stop-ExcessFeatureRuntimes ([pscustomobject]@{ mode = 'Feature'; runtime_id = 'self' }) 0
        Assert-Equal $script:parked.Count 0 'zero cap disables parking'
        Stop-ExcessFeatureRuntimes ([pscustomobject]@{ mode = 'Feature'; runtime_id = 'self' }) 3
        Assert-Equal ($script:parked -join ',') 'middle' 'failed oldest stop is skipped and next candidate is parked'
        $script:parked = @()
        $script:attemptedStops = @()
        $script:holdMutexId = 'old'
        Stop-ExcessFeatureRuntimes ([pscustomobject]@{ mode = 'Feature'; runtime_id = 'self' }) 3
        Assert-Equal ($script:attemptedStops -join ',') 'middle' 'a starting runtime with a held lifecycle mutex is not stopped'
        $script:parked = @()
        $script:attemptedStops = @()
        $script:supervisorPhase = 'healthy'
        $script:stopFailureId = ''
        Stop-ExcessFeatureRuntimes ([pscustomobject]@{ mode = 'Feature'; runtime_id = 'self' }) 3
        Assert-Equal ($script:attemptedStops -join ',') 'old' 'a healthy exact supervisor can be parked through its stop signal'
    }
} finally {
    if (-not ([IO.Path]::GetFullPath($parkingRoot)).StartsWith(([IO.Path]::GetFullPath($env:TEMP)).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'REFUSED: parking test cleanup path escaped TEMP.'
    }
    Remove-Item -LiteralPath $parkingRoot -Recurse -Force
}

$native = Invoke-AshAtlasNative (Get-Command cmd.exe).Source @('/d', '/c', 'echo PS5_NATIVE_OK')
Assert-Equal $native.ExitCode 0 'native wrapper exit code'
Assert-Equal $native.StdOut.Trim() 'PS5_NATIVE_OK' 'native wrapper captures stdout without NativeCommandError'

Write-Host "runtime-policy.tests.ps1: $script:Passed assertions passed." -ForegroundColor Green
& (Join-Path $PSScriptRoot 'feature-port-lease-resolver.tests.ps1')
