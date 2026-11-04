Set-StrictMode -Version Latest

function ConvertTo-AshAtlasNativeArgument {
    param([AllowEmptyString()][Parameter(Mandatory = $true)][string]$Value)

    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
    $quoted = New-Object Text.StringBuilder
    [void]$quoted.Append('"')
    $backslashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') {
            $backslashes++
            continue
        }
        if ($character -eq '"') {
            [void]$quoted.Append(('\' * (($backslashes * 2) + 1)))
            [void]$quoted.Append('"')
            $backslashes = 0
            continue
        }
        if ($backslashes -gt 0) {
            [void]$quoted.Append(('\' * $backslashes))
            $backslashes = 0
        }
        [void]$quoted.Append($character)
    }
    if ($backslashes -gt 0) { [void]$quoted.Append(('\' * ($backslashes * 2))) }
    [void]$quoted.Append('"')
    return $quoted.ToString()
}

function Invoke-AshAtlasNative {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @(),
        [string]$WorkingDirectory = '',
        [hashtable]$Environment = @{},
        [ValidateRange(0, 86400)][int]$TimeoutSeconds = 0
    )

    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $FilePath
    $startInfo.Arguments = (@($Arguments | ForEach-Object { ConvertTo-AshAtlasNativeArgument ([string]$_) }) -join ' ')
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    if ($WorkingDirectory) { $startInfo.WorkingDirectory = $WorkingDirectory }
    foreach ($entry in $Environment.GetEnumerator()) {
        if ($null -eq $entry.Value) { [void]$startInfo.EnvironmentVariables.Remove([string]$entry.Key) }
        else { $startInfo.EnvironmentVariables[[string]$entry.Key] = [string]$entry.Value }
    }

    $process = New-Object Diagnostics.Process
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) { throw "Could not start native command '$FilePath'." }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if ($TimeoutSeconds -gt 0 -and -not $process.WaitForExit($TimeoutSeconds * 1000)) {
            try { $process.Kill() } catch { }
            $process.WaitForExit()
            throw "Native command '$FilePath' exceeded the $TimeoutSeconds-second timeout."
        }
        $process.WaitForExit()
        return [pscustomobject][ordered]@{
            ExitCode = [int]$process.ExitCode
            StdOut = [string]$stdout.Result
            StdErr = [string]$stderr.Result
        }
    } finally {
        $process.Dispose()
    }
}

function Get-AshAtlasObjectPropertyValue {
    param($Object, [Parameter(Mandatory = $true)][string]$Name, $Default = $null)
    if ($null -eq $Object) { return $Default }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $Default }
    return $property.Value
}

function Get-AshAtlasStableHash {
    param(
        [Parameter(Mandatory = $true)][string]$Value,
        [ValidateRange(6, 32)][int]$Length = 10
    )

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($Value.ToLowerInvariant())
        $hex = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
        return $hex.Substring(0, $Length)
    } finally {
        $sha.Dispose()
    }
}

function Get-AshAtlasFileSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [IO.File]::ReadAllBytes([IO.Path]::GetFullPath($Path))
        return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
}

function ConvertTo-AshAtlasSlug {
    param([Parameter(Mandatory = $true)][string]$Value, [int]$MaximumLength = 36)

    $slug = $Value.ToLowerInvariant() -replace '[^a-z0-9]+', '-'
    $slug = $slug.Trim('-')
    if (-not $slug) { $slug = 'runtime' }
    if ($slug.Length -gt $MaximumLength) { $slug = $slug.Substring(0, $MaximumLength).TrimEnd('-') }
    return $slug
}

function ConvertTo-AshAtlasDisplayName {
    param([Parameter(Mandatory = $true)][string]$DisplayName)

    $name = $DisplayName.Trim() -replace '[^A-Za-z0-9 ._-]', ''
    $name = ($name -replace '\s+', ' ').Trim().TrimEnd('.', ' ')
    if (-not $name) { throw 'DisplayName must contain a letter or number.' }
    if ($name.Length -gt 80) { $name = $name.Substring(0, 80).TrimEnd('.', ' ') }
    return $name
}

function ConvertTo-AshAtlasLauncherFileName {
    param(
        [Parameter(Mandatory = $true)][string]$DisplayName,
        [AllowEmptyString()][ValidateScript({ -not $_ -or $_ -match '^t\d{3,4}$' })][string]$BaseTestGeneration
    )

    $name = ConvertTo-AshAtlasDisplayName $DisplayName
    $suffix = if ($BaseTestGeneration) { " [$BaseTestGeneration]" } else { '' }
    return "Run $name$suffix.cmd"
}

function Get-AshAtlasFeatureLauncherPath {
    param(
        [Parameter(Mandatory = $true)][string]$LauncherRoot,
        [Parameter(Mandatory = $true)][string]$DisplayName,
        [AllowEmptyString()][ValidateScript({ -not $_ -or $_ -match '^t\d{3,4}$' })][string]$BaseTestGeneration
    )

    $directory = if ($BaseTestGeneration) { Join-Path $LauncherRoot 'Active' } else { $LauncherRoot }
    return Join-Path $directory (ConvertTo-AshAtlasLauncherFileName $DisplayName $BaseTestGeneration)
}

function Get-AshAtlasMergedLauncherPath {
    param(
        [Parameter(Mandatory = $true)][string]$LauncherRoot,
        [Parameter(Mandatory = $true)][string]$DisplayName,
        [Parameter(Mandatory = $true)][ValidatePattern('^t\d{3,4}$')][string]$BaseTestGeneration,
        [Parameter(Mandatory = $true)][ValidatePattern('^t\d{3,4}$')][string]$MergedTestGeneration
    )

    $name = ConvertTo-AshAtlasDisplayName $DisplayName
    return Join-Path (Join-Path $LauncherRoot 'Merged') "[MERGED] $name [$BaseTestGeneration to $MergedTestGeneration].cmd"
}

