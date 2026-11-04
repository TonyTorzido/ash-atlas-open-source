[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('start', 'stop', 'status', 'reset', 'migrate', 'seed', 'test', 'fault', 'cleanup')]
    [string]$Command = 'status',

    [Parameter(Position = 1)]
    [ValidateSet('queue-saturation', 'database-outage', 'world-api-outage', 'slow-request', 'crash-restart', 'two-writer')]
    [string]$FaultKind,

    [switch]$PurgeArtifacts
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'port-policy.ps1')

$script:GameRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$script:WorldRuntimeLockPath = [IO.Path]::GetFullPath((Join-Path $script:GameRoot 'config\world-runtime.lock.json'))
if (-not (Test-Path -LiteralPath $script:WorldRuntimeLockPath -PathType Leaf)) {
    throw "World runtime lock is missing: $($script:WorldRuntimeLockPath)"
}
$script:WorldRuntimeLock = Get-Content -Raw -LiteralPath $script:WorldRuntimeLockPath | ConvertFrom-Json
$script:ExpectedPipelineBranch = [string]$script:WorldRuntimeLock.pipeline.protected_branch
$script:ExpectedPipelineSha = [string]$script:WorldRuntimeLock.pipeline.sha
$script:ExpectedManifestSha256 = [string]$script:WorldRuntimeLock.release.manifest_sha256
$pipelineRootSetting = if ($env:ASH_ATLAS_STABILITY_PIPELINE_ROOT) { $env:ASH_ATLAS_STABILITY_PIPELINE_ROOT } else { 'C:\Users\dev\Documents\world-pipeline' }
$releaseRootSetting = if ($env:ASH_ATLAS_STABILITY_RELEASE_ROOT) { $env:ASH_ATLAS_STABILITY_RELEASE_ROOT } else { 'C:\Users\dev\Documents\world-pipeline\data\intermediate\global-packages\world-packages-v1' }
$script:PipelineRoot = [IO.Path]::GetFullPath($pipelineRootSetting)
$script:ReleaseRoot = [IO.Path]::GetFullPath($releaseRootSetting)
$script:LabRoot = [IO.Path]::GetFullPath((Join-Path $env:TEMP 'ash-atlas-stability-lab'))
$script:LogRoot = Join-Path $script:LabRoot 'logs'
$script:RunRoot = Join-Path $script:LabRoot 'run'
$script:ReleaseFixtureRoot = Join-Path $script:LabRoot 'releases'
$script:StatePath = Join-Path $script:RunRoot 'owned-processes.json'
$script:IdentityPath = Join-Path $script:RunRoot 'identity.json'
$script:ContainerName = 'ash-atlas-stability-postgis'
$script:ContainerLabel = 'com.ash-atlas.stability-lab=true'
$script:DatabaseName = 'ash_atlas_stability'
$script:DatabaseUser = 'ash_atlas_stability'
$script:DatabasePassword = 'ash-atlas-stability-only'
$script:ForbiddenPorts = @(5270, 3000, 8765, 35432)
$script:LocalConfigPath = Join-Path $PSScriptRoot 'stability-lab.local.psd1'
$localDatabasePort = $null
if (Test-Path -LiteralPath $script:LocalConfigPath -PathType Leaf) {
    $localConfig = Import-PowerShellDataFile -LiteralPath $script:LocalConfigPath
    $localDatabasePort = $localConfig.DatabasePort
}
$databasePortSetting = if ($env:ASH_ATLAS_STABILITY_DATABASE_PORT) {
    $script:DatabasePortSource = 'ASH_ATLAS_STABILITY_DATABASE_PORT'
    $env:ASH_ATLAS_STABILITY_DATABASE_PORT
} elseif ($null -ne $localDatabasePort) {
    $script:DatabasePortSource = 'stability-lab.local.psd1'
    [string]$localDatabasePort
} else {
    $script:DatabasePortSource = 'default'
    $null
}
$script:DatabasePort = Resolve-StabilityDatabasePort `
    -Override $databasePortSetting `
    -ForbiddenPorts $script:ForbiddenPorts
