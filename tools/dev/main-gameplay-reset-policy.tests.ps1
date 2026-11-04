$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
. (Join-Path $PSScriptRoot 'runtime-lib.ps1')
. (Join-Path $PSScriptRoot 'main-gameplay-reset-lib.ps1')
$config = Read-AshAtlasRuntimeDefaults (Join-Path $root 'config\dev-runtime.defaults.json')
$script:Passed = 0

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
    $script:Passed++
}
function Assert-Throws([scriptblock]$Action, [string]$Pattern, [string]$Message) {
    try { & $Action; throw "ASSERTION FAILED: $Message did not throw." }
    catch { if ($_.Exception.Message -notmatch $Pattern) { throw "ASSERTION FAILED: $Message threw '$($_.Exception.Message)'." } }
    $script:Passed++
}

$manifest = Get-AshAtlasMainGameplayResetManifest
$preserved = @(Get-AshAtlasMainGameplayPreservedTables)
$classified = @($manifest.Values | ForEach-Object { @($_) }) + $preserved
Assert-AshAtlasMainResetTableClassification $classified $manifest $preserved
Assert-Throws {
    Assert-AshAtlasMainResetTableClassification @($classified + 'unknown_runtime_rows') $manifest $preserved
} 'unclassified public tables' 'unknown tables are refused'
Assert-Throws {
    Assert-AshAtlasMainResetTableClassification @($classified | Where-Object { $_ -ne 'players' }) $manifest $preserved
} 'classified public tables are missing' 'missing audited tables are refused'
Assert-AshAtlasMainResetCascadeClosure @(
    [pscustomobject]@{ child_schema = 'public'; child_table = 'flags'; parent_schema = 'public'; parent_table = 'players' }
) $manifest $preserved
Assert-Throws {
    Assert-AshAtlasMainResetCascadeClosure @(
        [pscustomobject]@{ child_schema = 'public'; child_table = 'schema_migrations'; parent_schema = 'public'; parent_table = 'players' }
    ) $manifest $preserved
} 'outside the reset manifest' 'preserved child reachable by cascade is refused'
Assert-Throws {
    Assert-AshAtlasMainResetCascadeClosure @(
        [pscustomobject]@{ child_schema = 'audit'; child_table = 'external_player_rows'; parent_schema = 'public'; parent_table = 'players' }
    ) $manifest $preserved
} 'outside the reset manifest' 'cross-schema cascade is refused'
Assert-True ($preserved -contains 'schema_migrations') 'migration ledger is explicitly preserved'
Assert-True ($manifest.players_progression_inventory -contains 'players') 'players are reset'
Assert-True ($manifest.flags_cities_kingdoms_manors_parties_travel -contains 'flags') 'flags are reset'
Assert-True ($manifest.markets_wallets_economy -contains 'market_orders') 'market runtime data is reset'
Assert-True ($manifest.world_resources_and_runtime -contains 'repeatable_resource_nodes') 'resource runtime data is reset'

$mainInspection = [pscustomobject]@{
    Name = '/ash-atlas-postgis'
    Config = [pscustomobject]@{ Labels = [pscustomobject]@{
        'com.ash-atlas.owner' = 'ash-atlas-dev-runtime'
        'com.ash-atlas.runtime-id' = 'main'
        'com.ash-atlas.runtime-mode' = 'main'
        'com.ash-atlas.database-disposition' = 'retained'
    } }
    Mounts = @([pscustomobject]@{ Type = 'volume'; Name = 'ash-atlas_ash_atlas_game_postgres' })
    NetworkSettings = [pscustomobject]@{ Ports = [pscustomobject]@{
        '5432/tcp' = @([pscustomobject]@{ HostIp = '127.0.0.1'; HostPort = '35432' })
    } }
}
Assert-True (Test-AshAtlasMainResetContainerIdentity $config $mainInspection) 'exact protected Main container accepted'
$mainInspection.Config.Labels.'com.ash-atlas.runtime-mode' = 'feature'
Assert-True (-not (Test-AshAtlasMainResetContainerIdentity $config $mainInspection)) 'feature container refused'
$mainInspection.Config.Labels.'com.ash-atlas.runtime-mode' = 'main'
$mainInspection.Mounts[0].Name = 'ash-atlas-feature-pg'
Assert-True (-not (Test-AshAtlasMainResetContainerIdentity $config $mainInspection)) 'unknown volume refused'

$tool = Get-Content -Raw -LiteralPath (Join-Path $root 'tools\dev\reset-main-gameplay-data.ps1')
Assert-True ($tool -match 'ConfirmAuthorizedMainGameplayReset') 'directly authorized reset confirmation is mandatory'
Assert-True ($tool -match 'direct user authorization for this exact reset and IntegratedMasterSha') 'confirmation is tied to one exact reset and SHA'
Assert-True ($tool -notmatch 'ConfirmPreBetaIntegrationReset') 'legacy automatic-integration reset language is removed'
Assert-True ($tool -match 'Get-AshAtlasMainResetDockerInspection' -and $tool -notmatch 'Get-DockerInspection') 'reset uses its shared Docker inspection helper'
Assert-True ($tool -match 'BEGIN;' -and $tool -match 'COMMIT;' -and $tool -match 'ON_ERROR_STOP=1') 'reset is transactional and fail-fast'
Assert-True ($tool -match 'Assert-AshAtlasMainResetCascadeClosure' -and $tool -notmatch 'RESTART IDENTITY CASCADE') 'reset proves cascade closure and does not rely on implicit cascade deletion'
Assert-True ($tool -match 'players remain after gameplay reset' -and $tool -match 'flags remain after gameplay reset') 'post-reset players and flags are verified empty'
Assert-True ($tool -match 'main-gameplay-resets' -and $tool -match 'integrated_master_sha') 'integrated master SHA receipt is recorded'

Write-Host "main-gameplay-reset-policy.tests.ps1: $script:Passed assertions passed." -ForegroundColor Green
