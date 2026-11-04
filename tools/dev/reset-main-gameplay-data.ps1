[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$IntegratedMasterSha,
    [switch]$ConfirmAuthorizedMainGameplayReset
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')).TrimEnd('\')
. (Join-Path $PSScriptRoot 'runtime-lib.ps1')
. (Join-Path $PSScriptRoot 'main-gameplay-reset-lib.ps1')
$config = Read-AshAtlasRuntimeDefaults (Join-Path $root 'config\dev-runtime.defaults.json')

if (-not $ConfirmAuthorizedMainGameplayReset) {
    throw 'REFUSED: pass -ConfirmAuthorizedMainGameplayReset only after direct user authorization for this exact reset and IntegratedMasterSha.'
}
if ($IntegratedMasterSha -notmatch '^[a-f0-9]{40}$') { throw 'IntegratedMasterSha must be an exact 40-character Git SHA.' }
$permanent = [IO.Path]::GetFullPath([string]$config.permanent_checkout).TrimEnd('\')
if (-not [string]::Equals($root, $permanent, [StringComparison]::OrdinalIgnoreCase)) {
    throw "REFUSED: Main reset must run from protected checkout $permanent."
}
if ((Get-AshAtlasGitValue $root @('branch', '--show-current')) -ne [string]$config.main.branch) {
    throw 'REFUSED: Main reset requires the protected master branch.'
}
$head = Get-AshAtlasGitValue $root @('rev-parse', 'HEAD')
$originHead = Get-AshAtlasGitValue $root @('rev-parse', 'origin/master')
if ($head -ne $IntegratedMasterSha -or $originHead -ne $IntegratedMasterSha) {
    throw "REFUSED: integrated SHA, protected checkout HEAD, and origin/master must match exactly."
}
if (Get-AshAtlasGitValue $root @('status', '--porcelain')) { throw 'REFUSED: protected checkout is not clean.' }
if ([string]$config.main.database.name -ne 'ash_atlas_game' -or $config.main.database.retained -ne $true) {
    throw 'REFUSED: tracked Main database identity is not the retained ash_atlas_game database.'
}
foreach ($port in @([int]$config.main.ports.backend, [int]$config.main.ports.frontend)) {
    if ((Get-AshAtlasListeningPorts) -contains $port) {
        throw "REFUSED: protected Main application port $port is still listening; stop Main before reset."
    }
}

$inspection = Get-AshAtlasMainResetDockerInspection ([string]$config.main.postgres_container)
if (-not (Test-AshAtlasMainResetContainerIdentity $config $inspection)) {
    throw 'REFUSED: PostgreSQL container, labels, port, or retained volume do not match protected Main.'
}
$database = [string]$config.main.database.name
$user = [string]$config.main.database.user
$container = [string]$config.main.postgres_container
$actualDatabase = (& docker exec $container psql -X -v ON_ERROR_STOP=1 -U $user -d $database -tAc 'SELECT current_database();').Trim()
if ($LASTEXITCODE -ne 0 -or $actualDatabase -ne 'ash_atlas_game') {
    throw "REFUSED: SQL session did not prove exact database ash_atlas_game."
}

$manifest = Get-AshAtlasMainGameplayResetManifest
$preserved = @(Get-AshAtlasMainGameplayPreservedTables)
$actualTables = @(& docker exec $container psql -X -v ON_ERROR_STOP=1 -U $user -d $database -tAc "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;")
if ($LASTEXITCODE -ne 0) { throw 'Could not audit protected Main public tables.' }
Assert-AshAtlasMainResetTableClassification $actualTables $manifest $preserved
$foreignKeyRows = @(& docker exec $container psql -X -v ON_ERROR_STOP=1 -U $user -d $database -Atc @"
SELECT child_ns.nspname || '|' || child.relname || '|' || parent_ns.nspname || '|' || parent.relname
FROM pg_constraint constraint_row
JOIN pg_class child ON child.oid = constraint_row.conrelid
JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
JOIN pg_class parent ON parent.oid = constraint_row.confrelid
JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
WHERE constraint_row.contype = 'f'
ORDER BY 1;
"@)
if ($LASTEXITCODE -ne 0) { throw 'Could not audit protected Main foreign-key cascade closure.' }
$foreignKeys = @($foreignKeyRows | ForEach-Object {
    $parts = $_ -split '\|'
    [pscustomobject]@{
        child_schema = $parts[0]
        child_table = $parts[1]
        parent_schema = $parts[2]
        parent_table = $parts[3]
    }
})
Assert-AshAtlasMainResetCascadeClosure $foreignKeys $manifest $preserved

$receiptRoot = Join-Path $env:LOCALAPPDATA 'AshAtlas\main-gameplay-resets'
$receiptPath = Join-Path $receiptRoot "$IntegratedMasterSha.json"
$resetTables = @($manifest.Values | ForEach-Object { @($_) })
$quotedTables = @($resetTables | ForEach-Object { ConvertTo-AshAtlasQuotedSqlIdentifier $_ })
$countSql = ($resetTables | ForEach-Object { "SELECT '$($_)' AS table_name, count(*)::bigint AS row_count FROM $(ConvertTo-AshAtlasQuotedSqlIdentifier $_)" }) -join " UNION ALL "

if (Test-Path -LiteralPath $receiptPath -PathType Leaf) {
    $remaining = @(& docker exec $container psql -X -v ON_ERROR_STOP=1 -U $user -d $database -Atc "$countSql ORDER BY table_name;")
    if ($LASTEXITCODE -ne 0 -or @($remaining | Where-Object { [long](($_ -split '\|')[1]) -ne 0 }).Count -gt 0) {
        throw "REFUSED: reset receipt already exists for $IntegratedMasterSha but gameplay data was repopulated."
    }
    Write-Host "Main gameplay reset already completed for $IntegratedMasterSha; all audited gameplay tables remain empty."
    exit 0
}

$beforeRows = @(& docker exec $container psql -X -v ON_ERROR_STOP=1 -U $user -d $database -Atc "$countSql ORDER BY table_name;")
if ($LASTEXITCODE -ne 0) { throw 'Could not count protected Main gameplay rows before reset.' }
$before = @{}
foreach ($row in $beforeRows) { $parts = $row -split '\|'; $before[$parts[0]] = [long]$parts[1] }

$sql = @"
BEGIN;
SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '120s';
TRUNCATE TABLE $($quotedTables -join ', ') RESTART IDENTITY;
DO `$audit`$
BEGIN
  IF EXISTS (SELECT 1 FROM players) THEN RAISE EXCEPTION 'players remain after gameplay reset'; END IF;
  IF EXISTS (SELECT 1 FROM flags) THEN RAISE EXCEPTION 'flags remain after gameplay reset'; END IF;
END
`$audit`$;
COMMIT;
"@
$output = @($sql | & docker exec -i $container psql -X -v ON_ERROR_STOP=1 -U $user -d $database 2>&1)
if ($LASTEXITCODE -ne 0) { throw "Main gameplay reset rolled back: $($output -join [Environment]::NewLine)" }

$afterRows = @(& docker exec $container psql -X -v ON_ERROR_STOP=1 -U $user -d $database -Atc "$countSql ORDER BY table_name;")
if ($LASTEXITCODE -ne 0 -or @($afterRows | Where-Object { [long](($_ -split '\|')[1]) -ne 0 }).Count -gt 0) {
    throw 'Post-commit gameplay reset verification failed.'
}
$preservedLedgerCount = (& docker exec $container psql -X -v ON_ERROR_STOP=1 -U $user -d $database -tAc 'SELECT count(*) FROM schema_migrations;').Trim()
if ($LASTEXITCODE -ne 0 -or [long]$preservedLedgerCount -lt 1) { throw 'Migration ledger preservation check failed.' }

$categoryResults = @($manifest.GetEnumerator() | ForEach-Object {
    [pscustomobject][ordered]@{
        category = [string]$_.Key
        tables = @($_.Value)
        rows_removed = [long](($_.Value | ForEach-Object { $before[$_] } | Measure-Object -Sum).Sum)
    }
})
$receipt = [pscustomobject][ordered]@{
    schema_version = 1
    integrated_master_sha = $IntegratedMasterSha
    completed_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    container = $container
    database = $database
    retained_volume = [string]$config.main.database.volume
    categories = $categoryResults
    preserved_tables = $preserved
    schema_migrations_rows_preserved = [long]$preservedLedgerCount
}
New-Item -ItemType Directory -Path $receiptRoot -Force | Out-Null
$temporaryReceipt = "$receiptPath.$PID.tmp"
[IO.File]::WriteAllText($temporaryReceipt, ($receipt | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $temporaryReceipt -Destination $receiptPath -Force

Write-Host "Protected Main gameplay reset completed for $IntegratedMasterSha."
foreach ($category in $categoryResults) {
    Write-Host ("Reset category {0}: {1} row(s) across [{2}]" -f $category.category, $category.rows_removed, ($category.tables -join ', '))
}
Write-Host "Preserved schema_migrations ($preservedLedgerCount rows), schema objects, reference definitions, World/release identity, and runtime configuration."
Write-Host "Receipt: $receiptPath"