$script:WorldPort = 8865
$script:GamePort = 3100
$script:FrontendPort = 5370
$script:DatabaseUrl = "postgresql://$($script:DatabaseUser):$($script:DatabasePassword)@127.0.0.1:$($script:DatabasePort)/$($script:DatabaseName)"

function Assert-CommandAvailable([string]$Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command is unavailable: $Name"
    }
}

function Assert-DatabaseUrl([string]$Url) {
    $parsed = [Uri]$Url
    $database = $parsed.AbsolutePath.TrimStart('/')
    if ($database -eq 'ash_atlas_game' -or $Url -match '/ash_atlas_game(?:[/?#]|$)') {
        throw 'REFUSED: stability lab may not connect to ash_atlas_game'
    }
    if ($parsed.Port -eq 35432) {
        throw 'REFUSED: stability lab may not use retained Postgres port 35432'
    }
    if (-not $database.StartsWith('ash_atlas_stability', [StringComparison]::Ordinal)) {
        throw "REFUSED: stability database must begin with ash_atlas_stability: $database"
    }
}

function Assert-Roots {
    foreach ($root in @($script:GameRoot, $script:PipelineRoot, $script:ReleaseRoot)) {
        if (-not (Test-Path -LiteralPath $root -PathType Container)) {
            throw "Required stability-lab path is missing: $root"
        }
    }
    $gameSha = (& git -C $script:GameRoot rev-parse HEAD).Trim()
    $pipelineBranch = (& git -C $script:PipelineRoot branch --show-current).Trim()
    $pipelineSha = (& git -C $script:PipelineRoot rev-parse HEAD).Trim()
    if ($gameSha -notmatch '^[0-9a-f]{40}$') {
        throw "Game stability lab requires an exact tracked Git SHA; found $gameSha"
    }
    if ($pipelineBranch -ne $script:ExpectedPipelineBranch -or $pipelineSha -ne $script:ExpectedPipelineSha) {
        throw "Pipeline stability lab requires locked runtime $($script:ExpectedPipelineBranch) @ $($script:ExpectedPipelineSha); found $pipelineBranch @ $pipelineSha"
    }
    if ([IO.Path]::GetFileName($script:ReleaseRoot) -ne 'world-packages-v1') {
        throw 'REFUSED: normal integration release must be immutable world-packages-v1'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $script:ReleaseRoot 'manifest.json') -PathType Leaf)) {
        throw 'REFUSED: release root has no manifest.json'
    }
    $manifestSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $script:ReleaseRoot 'manifest.json')).Hash.ToLowerInvariant()
    if ($manifestSha256 -ne $script:ExpectedManifestSha256) {
        throw 'REFUSED: release manifest SHA-256 does not match the runtime lock'
    }
    Assert-DatabaseUrl $script:DatabaseUrl
    foreach ($port in @($script:FrontendPort, $script:GamePort, $script:WorldPort, $script:DatabasePort)) {
        if ($script:ForbiddenPorts -contains $port) {
            throw "REFUSED: configured stability port is forbidden: $port"
        }
    }
}

function Initialize-LabDirectories {
    foreach ($path in @($script:LabRoot, $script:LogRoot, $script:RunRoot, $script:ReleaseFixtureRoot)) {
        New-Item -ItemType Directory -Path $path -Force | Out-Null
    }
}

function Get-OwnedProcesses {
    if (-not (Test-Path -LiteralPath $script:StatePath -PathType Leaf)) { return @() }
    $raw = Get-Content -Raw -LiteralPath $script:StatePath
    if (-not $raw.Trim()) { return @() }
    $parsed = ConvertFrom-Json $raw
    if ($parsed -is [Array]) { return @($parsed) }
    return @($parsed)
}

function Save-OwnedProcesses([object[]]$Processes) {
    ConvertTo-Json -InputObject @($Processes) -Depth 6 | Set-Content -LiteralPath $script:StatePath -Encoding utf8
}

function Add-OwnedProcess([string]$Name, [Diagnostics.Process]$Process, [string]$Marker, [string]$CommandLine) {
    $processes = @(Get-OwnedProcesses)
    $processes += [ordered]@{
        name = $Name
        pid = $Process.Id
        marker = $Marker
        command = $CommandLine
        started_at = [DateTimeOffset]::Now.ToString('o')
    }
    Save-OwnedProcesses $processes
}