function New-AshAtlasMergedLauncherContent {
    param(
        [Parameter(Mandatory = $true)][string]$DisplayName,
        [Parameter(Mandatory = $true)][string]$Branch,
        [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$FeatureTipSha,
        [Parameter(Mandatory = $true)][ValidatePattern('^t\d{3,4}$')][string]$BaseTestGeneration,
        [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$BaseTestSha,
        [Parameter(Mandatory = $true)][ValidatePattern('^t\d{3,4}$')][string]$MergedTestGeneration,
        [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$MergedTestSha
    )

    $name = ConvertTo-AshAtlasDisplayName $DisplayName
    return (@(
        '@echo off',
        'echo This feature has already been accepted into Integration Test.',
        "echo Feature: $name",
        "echo Source branch: $Branch",
        "echo Feature tip SHA: $($FeatureTipSha.ToLowerInvariant())",
        "echo Base test generation: $BaseTestGeneration",
        "echo Base integration SHA: $($BaseTestSha.ToLowerInvariant())",
        "echo Merged test generation: $MergedTestGeneration",
        "echo Merged integration SHA: $($MergedTestSha.ToLowerInvariant())",
        'pause'
    ) -join "`r`n") + "`r`n"
}

function New-AshAtlasMergedMarkerContent {
    param(
        [Parameter(Mandatory = $true)][string]$DisplayName,
        [Parameter(Mandatory = $true)][string]$Branch,
        [Parameter(Mandatory = $true)][ValidatePattern('^t\d{3,4}$')][string]$BaseTestGeneration,
        [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$BaseTestSha,
        [Parameter(Mandatory = $true)][ValidatePattern('^t\d{3,4}$')][string]$MergedTestGeneration,
        [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$MergedTestSha,
        [Parameter(Mandatory = $true)][string]$MergedAtUtc
    )

    $name = ConvertTo-AshAtlasDisplayName $DisplayName
    return (@(
        '# Merged to Integration Test',
        '',
        "Feature: $name",
        "Branch: $Branch",
        "Started from generation: $BaseTestGeneration",
        "Base integration SHA: $($BaseTestSha.ToLowerInvariant())",
        "Included in generation: $MergedTestGeneration",
        "Resulting integration SHA: $($MergedTestSha.ToLowerInvariant())",
        "Merged at UTC: $MergedAtUtc"
    ) -join "`r`n") + "`r`n"
}

function New-AshAtlasFeatureLauncherContent {
    param(
        [Parameter(Mandatory = $true)]$Config,
        [Parameter(Mandatory = $true)]$Runtime,
        [Parameter(Mandatory = $true)][string]$DisplayName,
        [string]$SupervisorRoot = ''
    )

    if (-not (Test-AshAtlasSafeFeatureRuntime $Config $Runtime)) { throw 'Refused to generate a launcher for an unsafe feature runtime.' }
    if ($null -eq $Runtime.ports) { throw 'Feature ports must be assigned before generating a launcher.' }
    $supervisor = Join-Path ([string]$Config.permanent_checkout) 'tools\dev\run-main.ps1'
    $fallbackSupervisor = if ($SupervisorRoot) { Join-Path ([IO.Path]::GetFullPath($SupervisorRoot).TrimEnd('\')) 'tools\dev\run-main.ps1' } else { '' }
    $hasFallback = $fallbackSupervisor -and -not [string]::Equals($fallbackSupervisor, $supervisor, [StringComparison]::OrdinalIgnoreCase)
    $safeDisplayName = ConvertTo-AshAtlasDisplayName $DisplayName
    $lines = @(
        '@echo off',
        'setlocal',
        'rem Ash Atlas generated feature launcher',
        "rem Runtime ID: $($Runtime.runtime_id)",
        "rem Worktree: $($Runtime.worktree)",
        $(if (Get-AshAtlasObjectPropertyValue $Runtime 'base_test_generation' '') { "rem Base test generation: $($Runtime.base_test_generation)" } else { 'rem Legacy runtime without a generation label' }),
        $(if (Get-AshAtlasObjectPropertyValue $Runtime 'base_test_sha' '') { "rem Base integration SHA: $($Runtime.base_test_sha)" } else { 'rem Legacy runtime without a recorded base SHA' }),
        "title Ash Atlas - $safeDisplayName",
        "set `"ASH_ATLAS_WORKTREE=$($Runtime.worktree)`"",
        "set `"ASH_ATLAS_SUPERVISOR=$supervisor`"",
        $(if ($hasFallback) { "if exist `"$fallbackSupervisor`" set `"ASH_ATLAS_SUPERVISOR=$fallbackSupervisor`"" } else { 'rem Permanent supervisor is active' }),
        "echo Frontend port is assigned when this launcher starts. Preferred port: $($Runtime.ports.frontend).",
        $(if ($null -ne (Get-AshAtlasObjectPropertyValue $Runtime 'world_runtime' $null)) { "echo World API: http://127.0.0.1:$($Runtime.ports.world_api) ^(group $($Runtime.world_runtime.group_id)^)" } else { 'rem World API group will be assigned during registration' }),
        "echo Logs: %LOCALAPPDATA%\AshAtlas\runtimes\$($Runtime.runtime_id)\logs",
        'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ASH_ATLAS_SUPERVISOR%" -RuntimeMode Feature -WorktreePath "%ASH_ATLAS_WORKTREE%"',
        'set "ASH_ATLAS_EXIT=%ERRORLEVEL%"',
        'if not "%ASH_ATLAS_EXIT%"=="0" (',
        '  echo.',
        '  echo Ash Atlas feature startup failed with exit code %ASH_ATLAS_EXIT%.',
        '  pause',
        ')',
        'exit /b %ASH_ATLAS_EXIT%'
    )
    return ($lines -join "`r`n") + "`r`n"
}

function Test-AshAtlasGeneratedLauncher {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$RuntimeId,
        [Parameter(Mandatory = $true)][string]$LauncherRoot
    )

    $fullPath = [IO.Path]::GetFullPath($Path)
    $root = [IO.Path]::GetFullPath($LauncherRoot).TrimEnd('\')
    if (-not $fullPath.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { return $false }
    if ([IO.Path]::GetExtension($fullPath) -ne '.cmd' -or -not (Test-Path -LiteralPath $fullPath -PathType Leaf)) { return $false }
    $content = Get-Content -Raw -LiteralPath $fullPath
    return $content.Contains('rem Ash Atlas generated feature launcher') -and $content.Contains("rem Runtime ID: $RuntimeId")
}

function Read-AshAtlasRuntimeDefaults {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Runtime defaults are missing: $Path"
    }
    $config = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
    if ([int]$config.schema_version -ne 1) { throw "Unsupported runtime defaults schema: $($config.schema_version)" }
    if ([string]$config.main.database.name -ne 'ash_atlas_game') {
        throw 'Main runtime defaults must preserve database ash_atlas_game.'
    }
    if ($config.main.database.retained -ne $true) { throw 'Main PostgreSQL volume must be marked retained.' }
    if (-not ([string]$config.feature.database_prefix).StartsWith('ash_atlas_stability')) {
        throw 'Feature database prefix must begin with ash_atlas_stability.'
    }
    $mainPorts = @(
        [int]$config.main.ports.frontend,
        [int]$config.main.ports.backend,
        [int]$config.main.ports.world_api,
        [int]$config.main.ports.postgres
    )
    if (@($mainPorts | Select-Object -Unique).Count -ne $mainPorts.Count) {
        throw 'Main runtime ports contain duplicate assignments.'
    }
    $poolStart = [int]$config.feature.port_pool.start
    $poolEnd = [int]$config.feature.port_pool.end
    $portsPerRuntime = [int]$config.feature.port_pool.ports_per_runtime
    if ($poolStart -lt 1024 -or $poolEnd -ge 49152 -or $poolEnd -lt $poolStart -or $portsPerRuntime -ne 3) {
        throw 'Feature port pool must provide three ports per runtime between 1024 and 49151.'
    }
    $worldPoolStart = [int]$config.feature.world_api_group_port_pool.start
    $worldPoolEnd = [int]$config.feature.world_api_group_port_pool.end
    if ($worldPoolStart -lt 1024 -or $worldPoolEnd -ge 49152 -or $worldPoolEnd -lt $worldPoolStart) {
        throw 'Feature World API group port pool must stay between 1024 and 49151.'
    }
    if ($worldPoolStart -le $poolEnd -and $worldPoolEnd -ge $poolStart) {
        throw 'Feature World API group port pool overlaps the frontend/backend/PostgreSQL pool.'
    }
    foreach ($mainPort in $mainPorts) {
        if ($mainPort -ge $worldPoolStart -and $mainPort -le $worldPoolEnd) {
            throw 'Feature World API group port pool overlaps a protected Main port.'
        }
    }
    return $config
}

function Read-AshAtlasJsonArray {
    param([Parameter(Mandatory = $true)][string]$Path, [string]$Label = 'JSON array')

    try { $parsed = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json }
    catch { throw "Could not read $Label at $Path`: $($_.Exception.Message)" }
    foreach ($item in @($parsed)) { Write-Output $item }
}

function Remove-AshAtlasExpectedRuntimeStateFile {
    param(
        [Parameter(Mandatory = $true)][string]$RuntimeStateRoot,
        [Parameter(Mandatory = $true)][string]$Path
    )

    $root = [IO.Path]::GetFullPath($RuntimeStateRoot).TrimEnd('\')
    $fullPath = [IO.Path]::GetFullPath($Path)
    $expectedPaths = @(
        'owned-processes.json',
        'ready',
        'stop-requested',
        'supervisor.json'
    ) | ForEach-Object { Join-Path $root $_ }
    if (-not @($expectedPaths | Where-Object {
        [string]::Equals($_, $fullPath, [StringComparison]::OrdinalIgnoreCase)
    }).Count) {
        throw "REFUSED: '$fullPath' is not an expected runtime state file beneath '$root'."
    }
    if (Test-Path -LiteralPath $fullPath -PathType Container) {
        throw "REFUSED: expected runtime state file is a directory: $fullPath"
    }
    try {
        Microsoft.PowerShell.Management\Remove-Item -LiteralPath $fullPath -Force -ErrorAction Stop
    } catch [System.Management.Automation.ItemNotFoundException] {
        if (Test-Path -LiteralPath $fullPath) { throw }
    }
}

function Get-AshAtlasGitValue {
    param([Parameter(Mandatory = $true)][string]$Repository, [Parameter(Mandatory = $true)][string[]]$Arguments)

    $result = Invoke-AshAtlasNative git (@('-C', $Repository) + $Arguments)
    if ($result.ExitCode -ne 0) { throw "Git check failed in $Repository`: $($result.StdErr.Trim())" }
    return $result.StdOut.Trim()
}

function New-AshAtlasFeatureIdentity {
    param(
        [Parameter(Mandatory = $true)]$Config,
        [Parameter(Mandatory = $true)][string]$WorktreePath,
        [Parameter(Mandatory = $true)][string]$Branch,
        [ValidatePattern('^[0-9a-fA-F]{40}$')][string]$BaseTestSha
    )

    $root = [IO.Path]::GetFullPath($WorktreePath).TrimEnd('\')
    $featureRoot = [IO.Path]::GetFullPath([string]$Config.feature_worktree_root).TrimEnd('\')
    if (-not $root.StartsWith($featureRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Feature worktree must be beneath $featureRoot."
    }
    if ($Branch -eq [string]$Config.main.branch) { throw 'Feature runtime may not use the protected main branch.' }

    $worktreeName = Split-Path -Leaf $root
    $worktreeGeneration = if ($worktreeName -match '^([a-z0-9]+(?:-[a-z0-9]+)*)__((?:t)\d{3,4})$') {
        [pscustomobject]@{ slug = $Matches[1]; generation = $Matches[2] }
    } else { $null }
    $branchGeneration = if ($Branch -match '^(?:feature|fix|chore|audit|integration)/([a-z0-9]+(?:-[a-z0-9]+)*)--from-((?:t)\d{3,4})$') {
        [pscustomobject]@{ slug = $Matches[1]; generation = $Matches[2] }
    } else { $null }
    if (($null -eq $worktreeGeneration) -ne ($null -eq $branchGeneration)) {
        throw 'Generation-labeled features require matching <slug>__tNNN[N] worktree and <prefix>/<slug>--from-tNNN[N] branch names.'
    }
    if ($null -ne $worktreeGeneration -and
        ($worktreeGeneration.slug -cne $branchGeneration.slug -or $worktreeGeneration.generation -cne $branchGeneration.generation)) {
        throw 'Feature worktree and branch generation labels do not match.'
    }
    if ($null -ne $worktreeGeneration -and $worktreeGeneration.slug.Length -gt 26) {
        throw 'Generation-labeled feature slugs must be at most 26 characters to preserve safe database identities.'
    }
    if ($BaseTestSha -and $null -eq $worktreeGeneration) {
        throw 'BaseTestSha is valid only for a generation-labeled feature.'
    }
    if ($null -ne $worktreeGeneration -and -not $BaseTestSha) {
        $BaseTestSha = Get-AshAtlasGitValue $root @('rev-parse', "refs/tags/test/$($worktreeGeneration.generation)^{commit}")
        if ($BaseTestSha -notmatch '^[0-9a-f]{40}$') { throw 'Generation tag did not resolve to an exact commit.' }
        $head = Get-AshAtlasGitValue $root @('rev-parse', 'HEAD')
        $ancestor = Invoke-AshAtlasNative git @('-C', $root, 'merge-base', '--is-ancestor', $BaseTestSha, $head)
        if ($ancestor.ExitCode -ne 0) {
            throw "Feature HEAD does not descend from test/$($worktreeGeneration.generation) at $BaseTestSha."
        }
    }

    $hash = Get-AshAtlasStableHash "$root|$Branch" 10
    $slug = if ($null -ne $worktreeGeneration) { [string]$worktreeGeneration.slug } else { ConvertTo-AshAtlasSlug $Branch 30 }
    $prefix = [string]$Config.feature.resource_prefix
    $runtimeId = if ($null -ne $worktreeGeneration) { "$slug-$($worktreeGeneration.generation)-$hash" } else { "$slug-$hash" }
    $database = if ($null -ne $worktreeGeneration) {
        "$($Config.feature.database_prefix)_$($slug.Replace('-', '_'))_$($worktreeGeneration.generation)_$hash"
    } else { "$($Config.feature.database_prefix)_$hash" }
    if ($database -eq 'ash_atlas_game' -or -not $database.StartsWith('ash_atlas_stability')) {
        throw 'Feature runtime refused unsafe database identity.'
    }

    $identity = [pscustomobject][ordered]@{
        runtime_id = $runtimeId
        mode = 'Feature'
        worktree = $root
        branch = $Branch
        compose_project = "$prefix-$hash"
        postgres_container = "$prefix-postgres-$hash"
        network = "$prefix-net-$hash"
        volume = "$prefix-pg-$hash"
        database = $database
        database_user = [string]$Config.main.database.user
        database_password = [string]$Config.main.database.password
        ports = $null
    }
    if ($null -ne $worktreeGeneration) {
        Add-Member -InputObject $identity -NotePropertyName base_test_generation -NotePropertyValue ([string]$worktreeGeneration.generation)
        Add-Member -InputObject $identity -NotePropertyName base_test_sha -NotePropertyValue $BaseTestSha.ToLowerInvariant()
    }
    return $identity
}

function New-AshAtlasMainIdentity {
    param([Parameter(Mandatory = $true)]$Config)

    return [pscustomobject][ordered]@{
        runtime_id = [string]$Config.main.runtime_id
        mode = 'Main'
        worktree = [IO.Path]::GetFullPath([string]$Config.permanent_checkout).TrimEnd('\')
        branch = [string]$Config.main.branch
        compose_project = [string]$Config.main.compose_project
        postgres_container = [string]$Config.main.postgres_container
        network = [string]$Config.main.network
        volume = [string]$Config.main.database.volume
        database = [string]$Config.main.database.name
        database_user = [string]$Config.main.database.user
        database_password = [string]$Config.main.database.password
        ports = [pscustomobject][ordered]@{
            frontend = [int]$Config.main.ports.frontend
            backend = [int]$Config.main.ports.backend
            postgres = [int]$Config.main.ports.postgres
            world_api = [int]$Config.main.ports.world_api
        }
    }
}

function Test-AshAtlasPortExcluded {
    param([Parameter(Mandatory = $true)][int]$Port, [object[]]$ExcludedRanges = @())

    foreach ($range in @($ExcludedRanges)) {
        if ($Port -ge [int]$range.start -and $Port -le [int]$range.end) { return $true }
    }
    return $false
}

function ConvertFrom-AshAtlasExcludedPortOutput {
    param([string[]]$Lines)

    $ranges = @()
    foreach ($line in @($Lines)) {
        if ($line -match '^\s*(\d+)\s+(\d+)(?:\s+\*)?\s*$') {
            $ranges += [pscustomobject]@{ start = [int]$Matches[1]; end = [int]$Matches[2] }
        }
    }
    return $ranges
}

function Get-AshAtlasExcludedTcpRanges {
    $result = Invoke-AshAtlasNative netsh @('interface', 'ipv4', 'show', 'excludedportrange', 'protocol=tcp')
    if ($result.ExitCode -ne 0) { throw "Could not read Windows excluded TCP ranges: $($result.StdErr.Trim())" }
    return ConvertFrom-AshAtlasExcludedPortOutput @($result.StdOut -split '\r?\n')
}

function Get-AshAtlasListeningPorts {
    return @(
        Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
            ForEach-Object { [int]$_.LocalPort } |
            Select-Object -Unique
    )
}

function Get-AshAtlasDockerPortMappings {
    param([switch]$RequireAvailable)

    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        if ($RequireAvailable) { throw 'Docker is required to prove that no published port conflicts exist.' }
        return @()
    }
    $list = Invoke-AshAtlasNative docker @('ps', '-a', '--format', '{{.Names}}')
    if ($list.ExitCode -ne 0) {
        if ($RequireAvailable) { throw "Docker port inspection failed: $($list.StdErr.Trim())" }
        return @()
    }
    $names = @($list.StdOut -split '\r?\n')
    $mappings = @()
    foreach ($name in $names) {
        if (-not $name) { continue }
        $result = Invoke-AshAtlasNative docker @('inspect', $name)
        if ($result.ExitCode -ne 0) { continue }
        $inspection = @(($result.StdOut | ConvertFrom-Json))[0]
        $labels = $inspection.Config.Labels
        $runtimeId = [string](Get-AshAtlasObjectPropertyValue $labels 'com.ash-atlas.runtime-id' '')
        $project = [string](Get-AshAtlasObjectPropertyValue $labels 'com.docker.compose.project' '')
        $bindings = $inspection.HostConfig.PortBindings
        if ($null -eq $bindings) { continue }
        foreach ($property in @($bindings.PSObject.Properties)) {
            foreach ($binding in @($property.Value)) {
                if ($binding.HostPort) {
                    $mappings += [pscustomobject]@{
                        port = [int]$binding.HostPort
                        container = [string]$inspection.Name.TrimStart('/')
                        runtime_id = $runtimeId
                        compose_project = $project
                        running = [bool]$inspection.State.Running
                    }
                }
            }
        }
    }
    return $mappings
}

function Get-AshAtlasLeasePath {
    if ($env:ASH_ATLAS_DEV_RUNTIME_LEASE_PATH) {
        if ($env:ASH_ATLAS_RUNTIME_TEST_MODE -ne '1') { throw 'Runtime lease override is allowed only for isolated acceptance tests.' }
        return [IO.Path]::GetFullPath($env:ASH_ATLAS_DEV_RUNTIME_LEASE_PATH)
    }
    $local = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
    if (-not $local) { $local = $env:LOCALAPPDATA }
    if (-not $local) { throw 'LOCALAPPDATA is unavailable; runtime leases cannot be stored safely.' }
    return Join-Path $local 'AshAtlas\dev-runtimes.json'
}

function Enter-AshAtlasLeaseStoreMutex {
    $mutex = [Threading.Mutex]::new($false, 'Global\AshAtlas_DevRuntimeLeaseStore')
    $owned = $false
    try {
        try { $owned = $mutex.WaitOne([TimeSpan]::FromMinutes(2)) }
        catch [Threading.AbandonedMutexException] { $owned = $true }
        if (-not $owned) { throw 'Timed out waiting for the Ash Atlas runtime lease-store lock.' }
        return $mutex
    } catch {
        $mutex.Dispose()
        throw
    }
}

function Exit-AshAtlasLeaseStoreMutex {
    param([Parameter(Mandatory = $true)]$Mutex)
    $Mutex.ReleaseMutex() | Out-Null
    $Mutex.Dispose()
}

function Get-AshAtlasRecordedProcessStatus {
    param([Parameter(Mandatory = $true)]$Record)

    $process = Get-Process -Id ([int]$Record.pid) -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        return [pscustomobject]@{ status = 'missing'; process = $null; actual_start_time_utc = '' }
    }
    try { $actualStart = $process.StartTime.ToUniversalTime().ToString('o') }
    catch { return [pscustomobject]@{ status = 'missing'; process = $null; actual_start_time_utc = '' } }
    if ($actualStart -ne (ConvertTo-AshAtlasCanonicalUtcTimestamp $Record.start_time_utc)) {
        return [pscustomobject]@{ status = 'reused'; process = $process; actual_start_time_utc = $actualStart }
    }
    return [pscustomobject]@{ status = 'match'; process = $process; actual_start_time_utc = $actualStart }
}

function ConvertTo-AshAtlasCanonicalUtcTimestamp {
    param($Value)

    if ($null -eq $Value) { return '' }
    if ($Value -is [DateTime]) {
        return ([DateTime]$Value).ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture)
    }
    if ($Value -is [DateTimeOffset]) {
        return ([DateTimeOffset]$Value).UtcDateTime.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
    }
    $text = [string]$Value
    $parsed = [DateTimeOffset]::MinValue
    if ([DateTimeOffset]::TryParseExact(
        $text,
        'o',
        [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::RoundtripKind,
        [ref]$parsed
    )) {
        return $parsed.UtcDateTime.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
    }
    return $text
}

function ConvertTo-AshAtlasStrictUtcTimestamp {
    param($Value)

    if ($null -eq $Value) { return $null }
    $parsed = [DateTimeOffset]::MinValue
    if ($Value -is [DateTime]) {
        $date = [DateTime]$Value
        if ($date.Kind -ne [DateTimeKind]::Utc) { return $null }
        $parsed = [DateTimeOffset]::new($date)
    } elseif ($Value -is [DateTimeOffset]) {
        $dateOffset = [DateTimeOffset]$Value
        if ($dateOffset.Offset -ne [TimeSpan]::Zero) { return $null }
        $parsed = $dateOffset
    } else {
        $text = [string]$Value
        if ($text -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$') { return $null }
        $styles = [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
        if (-not [DateTimeOffset]::TryParseExact(
            $text,
            "yyyy-MM-dd'T'HH:mm:ss.FFFFFFF'Z'",
            [Globalization.CultureInfo]::InvariantCulture,
            $styles,
            [ref]$parsed
        )) { return $null }
    }
    return $parsed.UtcDateTime.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
}

function Test-AshAtlasUtcTimestampEquivalent {
    param($Left, $Right)

    $leftCanonical = ConvertTo-AshAtlasStrictUtcTimestamp $Left
    $rightCanonical = ConvertTo-AshAtlasStrictUtcTimestamp $Right
    return $null -ne $leftCanonical -and
        $null -ne $rightCanonical -and
        [string]::Equals($leftCanonical, $rightCanonical, [StringComparison]::Ordinal)
}

function Assert-AshAtlasRecordedProcessIdentity {
    param([Parameter(Mandatory = $true)]$Record, [string]$Label = 'recorded process')

    $result = Get-AshAtlasRecordedProcessStatus $Record
    if ($result.status -eq 'reused') {
        throw "REFUSED: PID $($Record.pid) for $Label was reused. Recorded start '$($Record.start_time_utc)', actual '$($result.actual_start_time_utc)'."
    }
    return $result
}

function New-AshAtlasFeaturePortClaim {
    param([Parameter(Mandatory = $true)]$Runtime)

    $process = Get-Process -Id $PID -ErrorAction Stop
    return [pscustomobject][ordered]@{
        runtime_id = [string]$Runtime.runtime_id
        worktree = [string]$Runtime.worktree
        pid = [int]$PID
        start_time_utc = $process.StartTime.ToUniversalTime().ToString('o')
    }
}

function Test-AshAtlasFeaturePortClaimActive {
    param([Parameter(Mandatory = $true)]$Lease)

    $claim = Get-AshAtlasObjectPropertyValue $Lease 'port_claim' $null
    if ($null -eq $claim -or
        [string]$claim.runtime_id -ne [string]$Lease.runtime_id -or
        -not [string]::Equals([string]$claim.worktree, [string]$Lease.worktree, [StringComparison]::OrdinalIgnoreCase)) {
        return $false
    }
    return (Get-AshAtlasRecordedProcessStatus $claim).status -eq 'match'
}

function Get-AshAtlasPortBlockingLeases {
    param([object[]]$Leases = @(), [string[]]$ActiveRuntimeIds = @())

    return @($Leases | Where-Object {
        $lease = $_
        ($ActiveRuntimeIds -contains [string]$lease.runtime_id) -or
            (Test-AshAtlasFeaturePortClaimActive $lease)
    })
}

function Enter-AshAtlasRuntimeLifecycleMutex {
    param(
        [Parameter(Mandatory = $true)][string]$RuntimeId,
        [int]$TimeoutSeconds = 45,
        [int]$PollMilliseconds = 250,
        [scriptblock]$OnWait
    )

    $hash = Get-AshAtlasStableHash $RuntimeId 12
    $name = "Global\AshAtlas_DevRuntime_$hash"
    $mutex = [Threading.Mutex]::new($false, $name)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    try {
        while ($true) {
            try {
                if ($mutex.WaitOne(0)) {
                    return [pscustomobject]@{ mutex = $mutex; name = $name; owned = $true; abandoned = $false }
                }
            } catch [Threading.AbandonedMutexException] {
                return [pscustomobject]@{ mutex = $mutex; name = $name; owned = $true; abandoned = $true }
            }
            if ((Get-Date) -ge $deadline) {
                throw "Timed out after $TimeoutSeconds seconds waiting for runtime $RuntimeId to finish shutdown and release lifecycle lock $name."
            }
            if ($null -ne $OnWait) { & $OnWait }
            Start-Sleep -Milliseconds $PollMilliseconds
        }
    } catch {
        $mutex.Dispose()
        throw
    }
}

function Exit-AshAtlasRuntimeLifecycleMutex {
    param([Parameter(Mandatory = $true)]$Handle)

    if ([bool]$Handle.owned) {
        $Handle.mutex.ReleaseMutex() | Out-Null
        $Handle.owned = $false
    }
    $Handle.mutex.Dispose()
}

function Wait-AshAtlasBoundedCondition {
    param(
        [Parameter(Mandatory = $true)][scriptblock]$Condition,
        [int]$TimeoutSeconds = 30,
        [int]$PollMilliseconds = 250,
        [string]$TimeoutMessage = 'Timed out waiting for Ash Atlas runtime state.'
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (& $Condition) { return }
        Start-Sleep -Milliseconds $PollMilliseconds
    }
    if (& $Condition) { return }
    throw $TimeoutMessage
}

function Open-AshAtlasRuntimeFrontend {
    param([Parameter(Mandatory = $true)][string]$Url, [switch]$NoBrowser, [scriptblock]$OpenAction)

    if ($NoBrowser) { return $false }
    if ($null -ne $OpenAction) { & $OpenAction $Url }
    else { Start-Process $Url | Out-Null }
    return $true
}

function Read-AshAtlasLeaseStore {
    param([string]$Path = (Get-AshAtlasLeasePath))

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return [pscustomobject][ordered]@{ schema_version = 2; runtimes = @() }
    }
    $store = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
    if ([int]$store.schema_version -notin @(1, 2)) { throw "Unsupported runtime lease schema in $Path." }
    return [pscustomobject][ordered]@{ schema_version = 2; runtimes = @($store.runtimes) }
}

function Write-AshAtlasLeaseStore {
    param([Parameter(Mandatory = $true)]$Store, [string]$Path = (Get-AshAtlasLeasePath))

    $directory = Split-Path -Parent $Path
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $temporary = "$Path.$PID.tmp"
    try {
        $Store | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temporary -Encoding utf8
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Get-AshAtlasStaleLeases {
    param(
        [object[]]$Leases = @(),
        [string[]]$ExistingWorktrees = @(),
        [string[]]$ActiveRuntimeIds = @()
    )

    return @($Leases | Where-Object {
        $lease = $_
        -not ($ExistingWorktrees | Where-Object {
            [string]::Equals([IO.Path]::GetFullPath($_).TrimEnd('\'), [IO.Path]::GetFullPath([string]$lease.worktree).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
        }) -and -not ($ActiveRuntimeIds -contains [string]$lease.runtime_id)
    })
}

function Remove-AshAtlasStaleLeasesFromStore {
    param([Parameter(Mandatory = $true)]$Store, [object[]]$StaleLeases = @())

    $staleIds = @($StaleLeases | ForEach-Object { [string]$_.runtime_id })
    if ($staleIds.Count -gt 0) {
        $Store.runtimes = @($Store.runtimes | Where-Object { $staleIds -notcontains [string]$_.runtime_id })
    }
    return $Store
}

function Assert-AshAtlasPortSetAvailable {
    param(
        [Parameter(Mandatory = $true)]$Ports,
        [object[]]$ExcludedRanges = @(),
        [int[]]$ListeningPorts = @(),
        [object[]]$DockerMappings = @(),
        [object[]]$Leases = @(),
        [string]$CurrentRuntimeId = ''
    )

    $values = @([int]$Ports.frontend, [int]$Ports.backend, [int]$Ports.postgres)
    if (@($values | Select-Object -Unique).Count -ne 3) { throw 'Runtime proposes duplicate port assignments.' }
    $otherLeasePorts = @($Leases | Where-Object { [string]$_.runtime_id -ne $CurrentRuntimeId } | ForEach-Object {
        [int]$_.ports.frontend; [int]$_.ports.backend; [int]$_.ports.postgres
    })
    foreach ($port in $values) {
        if (Test-AshAtlasPortExcluded $port $ExcludedRanges) { throw "Port $port is in a Windows excluded TCP range." }
        $ownDocker = @($DockerMappings | Where-Object { [int]$_.port -eq $port -and [string]$_.runtime_id -eq $CurrentRuntimeId })
        if (($ListeningPorts -contains $port) -and $ownDocker.Count -eq 0) { throw "Port $port has an active TCP listener." }
        $foreignDocker = @($DockerMappings | Where-Object { [int]$_.port -eq $port -and [string]$_.runtime_id -ne $CurrentRuntimeId })
        if ($foreignDocker.Count -gt 0) { throw "Port $port is published by Docker container $($foreignDocker[0].container)." }
        if ($otherLeasePorts -contains $port) { throw "Port $port is already assigned to another Ash Atlas runtime lease." }
    }
}

function Select-AshAtlasFeaturePorts {
    param(
        [Parameter(Mandatory = $true)]$Config,
        [Parameter(Mandatory = $true)][string]$RuntimeId,
        [object[]]$ExcludedRanges = @(),
        [int[]]$ListeningPorts = @(),
        [object[]]$DockerMappings = @(),
        [object[]]$Leases = @(),
        $ExistingPorts = $null
    )

    if ($null -ne $ExistingPorts) {
        try {
            Assert-AshAtlasPortSetAvailable $ExistingPorts $ExcludedRanges $ListeningPorts $DockerMappings $Leases $RuntimeId
            return $ExistingPorts
        } catch {
            # A formerly available port can become reserved or occupied; scan for a safe replacement.
        }
    }

    $start = [int]$Config.feature.port_pool.start
    $end = [int]$Config.feature.port_pool.end
    $width = [int]$Config.feature.port_pool.ports_per_runtime
    $slots = [Math]::Floor(($end - $start + 1) / $width)
    $seedHex = Get-AshAtlasStableHash $RuntimeId 8
    $seed = [Convert]::ToUInt32($seedHex, 16)
    $firstSlot = [int]($seed % $slots)
    $failures = @()
    for ($offset = 0; $offset -lt $slots; $offset++) {
        $slot = ($firstSlot + $offset) % $slots
        $base = $start + ($slot * $width)
        $ports = [pscustomobject][ordered]@{ frontend = $base; backend = $base + 1; postgres = $base + 2; world_api = 0 }
        try {
            Assert-AshAtlasPortSetAvailable $ports $ExcludedRanges $ListeningPorts $DockerMappings $Leases $RuntimeId
            return $ports
        } catch {
            if ($failures.Count -lt 3) { $failures += $_.Exception.Message }
        }
    }
    throw "No safe Ash Atlas feature ports remain in $start-$end. Sample conflicts: $($failures -join '; ')"
}

function Set-AshAtlasLease {
    param([Parameter(Mandatory = $true)]$Store, [Parameter(Mandatory = $true)]$Runtime)

    $record = [pscustomobject][ordered]@{
        runtime_id = [string]$Runtime.runtime_id
        worktree = [string]$Runtime.worktree
        branch = [string]$Runtime.branch
        ports = $Runtime.ports
        database = [string]$Runtime.database
        compose_project = [string]$Runtime.compose_project
        postgres_container = [string]$Runtime.postgres_container
        network = [string]$Runtime.network
        volume = [string]$Runtime.volume
        display_name = [string](Get-AshAtlasObjectPropertyValue $Runtime 'display_name' '')
        launcher_path = [string](Get-AshAtlasObjectPropertyValue $Runtime 'launcher_path' '')
        world_runtime = Get-AshAtlasObjectPropertyValue $Runtime 'world_runtime' $null
        updated_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    }
    $baseGeneration = [string](Get-AshAtlasObjectPropertyValue $Runtime 'base_test_generation' '')
    $baseSha = [string](Get-AshAtlasObjectPropertyValue $Runtime 'base_test_sha' '')
    if ($baseGeneration) {
        Add-Member -InputObject $record -NotePropertyName base_test_generation -NotePropertyValue $baseGeneration
        Add-Member -InputObject $record -NotePropertyName base_test_sha -NotePropertyValue $baseSha
    }
    $portClaim = Get-AshAtlasObjectPropertyValue $Runtime 'port_claim' $null
    if ($null -ne $portClaim) {
        Add-Member -InputObject $record -NotePropertyName port_claim -NotePropertyValue $portClaim
    }
    $integrationStatus = [string](Get-AshAtlasObjectPropertyValue $Runtime 'integration_status' '')
    if ($integrationStatus) {
        Add-Member -InputObject $record -NotePropertyName integration_status -NotePropertyValue $integrationStatus
        Add-Member -InputObject $record -NotePropertyName merged_test_generation -NotePropertyValue ([string](Get-AshAtlasObjectPropertyValue $Runtime 'merged_test_generation' ''))
        Add-Member -InputObject $record -NotePropertyName merged_test_sha -NotePropertyValue ([string](Get-AshAtlasObjectPropertyValue $Runtime 'merged_test_sha' ''))
        Add-Member -InputObject $record -NotePropertyName merged_at_utc -NotePropertyValue ([string](Get-AshAtlasObjectPropertyValue $Runtime 'merged_at_utc' ''))
        Add-Member -InputObject $record -NotePropertyName merged_launcher_path -NotePropertyValue ([string](Get-AshAtlasObjectPropertyValue $Runtime 'merged_launcher_path' ''))
    }
    $remaining = @($Store.runtimes | Where-Object { [string]$_.runtime_id -ne [string]$Runtime.runtime_id })
    $Store.runtimes = @($remaining + $record)
    return $Store
}

function New-AshAtlasComposeEnvironment {
    param([Parameter(Mandatory = $true)]$Config, [Parameter(Mandatory = $true)]$Runtime)

    return [ordered]@{
        ASH_ATLAS_COMPOSE_PROJECT = [string]$Runtime.compose_project
        ASH_ATLAS_POSTGRES_CONTAINER = [string]$Runtime.postgres_container
        ASH_ATLAS_POSTGRES_PORT = [string]$Runtime.ports.postgres
        ASH_ATLAS_DATABASE_NAME = [string]$Runtime.database
        ASH_ATLAS_DATABASE_USER = [string]$Runtime.database_user
        ASH_ATLAS_DATABASE_PASSWORD = [string]$Runtime.database_password
        ASH_ATLAS_POSTGRES_VOLUME = [string]$Runtime.volume
        ASH_ATLAS_NETWORK_NAME = [string]$Runtime.network
        ASH_ATLAS_RUNTIME_ID = [string]$Runtime.runtime_id
        ASH_ATLAS_RUNTIME_MODE = ([string]$Runtime.mode).ToLowerInvariant()
        ASH_ATLAS_RUNTIME_WORKTREE = [string]$Runtime.worktree
        ASH_ATLAS_DATABASE_DISPOSITION = $(if ([string]$Runtime.mode -eq 'Main') { 'retained' } else { 'disposable' })
        ASH_ATLAS_OWNER_LABEL = [string]$Config.owner_label
    }
}

function Test-AshAtlasSafeFeatureRuntime {
    param(
        [Parameter(Mandatory = $true)]$Config,
        [Parameter(Mandatory = $true)]$Runtime
    )

    return (
        [string]$Runtime.mode -eq 'Feature' -and
        [string]$Runtime.database -ne [string]$Config.main.database.name -and
        ([string]$Runtime.database).StartsWith(([string]$Config.feature.database_prefix + '_')) -and
        [string]$Runtime.runtime_id -ne [string]$Config.main.runtime_id -and
        [string]$Runtime.postgres_container -ne [string]$Config.main.postgres_container -and
        [string]$Runtime.volume -ne [string]$Config.main.database.volume -and
        [string]$Runtime.compose_project -ne [string]$Config.main.compose_project -and
        [string]$Runtime.network -ne [string]$Config.main.network -and
        -not [string]::Equals(
            [IO.Path]::GetFullPath([string]$Runtime.worktree).TrimEnd('\'),
            [IO.Path]::GetFullPath([string]$Config.permanent_checkout).TrimEnd('\'),
            [StringComparison]::OrdinalIgnoreCase
        )
    )
}

function Clear-AshAtlasInheritedFeatureDatabaseEnvironment {
    param([Parameter(Mandatory = $true)]$Runtime)
    if ([string]$Runtime.mode -ne 'Feature') { return }
    Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
}

. (Join-Path $PSScriptRoot 'world-runtime-groups.ps1')