function Get-CimProcess([int]$ProcessId) {
    Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
}

function Test-OwnedProcessRecord($Record) {
    $process = Get-CimProcess ([int]$Record.pid)
    if (-not $process) { return $false }
    return [string]$process.CommandLine -like "*$($Record.marker)*"
}

function Assert-PortAvailable([int]$Port) {
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
    if ($listeners.Count -eq 0) { return }
    $owned = @(Get-OwnedProcesses)
    foreach ($listener in $listeners) {
        $owner = Get-CimProcess ([int]$listener.OwningProcess)
        $ownedMatch = $false
        foreach ($record in $owned) {
            if ([int]$record.pid -eq [int]$listener.OwningProcess -and (Test-OwnedProcessRecord $record)) {
                $ownedMatch = $true
                break
            }
        }
        if (-not $ownedMatch) {
            $description = if ($owner) { "$($owner.Name) pid=$($owner.ProcessId)" } else { "pid=$($listener.OwningProcess)" }
            throw "REFUSED: port $Port is owned by an unrelated process ($description)"
        }
    }
}

function Get-ContainerId {
    $output = @(& docker ps -a --filter "name=^/$($script:ContainerName)$" --format '{{.ID}}')
    return (($output -join '')).Trim()
}

function Assert-OwnedContainer([string]$ContainerId) {
    if (-not $ContainerId) { return }
    $labelsOutput = @(& docker inspect --format '{{json .Config.Labels}}' $ContainerId)
    if ($LASTEXITCODE -ne 0 -or $labelsOutput.Count -eq 0) {
        throw "Could not inspect ownership labels for container $ContainerId"
    }
    $labels = (($labelsOutput -join '') | ConvertFrom-Json)
    $label = $labels.'com.ash-atlas.stability-lab'
    if ($label -ne 'true') {
        throw "REFUSED: container name $($script:ContainerName) exists without the stability-lab ownership label"
    }
}

function Start-Database {
    $container = Get-ContainerId
    $created = $false
    if ($container) {
        Assert-OwnedContainer $container
        $running = (& docker inspect --format '{{.State.Running}}' $container).Trim()
        if ($running -ne 'true') {
            Assert-StabilityPortUnoccupied $script:DatabasePort
            & docker start $container | Out-Null
        }
    } else {
        Assert-StabilityPortUnoccupied $script:DatabasePort
        $created = $true
        & docker run -d `
            --name $script:ContainerName `
            --label $script:ContainerLabel `
            --label "com.ash-atlas.stability-root=$($script:LabRoot)" `
            -e "POSTGRES_DB=$($script:DatabaseName)" `
            -e "POSTGRES_USER=$($script:DatabaseUser)" `
            -e "POSTGRES_PASSWORD=$($script:DatabasePassword)" `
            -p "127.0.0.1:$($script:DatabasePort):5432" `
            postgis/postgis:16-3.4 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Failed to create isolated stability PostGIS container' }
    }
    if ($created) {
        for ($attempt = 0; $attempt -lt 120; $attempt += 1) {
            $previousPreference = $ErrorActionPreference
            try {
                $ErrorActionPreference = 'Continue'
                $logs = @(& docker logs $script:ContainerName 2>&1)
            } finally {
                $ErrorActionPreference = $previousPreference
            }
            if (($logs -join "`n") -like '*PostgreSQL init process complete; ready for start up.*') { break }
            Start-Sleep -Milliseconds 500
        }
        if ($attempt -ge 120) { throw 'Isolated PostGIS initialization did not complete' }
    }
    for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
        & docker exec $script:ContainerName psql -v ON_ERROR_STOP=1 -U $script:DatabaseUser -d $script:DatabaseName -Atc 'SELECT current_database()' *> $null
        if ($LASTEXITCODE -eq 0) { return }
        Start-Sleep -Milliseconds 500
    }
    throw 'Isolated PostGIS did not become ready'
}

function Remove-Database {
    $container = Get-ContainerId
    if (-not $container) { return }
    Assert-OwnedContainer $container
    & docker rm -f $container | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Failed to remove isolated stability PostGIS container' }
}

function Invoke-Migrations {
    Start-Database
    $previous = $env:DATABASE_URL
    try {
        $env:DATABASE_URL = $script:DatabaseUrl
        & pnpm --dir $script:GameRoot db:migrate
        if ($LASTEXITCODE -ne 0) { throw "Migration failed with exit code $LASTEXITCODE" }
    } finally {
        $env:DATABASE_URL = $previous
    }
}

function Invoke-Seed {
    Invoke-Migrations
    $sql = @"
INSERT INTO players (id,username,username_normalized,region_code,lat,lon,anchor_lat,anchor_lon,move_leash_radius_m,online,geom)
VALUES
 ('stability-player-a','StabilityA','stabilitya','GLOBAL',35.0844,-106.6504,35.0844,-106.6504,600,false,ST_SetSRID(ST_MakePoint(-106.6504,35.0844),4326)),
 ('stability-player-b','StabilityB','stabilityb','GLOBAL',35.0845,-106.6505,35.0845,-106.6505,600,false,ST_SetSRID(ST_MakePoint(-106.6505,35.0845),4326))
ON CONFLICT (id) DO UPDATE SET username=EXCLUDED.username,username_normalized=EXCLUDED.username_normalized;
"@
    $sql | & docker exec -i $script:ContainerName psql -v ON_ERROR_STOP=1 -U $script:DatabaseUser -d $script:DatabaseName
    if ($LASTEXITCODE -ne 0) { throw 'Stability seed failed' }
}

function Wait-Http([string]$Url, [int]$Seconds = 90) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    do {
        try {
            return Invoke-RestMethod -Uri $Url -TimeoutSec 5
        } catch {
            Start-Sleep -Milliseconds 500
        }
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Timed out waiting for $Url"
}

function Start-TrackedProcess(
    [string]$Name,
    [string]$FilePath,
    [string[]]$Arguments,
    [string]$WorkingDirectory,
    [string]$Marker
) {
    $existing = @(Get-OwnedProcesses | Where-Object { $_.name -eq $Name -and (Test-OwnedProcessRecord $_) })
    if ($existing.Count -gt 0) { return }
    $stdout = Join-Path $script:LogRoot "$Name.stdout.log"
    $stderr = Join-Path $script:LogRoot "$Name.stderr.log"
    $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru
    Add-OwnedProcess $Name $process $Marker ("$FilePath " + ($Arguments -join ' '))
}

function Write-GameRunScript([string]$Name, [int]$Port) {
    $path = Join-Path $script:RunRoot "$Name.cmd"
    $gameSha = (& git -C $script:GameRoot rev-parse HEAD).Trim()
    $gameBranch = (& git -C $script:GameRoot branch --show-current).Trim()
    $content = @"
@echo off
setlocal
cd /d "$($script:GameRoot)"
set "NODE_ENV=development"
set "RUNTIME_LABEL=stability-lab-$Name"
set "RUNTIME_BRANCH=$gameBranch"
set "RUNTIME_SHA=$gameSha"
set "PORT=$Port"
set "CLIENT_ORIGIN=http://127.0.0.1:$($script:FrontendPort)"
set "APP_PUBLIC_ORIGIN=http://127.0.0.1:$($script:FrontendPort)"
set "AUTH_ALLOWED_ORIGINS=http://127.0.0.1:$($script:FrontendPort)"
set "DATABASE_URL=$($script:DatabaseUrl)"
set "WORLD_API_BASE=http://127.0.0.1:$($script:WorldPort)"
set "ALLOW_DEGRADED_WORLD_LOOKUPS_IN_DEV=false"
set "AUTH_RUNTIME_MODE=local"
set "AUTH_MODE=dev"
set "AUTH_DEV_LOGIN_ENABLED=true"
set "DEV_ADMIN_TOOLS_ENABLED=true"
set "DEV_AUTHORIZED_GOOGLE_SUBJECTS=ash-atlas-dev:developer@example.com"
set "MARKET_GLOBAL_ACCESS=true"
set "REGION_CODE=GLOBAL"
call pnpm dev:server
"@
    Set-Content -LiteralPath $path -Value $content -Encoding ascii
    return $path
}

function Start-World {
    Assert-PortAvailable $script:WorldPort
    $pipelineSha = (& git -C $script:PipelineRoot rev-parse HEAD).Trim()
    $pipelineBranch = (& git -C $script:PipelineRoot branch --show-current).Trim()
    $arguments = @(
        '-m', 'map_world_pipeline', 'serve-world-release',
        '--release-root', ('"' + $script:ReleaseRoot + '"'),
        '--host', '127.0.0.1', '--port', [string]$script:WorldPort,
        '--runtime-branch', $pipelineBranch, '--runtime-sha', $pipelineSha
    )
    Start-TrackedProcess 'world-api' 'python' $arguments $script:PipelineRoot $script:ReleaseRoot
    $health = Wait-Http "http://127.0.0.1:$($script:WorldPort)/api/health"
    if (-not $health.ok) { throw 'World API started without ok health' }
    return $health
}

function Start-GameWriter([string]$Name = 'game-api', [int]$Port = 3100) {
    Assert-PortAvailable $Port
    $scriptPath = Write-GameRunScript $Name $Port
    Start-TrackedProcess $Name 'cmd.exe' @('/d', '/c', ('"' + $scriptPath + '"')) $script:GameRoot $scriptPath
    return Wait-Http "http://127.0.0.1:$Port/health"
}

function Start-Frontend {
    Assert-PortAvailable $script:FrontendPort
    $path = Join-Path $script:RunRoot 'frontend.cmd'
    $content = @"
@echo off
setlocal
cd /d "$($script:GameRoot)"
set "VITE_SERVER_HTTP_BASE=http://127.0.0.1:$($script:GamePort)"
set "VITE_SERVER_WS_BASE=ws://127.0.0.1:$($script:GamePort)"
set "VITE_WORLD_API_BASE=http://127.0.0.1:$($script:WorldPort)"
call pnpm dev:client --port $($script:FrontendPort) --strictPort
"@
    Set-Content -LiteralPath $path -Value $content -Encoding ascii
    Start-TrackedProcess 'frontend' 'cmd.exe' @('/d', '/c', ('"' + $path + '"')) $script:GameRoot $path
    Wait-Http "http://127.0.0.1:$($script:FrontendPort)" | Out-Null
}

function Stop-OwnedProcess([string]$Name) {
    $records = @(Get-OwnedProcesses)
    $remaining = @()
    foreach ($record in $records) {
        if ($record.name -ne $Name) {
            $remaining += $record
            continue
        }
        $process = Get-CimProcess ([int]$record.pid)
        if (-not $process) { continue }
        if (-not (Test-OwnedProcessRecord $record)) {
            throw "REFUSED: pid $($record.pid) for $Name no longer matches its owned command marker"
        }
        & taskkill.exe /PID ([int]$record.pid) /T /F *> $null
    }
    Save-OwnedProcesses $remaining
}

function Stop-AllOwnedProcesses {
    $records = @(Get-OwnedProcesses)
    foreach ($record in @($records | Sort-Object { if ($_.name -eq 'frontend') { 0 } elseif ($_.name -like 'game-*') { 1 } else { 2 } })) {
        Stop-OwnedProcess ([string]$record.name)
    }
}

function Get-ReleaseIdentity {
    $helper = Join-Path $script:PipelineRoot 'tools\stability-lab\release_fixture.py'
    $json = & python $helper inspect --source $script:ReleaseRoot
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect immutable world release identity' }
    return ($json -join "`n") | ConvertFrom-Json
}

function Write-IdentityBanner {
    $release = Get-ReleaseIdentity
    $identity = [ordered]@{
        game_sha = (& git -C $script:GameRoot rev-parse HEAD).Trim()
        game_branch = (& git -C $script:GameRoot branch --show-current).Trim()
        pipeline_sha = (& git -C $script:PipelineRoot rev-parse HEAD).Trim()
        pipeline_branch = (& git -C $script:PipelineRoot branch --show-current).Trim()
        release = $release
        runtime_identity = @{ game = 'tracked worktree SHA'; pipeline = 'locked protected SHA' }
        ports = @{
            frontend = $script:FrontendPort
            game = $script:GamePort
            world = $script:WorldPort
            postgres = $script:DatabasePort
            postgres_source = $script:DatabasePortSource
        }
        database = $script:DatabaseName
        test_root = $script:LabRoot
    }
    $identity | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $script:IdentityPath -Encoding utf8
    $identity | ConvertTo-Json -Depth 8
}

function Start-Lab {
    Assert-Roots
    Initialize-LabDirectories
    Write-IdentityBanner
    foreach ($port in @($script:FrontendPort, $script:GamePort, $script:WorldPort)) {
        Assert-PortAvailable $port
    }
    # Start-Database validates the exact named container and its ownership labels before accepting
    # an already-running database port. Windows reports Docker Desktop, not the container, as the
    # TCP listener owner, so the generic process-PID guard cannot safely classify this port.
    Start-Database
    Invoke-Migrations
    Invoke-Seed
    $world = Start-World
    $game = Start-GameWriter
    Start-Frontend
    [ordered]@{ ok = $true; world = $world; game = $game; frontend = "http://127.0.0.1:$($script:FrontendPort)" } | ConvertTo-Json -Depth 8
}

function Show-Status {
    Assert-Roots
    Initialize-LabDirectories
    $processes = foreach ($record in @(Get-OwnedProcesses)) {
        [ordered]@{ name = $record.name; pid = $record.pid; owned_and_running = (Test-OwnedProcessRecord $record); command = $record.command }
    }
    $container = Get-ContainerId
    $containerStatus = if ($container) {
        Assert-OwnedContainer $container
        (& docker inspect --format '{{.State.Status}}' $container).Trim()
    } else { 'absent' }
    [ordered]@{
        processes = @($processes)
        container = @{ name = $script:ContainerName; status = $containerStatus }
        database_url = $script:DatabaseUrl
        lab_root = $script:LabRoot
    } | ConvertTo-Json -Depth 8
}

function Invoke-Fault([string]$Kind) {
    if (-not $Kind) { throw 'fault requires one of the documented fault kinds' }
    switch ($Kind) {
        'queue-saturation' {
            & pnpm --dir $script:GameRoot --filter '@ash-atlas/server' exec vitest run `
                src/game/worldCommandQueue.test.ts `
                src/game/worldRuntime.test.ts `
                src/__tests__/websocket.test.ts `
                src/game/combat/rewardSettlement.test.ts `
                src/__tests__/resourceVisionJobs.test.ts `
                --no-file-parallelism --maxWorkers=1
            if ($LASTEXITCODE -ne 0) { throw 'Queue-saturation focused tests failed' }
        }
        'database-outage' {
            $container = Get-ContainerId
            Assert-OwnedContainer $container
            if (-not $container) { throw 'Isolated database is not running' }
            & docker stop $container | Out-Null
        }
        'world-api-outage' { Stop-OwnedProcess 'world-api' }
        'slow-request' {
            & python (Join-Path $script:PipelineRoot 'tools\stability-lab\runtime_probe.py') slow-body --port $script:WorldPort --clients 100
            if ($LASTEXITCODE -ne 0) { throw 'Slow-request probe failed' }
        }
        'crash-restart' {
            Stop-OwnedProcess 'game-api'
            Start-GameWriter | ConvertTo-Json -Depth 6
        }
        'two-writer' {
            Start-GameWriter 'game-writer-2' 3101 | ConvertTo-Json -Depth 6
        }
    }
}

function Invoke-SafetyTest {
    Initialize-LabDirectories
    Assert-Roots
    Assert-DatabaseUrl $script:DatabaseUrl
    $manifest = Join-Path $script:ReleaseRoot 'manifest.json'
    $beforeHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $manifest).Hash
    $retainedContainerBefore = (& docker inspect --format '{{.Id}}|{{.State.Status}}|{{.State.StartedAt}}' ash-atlas-postgis 2>$null)

    Stop-AllOwnedProcesses
    Remove-Database
    $unrelated = Start-Process python -ArgumentList @('-m', 'http.server', [string]$script:FrontendPort, '--bind', '127.0.0.1') `
        -WorkingDirectory $script:LabRoot -WindowStyle Hidden -PassThru
    try {
        Start-Sleep -Milliseconds 750
        $refused = $false
        try { Assert-PortAvailable $script:FrontendPort } catch { $refused = $_.Exception.Message -like 'REFUSED:*' }
        if (-not $refused -or $unrelated.HasExited) { throw 'Unrelated port-owner refusal test failed' }
    } finally {
        if (-not $unrelated.HasExited) { Stop-Process -Id $unrelated.Id -Force }
    }

    Start-Database
    Invoke-Migrations
    Invoke-Migrations
    Invoke-Seed
    $world = Start-World
    $game = Start-GameWriter
    if ($world.runtime.sha -ne (& git -C $script:PipelineRoot rev-parse HEAD).Trim()) {
        throw 'World runtime did not report the feature-worktree SHA'
    }
    $gameRuntime = $game.runtime
    if (-not $gameRuntime -or $gameRuntime.sha -ne (& git -C $script:GameRoot rev-parse HEAD).Trim()) {
        throw 'Game runtime did not report the feature-worktree SHA'
    }
    Stop-AllOwnedProcesses
    Remove-Database

    $afterHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $manifest).Hash
    if ($afterHash -ne $beforeHash) { throw 'Authoritative world release manifest changed during stability smoke test' }
    $retainedContainerAfter = (& docker inspect --format '{{.Id}}|{{.State.Status}}|{{.State.StartedAt}}' ash-atlas-postgis 2>$null)
    if (($retainedContainerBefore -join '') -ne ($retainedContainerAfter -join '')) {
        throw 'Retained ash-atlas-postgis container state changed during smoke test'
    }
    $leftovers = @(Get-OwnedProcesses | Where-Object { Test-OwnedProcessRecord $_ })
    if ($leftovers.Count -ne 0 -or (Get-ContainerId)) { throw 'Stability smoke cleanup left owned resources running' }
    [ordered]@{
        ok = $true
        retained_database_container_unchanged = $true
        retained_release_manifest_sha256 = $afterHash
        unrelated_port_owner_survived_refusal = $true
        migrations_idempotent = $true
        isolated_database_removed = $true
        world_runtime_sha = $world.runtime.sha
        game_runtime = $gameRuntime
        cleanup_empty = $true
    } | ConvertTo-Json -Depth 8
}

function Cleanup-Lab {
    Stop-AllOwnedProcesses
    Remove-Database
    if (Test-Path -LiteralPath $script:StatePath) { Remove-Item -LiteralPath $script:StatePath -Force }
    Get-ChildItem -LiteralPath $script:RunRoot -Filter '*.cmd' -ErrorAction SilentlyContinue | Remove-Item -Force
    if ($PurgeArtifacts) {
        if (-not $script:LabRoot.EndsWith('ash-atlas-stability-lab', [StringComparison]::OrdinalIgnoreCase)) {
            throw "REFUSED: unexpected cleanup root $($script:LabRoot)"
        }
        if (Test-Path -LiteralPath $script:ReleaseFixtureRoot) { Remove-Item -LiteralPath $script:ReleaseFixtureRoot -Recurse -Force }
    }
    [ordered]@{ ok = $true; logs_preserved = $script:LogRoot; artifacts_purged = [bool]$PurgeArtifacts } | ConvertTo-Json
}

Assert-CommandAvailable git
Assert-CommandAvailable docker
Assert-CommandAvailable python
Assert-CommandAvailable pnpm
Assert-Roots
Initialize-LabDirectories

switch ($Command) {
    'start' { Start-Lab }
    'stop' { Stop-AllOwnedProcesses; Show-Status }
    'status' { Show-Status }
    'reset' { Stop-AllOwnedProcesses; Remove-Database; Start-Database; Invoke-Migrations; Invoke-Seed; Show-Status }
    'migrate' { Invoke-Migrations }
    'seed' { Invoke-Seed }
    'test' { Invoke-SafetyTest }
    'fault' { Invoke-Fault $FaultKind }
    'cleanup' { Cleanup-Lab }
}
