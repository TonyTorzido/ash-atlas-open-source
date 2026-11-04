[CmdletBinding()]
param(
    [Parameter(Position = 0, Mandatory = $true)]
    [ValidateSet('start', 'stop', 'rebuild', 'status', 'watch')]
    [string]$Operation,
    [Parameter(Mandatory = $true)][string]$WorktreePath,
    # Skip the Tailscale https step (local preview only).
    [switch]$NoTailscale,
    # watch: quiet period after the last file change before rebuilding.
    [ValidateRange(1, 120)][int]$DebounceSeconds = 3
)

# Opt-in "fast phone test" for a running feature runtime: a production build served by
# `vite preview` (about 60 fps on a phone versus about 30 in dev mode) behind `tailscale serve`
# on a secure https link, so phone GPS works. It never changes how the launchers or
# feature-runtime.ps1 behave. The runtime keeps running its normal dev frontend untouched; the
# only change to it is that its backend is restarted once with the preview's loopback origins and
# the Tailscale https origin added to AUTH_ALLOWED_ORIGINS, plus that https origin in
# AUTH_DEV_EXTRA_ORIGINS (the server's explicit opt-in that lets an exact *.ts.net https origin
# coexist with development login).
# See DEV_WORKTREES.md, "Fast phone test".

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'runtime-lib.ps1')

$LeasePath = Get-AshAtlasLeasePath
$LeaseRoot = Split-Path -Parent $LeasePath

function Resolve-Lease([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $store = Read-AshAtlasLeaseStore $LeasePath
    $found = @($store.runtimes | Where-Object {
        [string]::Equals([IO.Path]::GetFullPath([string]$_.worktree).TrimEnd('\'), $full, [StringComparison]::OrdinalIgnoreCase)
    })
    if ($found.Count -ne 1) { throw "No single registered feature runtime for $full. Start the runtime first (feature-runtime.ps1 create, then its Active launcher)." }
    return $found[0]
}

$Lease = Resolve-Lease $WorktreePath
$RuntimeId = [string]$Lease.runtime_id
$Worktree = [IO.Path]::GetFullPath([string]$Lease.worktree).TrimEnd('\')
$FrontendPort = [int]$Lease.ports.frontend
$BackendPort = [int]$Lease.ports.backend
$RuntimeRoot = Join-Path $LeaseRoot "runtimes\$RuntimeId"
$OwnedPath = Join-Path $RuntimeRoot 'owned-processes.json'
$RuntimeLogs = Join-Path $RuntimeRoot 'logs'
$FastRoot = Join-Path $LeaseRoot "fast-phone\$RuntimeId"
$StatePath = Join-Path $FastRoot 'fast.json'
$DistPath = Join-Path $FastRoot 'dist'
$DistNext = Join-Path $FastRoot 'dist-next'
$ClientRoot = Join-Path $Worktree 'apps\client'
$ViteJs = Join-Path $ClientRoot 'node_modules\vite\bin\vite.js'

# ---------- helpers ----------

function Get-ProcessCommandLine([int]$ProcessId) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    if ($null -eq $p) { return '' }
    return [string]$p.CommandLine
}

function Stop-Tree([int]$ProcessId) {
    foreach ($child in @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $ProcessId" -ErrorAction SilentlyContinue)) {
        Stop-Tree ([int]$child.ProcessId)
    }
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

function Test-PortListening([int]$Port) {
    return @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).Count -gt 0
}

function Wait-Until([scriptblock]$Condition, [int]$TimeoutSeconds, [string]$Message) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (& $Condition) { return }
        Start-Sleep -Milliseconds 400
    }
    throw $Message
}

function Read-State {
    if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) { return $null }
    return Get-Content -Raw -LiteralPath $StatePath | ConvertFrom-Json
}

function Write-State($State) {
    New-Item -ItemType Directory -Path $FastRoot -Force | Out-Null
    [IO.File]::WriteAllText($StatePath, ($State | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
}

function Get-StateValue($State, [string]$Name, $Default) {
    if ($null -ne $State -and $State.PSObject.Properties.Name -contains $Name) { return $State.$Name }
    return $Default
}

# The launcher bakes every env var into its backend and frontend wrapper command lines
# ("$env:NAME = 'value'" lines), which makes the live wrapper the exact source of the runtime env.
function Get-WrapperScript([string]$Role) {
    $marker = "Ash Atlas $RuntimeId $Role'"
    $found = @(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine.Contains($marker) -and $_.CommandLine.Contains('$env:') })
    if ($found.Count -eq 0) { return $null }
    $match = $found[0]
    $text = [string]$match.CommandLine
    $start = $text.IndexOf('$Host.UI.RawUI.WindowTitle')
    if ($start -lt 0) { return $null }
    return [pscustomobject]@{ pid = [int]$match.ProcessId; text = $text.Substring($start) }
}

function ConvertFrom-EnvLines([string]$Text) {
    $map = [ordered]@{}
    foreach ($m in [regex]::Matches($Text, "(?m)^\`$env:([A-Za-z0-9_]+) = '((?:[^']|'')*)'\s*$")) {
        $map[$m.Groups[1].Value] = $m.Groups[2].Value.Replace("''", "'")
    }
    return $map
}

function Get-FrontendEnv {
    $wrapper = Get-WrapperScript 'Frontend'
    if ($null -eq $wrapper) { throw "The runtime's Frontend wrapper is not running. Start the runtime from its launcher first." }
    $map = ConvertFrom-EnvLines $wrapper.text
    foreach ($required in @('ASH_ATLAS_FRONTEND_PORT', 'ASH_ATLAS_GAME_SERVER_TARGET', 'ASH_ATLAS_WORLD_API_TARGET')) {
        if (-not $map.Contains($required)) { throw "Frontend wrapper has no $required; refusing to guess the runtime env." }
    }
    if ([int]$map['ASH_ATLAS_FRONTEND_PORT'] -ne $FrontendPort) { throw "Frontend wrapper port $($map['ASH_ATLAS_FRONTEND_PORT']) does not match the lease ($FrontendPort)." }
    return $map
}

function Quote-Ps([string]$Value) { return "'" + $Value.Replace("'", "''") + "'" }

function Get-PassthroughEnvLines {
    # Win32_Process.Create does not hand the child this shell's user environment.
    $lines = @()
    foreach ($name in @('Path', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'HOMEDRIVE', 'HOMEPATH')) {
        $value = [Environment]::GetEnvironmentVariable($name, 'Process')
        if ($value) { $lines += "`$env:$name = $(Quote-Ps $value)" }
    }
    return $lines
}

function Start-Detached([string]$ScriptPath, [string]$OutLog, [string]$ErrLog, [string]$WorkingDirectory) {
    $powerShell = (Get-Command powershell.exe).Source
    $inner = "`"$powerShell`" -NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`" < NUL >> `"$OutLog`" 2>> `"$ErrLog`""
    $command = "cmd.exe /d /s /c `"$inner`""
    $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $command; CurrentDirectory = $WorkingDirectory }
    if ($result.ReturnValue -ne 0) { throw "Win32_Process Create failed with code $($result.ReturnValue)." }
    return [int]$result.ProcessId
}

function Get-ProcessRecord([int]$ProcessId) {
    $proc = Get-Process -Id $ProcessId -ErrorAction Stop
    return [ordered]@{
        pid = $proc.Id
        start_time_utc = $proc.StartTime.ToUniversalTime().ToString('o')
        worktree = $Worktree
        runtime_id = $RuntimeId
        launcher_pid = 0
    }
}

# The runtime's own stop/cleanup kills only what is in owned-processes.json (and refuses cleanup
# while unowned processes reference the worktree). Keep our detached processes in that file so a
# normal runtime stop also stops them.
function Update-OwnedRecords([int[]]$RemovePids, $AddRecords) {
    if (-not (Test-Path -LiteralPath $OwnedPath -PathType Leaf)) { return }
    $records = @(Read-AshAtlasJsonArray $OwnedPath 'runtime process state')
    $launcher = if ($records.Count -gt 0) { $records[0].launcher_pid } else { 0 }
    $kept = @($records | Where-Object { $RemovePids -notcontains [int]$_.pid })
    foreach ($add in @($AddRecords)) {
        if ($null -eq $add) { continue }
        $add['launcher_pid'] = $launcher
        $kept += [pscustomobject]$add
    }
    $json = ConvertTo-Json -InputObject @($kept) -Depth 4
    [IO.File]::WriteAllText($OwnedPath, $json, (New-Object Text.UTF8Encoding($true)))
}

function Get-TailscaleExe {
    $cmd = Get-Command tailscale.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $default = 'C:\Program Files\Tailscale\tailscale.exe'
    if (Test-Path -LiteralPath $default) { return $default }
    throw 'tailscale.exe was not found on PATH or in C:\Program Files\Tailscale.'
}

function Get-TailnetHost {
    $json = (& (Get-TailscaleExe) status --json) -join "`n" | ConvertFrom-Json
    $dns = [string]$json.Self.DNSName
    if (-not $dns) { throw 'Tailscale reports no DNS name for this machine (is MagicDNS enabled?).' }
    return $dns.TrimEnd('.')
}

function Find-FreePort([int]$Preferred) {
    $port = $Preferred
    while (Test-PortListening $port) { $port++ }
    return $port
}

# ---------- build ----------

function Invoke-FastBuild($FrontendEnv) {
    if (-not (Test-Path -LiteralPath $ViteJs -PathType Leaf)) { throw "Vite is not installed for this worktree: $ViteJs" }
    New-Item -ItemType Directory -Path $FastRoot -Force | Out-Null
    $log = Join-Path $FastRoot 'build.log'
    $node = (Get-Command node.exe).Source
    $previous = @{}
    $started = Get-Date
    try {
        foreach ($entry in $FrontendEnv.GetEnumerator()) {
            $previous[$entry.Key] = [Environment]::GetEnvironmentVariable($entry.Key, 'Process')
            [Environment]::SetEnvironmentVariable($entry.Key, [string]$entry.Value, 'Process')
        }
        $arguments = @("`"$ViteJs`"", 'build', '--outDir', "`"$DistNext`"", '--emptyOutDir', '--configLoader', 'runner')
        $process = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $ClientRoot -Wait -PassThru -NoNewWindow `
            -RedirectStandardOutput $log -RedirectStandardError "$log.err"
    } finally {
        foreach ($entry in $previous.GetEnumerator()) { [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process') }
    }
    if ($process.ExitCode -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $DistNext 'index.html'))) {
        Write-Host (Get-Content -LiteralPath "$log.err" -Tail 25 -ErrorAction SilentlyContinue | Out-String)
        throw "vite build failed (exit $($process.ExitCode)); see $log"
    }
    # Swap into the served folder in place (preview reads files per request, so no restart).
    New-Item -ItemType Directory -Path $DistPath -Force | Out-Null
    & robocopy.exe $DistNext $DistPath /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed publishing the build (exit $LASTEXITCODE)." }
    $global:LASTEXITCODE = 0
    Write-Host ("Built in {0:N1}s -> {1}" -f ((Get-Date) - $started).TotalSeconds, $DistPath) -ForegroundColor Green
}

# ---------- backend origins ----------

function Get-BackendScriptText($State) {
    $ownScript = [string](Get-StateValue $State 'backend_script' '')
    $ownPid = [int](Get-StateValue $State 'backend_root_pid' 0)
    if ($ownScript -and $ownPid -gt 0 -and (Get-Process -Id $ownPid -ErrorAction SilentlyContinue) -and (Test-Path -LiteralPath $ownScript)) {
        return [pscustomobject]@{ text = (Get-Content -Raw -LiteralPath $ownScript); rootPid = $ownPid; ours = $true }
    }
    $wrapper = Get-WrapperScript 'Backend'
    if ($null -eq $wrapper) { throw "The runtime's Backend wrapper is not running. Start the runtime from its launcher first." }
    return [pscustomobject]@{ text = $wrapper.text; rootPid = $wrapper.pid; ours = $false }
}

function Test-BackendReady {
    try { return (Invoke-WebRequest -Uri "http://127.0.0.1:$BackendPort/ready" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 } catch { return $false }
}

function Wait-BackendReady([int]$TimeoutSeconds) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-BackendReady) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

# Replace the backend with one that has the given AUTH_ALLOWED_ORIGINS and AUTH_DEV_EXTRA_ORIGINS.
# Returns the new root PID, or 0 when it never became ready (the caller then falls back).
function Restart-Backend([string]$BaseText, [int]$OldRootPid, [string[]]$Origins, [string[]]$DevExtraOrigins, [string]$Label) {
    $baseNoExtra = [regex]::Replace($BaseText, "(?m)^\`$env:AUTH_DEV_EXTRA_ORIGINS = '[^']*'[ \t]*\r?\n?", '')
    $line = [regex]::Match($baseNoExtra, "(?m)^\`$env:AUTH_ALLOWED_ORIGINS = '[^']*'[ \t]*\r?$")
    $replacement = "`$env:AUTH_ALLOWED_ORIGINS = '$($Origins -join ',')'"
    if (@($DevExtraOrigins).Count -gt 0) { $replacement += "`r`n`$env:AUTH_DEV_EXTRA_ORIGINS = '$($DevExtraOrigins -join ',')'" }
    $newText = $baseNoExtra.Replace($line.Value, $replacement)
    New-Item -ItemType Directory -Path $FastRoot -Force | Out-Null
    $scriptPath = Join-Path $FastRoot 'backend.ps1'
    $body = (@(Get-PassthroughEnvLines) -join "`r`n") + "`r`n" + $newText + "`r`n"
    [IO.File]::WriteAllText($scriptPath, $body, (New-Object Text.UTF8Encoding($true)))
    if ($OldRootPid -gt 0) { Stop-Tree $OldRootPid }
    Wait-Until { -not (Test-PortListening $BackendPort) } 30 "Backend port $BackendPort did not free up after stopping the old backend."
    New-Item -ItemType Directory -Path $RuntimeLogs -Force | Out-Null
    $errLog = Join-Path $RuntimeLogs 'backend.err.log'
    Add-Content -LiteralPath $errLog -Value "=== feature-fast backend restart ($Label) $((Get-Date).ToString('o'))"
    $rootPid = Start-Detached $scriptPath (Join-Path $RuntimeLogs 'backend.out.log') $errLog $Worktree
    Update-OwnedRecords @($OldRootPid) @(Get-ProcessRecord $rootPid)
    if (Wait-BackendReady 75) { return [pscustomobject]@{ pid = $rootPid; script = $scriptPath } }
    Stop-Tree $rootPid
    Update-OwnedRecords @($rootPid) @()
    return [pscustomobject]@{ pid = 0; script = $scriptPath }
}

function Ensure-BackendOrigins($State, [string[]]$LoopbackOrigins, [string[]]$TailnetOrigins, [bool]$TryTailnet) {
    $current = Get-BackendScriptText $State
    $lineMatch = [regex]::Match($current.text, "(?m)^\`$env:AUTH_ALLOWED_ORIGINS = '([^']*)'\s*$")
    if (-not $lineMatch.Success) { throw 'Backend wrapper has no AUTH_ALLOWED_ORIGINS line; refusing to guess.' }
    $existing = @($lineMatch.Groups[1].Value -split ',' | Where-Object { $_ })
    $envMap = ConvertFrom-EnvLines $current.text
    $existingExtra = @($(if ($envMap.Contains('AUTH_DEV_EXTRA_ORIGINS')) { [string]$envMap['AUTH_DEV_EXTRA_ORIGINS'] } else { '' }) -split ',' | Where-Object { $_ })
    $wantedTailnet = @($(if ($TryTailnet) { @($TailnetOrigins) } else { @() }))
    $wanted = @($LoopbackOrigins) + $wantedTailnet
    $missing = @($wanted | Where-Object { $existing -notcontains $_ })
    $missingExtra = @($wantedTailnet | Where-Object { $existingExtra -notcontains $_ })
    $result = [ordered]@{
        script = [string](Get-StateValue $State 'backend_script' ''); rootPid = [int](Get-StateValue $State 'backend_root_pid' 0)
        tailnet_origin_accepted = [bool]($TryTailnet -and $missing.Count -eq 0 -and $missingExtra.Count -eq 0)
    }
    if ($missing.Count -eq 0 -and $missingExtra.Count -eq 0) {
        Write-Host 'Backend already allows the preview origins.' -ForegroundColor DarkGray
        return [pscustomobject]$result
    }
    # Origins that existed before this tool touched the backend, so a fallback can always get back.
    $original = @($existing | Where-Object { @($LoopbackOrigins) + @($TailnetOrigins) -notcontains $_ })
    $originalExtra = @($existingExtra | Where-Object { @($TailnetOrigins) -notcontains $_ -and $original -contains $_ })
    $base = $current.text
    Write-Host "Restarting the runtime backend with allowed origins +[$($missing -join ', ')] and dev extra origins +[$($missingExtra -join ', ')]" -ForegroundColor Yellow
    $attempt = Restart-Backend $base $current.rootPid ($original + $wanted) ($originalExtra + $wantedTailnet) 'preview origins'
    $accepted = $TryTailnet
    if ($attempt.pid -eq 0 -and $TryTailnet) {
        Write-Host 'The server refused to start with the Tailscale https origin (see the backend error log). Retrying without it.' -ForegroundColor Yellow
        $attempt = Restart-Backend $base 0 ($original + $LoopbackOrigins) $originalExtra 'loopback preview origin only'
        $accepted = $false
    }
    if ($attempt.pid -eq 0) {
        Write-Host 'Restoring the original backend origins.' -ForegroundColor Yellow
        $attempt = Restart-Backend $base 0 $original $originalExtra 'restore'
        throw "The backend would not start with the preview origins; original origins restored (backend ready: $($attempt.pid -ne 0)). See $RuntimeLogs\backend.err.log"
    }
    $result.script = $attempt.script
    $result.rootPid = $attempt.pid
    $result.tailnet_origin_accepted = $accepted
    return [pscustomobject]$result
}

# ---------- preview + tailscale ----------

function Start-Preview($FrontendEnv, [int]$PreviewPort, [string[]]$Hosts) {
    $lines = @(Get-PassthroughEnvLines)
    foreach ($entry in $FrontendEnv.GetEnumerator()) { $lines += "`$env:$($entry.Key) = $(Quote-Ps ([string]$entry.Value))" }
    $lines += "`$env:ASH_ATLAS_PREVIEW_ALLOWED_HOSTS = $(Quote-Ps ($Hosts -join ','))"
    $lines += "Set-Location -LiteralPath $(Quote-Ps $ClientRoot)"
    $lines += "node $(Quote-Ps $ViteJs) preview --outDir $(Quote-Ps $DistPath) --host 127.0.0.1 --port $PreviewPort --strictPort --configLoader runner"
    $scriptPath = Join-Path $FastRoot 'preview.ps1'
    [IO.File]::WriteAllText($scriptPath, ($lines -join "`r`n") + "`r`n", (New-Object Text.UTF8Encoding($true)))
    $logs = Join-Path $FastRoot 'logs'
    New-Item -ItemType Directory -Path $logs -Force | Out-Null
    $rootPid = Start-Detached $scriptPath (Join-Path $logs 'preview.out.log') (Join-Path $logs 'preview.err.log') $ClientRoot
    Wait-Until { Test-PortListening $PreviewPort } 30 "vite preview did not start on $PreviewPort; see $logs"
    return $rootPid
}

function Invoke-TailscaleServe([int]$HttpsPort, [int]$PreviewPort) {
    $exe = Get-TailscaleExe
    New-Item -ItemType Directory -Path $FastRoot -Force | Out-Null
    $outFile = Join-Path $FastRoot 'serve.out.txt'
    $errFile = Join-Path $FastRoot 'serve.err.txt'
    # When serve is not enabled on the tailnet, `tailscale serve` prints an admin link and then
    # waits indefinitely, so bound it and kill it.
    $process = Start-Process -FilePath $exe -ArgumentList @('serve', '--bg', "--https=$HttpsPort", "http://127.0.0.1:$PreviewPort") `
        -PassThru -NoNewWindow -RedirectStandardOutput $outFile -RedirectStandardError $errFile
    # Touch the handle now: without it Windows PowerShell reports ExitCode as $null after exit.
    $null = $process.Handle
    $finished = $process.WaitForExit(20000)
    if (-not $finished) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
    $output = ((Get-Content -Raw -LiteralPath $outFile -ErrorAction SilentlyContinue) + "`n" + (Get-Content -Raw -LiteralPath $errFile -ErrorAction SilentlyContinue)).Trim()
    $ok = $finished -and $process.ExitCode -eq 0 -and ($output -notmatch '(?i)not enabled|not configured|error')
    return [pscustomobject]@{ ok = $ok; output = $output }
}

function Stop-TailscaleServe([int]$HttpsPort) {
    $ErrorActionPreference = 'Continue'
    try { & (Get-TailscaleExe) serve "--https=$HttpsPort" off 2>&1 | Out-Null } catch { }
    $global:LASTEXITCODE = 0
}

# ---------- operations ----------

function Invoke-Start {
    $state = Read-State
    $frontendEnv = Get-FrontendEnv
    if (-not (Test-PortListening $BackendPort)) { throw "Runtime backend is not listening on $BackendPort. Start the runtime first." }

    $previewPort = [int](Get-StateValue $state 'preview_port' 0)
    $previewRoot = [int](Get-StateValue $state 'preview_root_pid' 0)
    $previewAlive = $previewPort -gt 0 -and $previewRoot -gt 0 -and (Test-PortListening $previewPort) -and (Get-Process -Id $previewRoot -ErrorAction SilentlyContinue)
    if ($previewPort -le 0 -or (-not $previewAlive -and (Test-PortListening $previewPort))) {
        $previewPort = Find-FreePort (47000 + ($FrontendPort % 1000))
    }
    # Tailscale https port = the runtime's frontend port: stable per runtime and unique across runtimes.
    $httpsPort = $FrontendPort
    $tailHost = $null
    if (-not $NoTailscale) { $tailHost = Get-TailnetHost }

    $loopbackOrigins = @("http://127.0.0.1:$previewPort", "http://localhost:$previewPort")
    $tailnetOrigins = @(if ($tailHost) { "https://${tailHost}:$httpsPort" })
    $tryTailnet = $tailnetOrigins.Count -gt 0
    $origins = @($loopbackOrigins) + @($tailnetOrigins)
    $hosts = @('127.0.0.1', 'localhost')
    if ($tailHost) { $hosts += $tailHost }

    Invoke-FastBuild $frontendEnv
    $backend = Ensure-BackendOrigins $state $loopbackOrigins $tailnetOrigins $tryTailnet

    if ($previewAlive) {
        Write-Host "vite preview already running on $previewPort." -ForegroundColor DarkGray
    } else {
        Write-Host "Starting vite preview on 127.0.0.1:$previewPort ..."
        $previewRoot = Start-Preview $frontendEnv $previewPort $hosts
        Update-OwnedRecords @([int](Get-StateValue $state 'preview_root_pid' 0)) @(Get-ProcessRecord $previewRoot)
    }

    $serve = $null
    if ($tailHost) { $serve = Invoke-TailscaleServe $httpsPort $previewPort }

    $newState = [ordered]@{
        runtime_id = $RuntimeId
        worktree = $Worktree
        preview_port = $previewPort
        preview_root_pid = $previewRoot
        https_port = $httpsPort
        tailnet_host = $tailHost
        origins = $origins
        dev_extra_origins = @($tailnetOrigins)
        tailnet_origin_rejected = [bool]($tailnetOrigins.Count -gt 0 -and -not $backend.tailnet_origin_accepted)
        backend_script = $backend.script
        backend_root_pid = $backend.rootPid
        tailscale_serve_ok = [bool]($serve -and $serve.ok)
        built_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    }
    Write-State $newState
    Show-Summary $newState $serve
    if ($serve -and -not $serve.ok) { exit 3 }
}

function Show-Summary($State, $Serve) {
    Write-Host ''
    Write-Host "Runtime:        $RuntimeId"
    Write-Host "Local preview:  http://127.0.0.1:$($State.preview_port)/"
    if ($State.tailnet_host) {
        $usable = $Serve -and $Serve.ok -and -not $State.tailnet_origin_rejected
        Write-Host ("Phone URL:      https://$($State.tailnet_host):$($State.https_port)/" + $(if ($usable) { "" } else { "  (not usable yet, see below)" })) -ForegroundColor $(if ($usable) { "Green" } else { "Yellow" })
    }
    if ($State.tailnet_origin_rejected) {
        Write-Host ''
        Write-Host 'The game server would not start with the Tailscale https origin, so the phone link cannot log in.' -ForegroundColor Yellow
        Write-Host "Its boot error is in $RuntimeLogs\backend.err.log (this worktree's server may predate AUTH_DEV_EXTRA_ORIGINS)." -ForegroundColor Yellow
        Write-Host 'The local preview above works. Re-run start after fixing the cause.' -ForegroundColor Yellow
    }
    if ($Serve -and -not $Serve.ok) {
        Write-Host ''
        Write-Host 'Tailscale serve was NOT set up. Tailscale said:' -ForegroundColor Yellow
        Write-Host $Serve.output
        Write-Host 'The preview itself is running; re-run start after fixing the tailnet setting above.' -ForegroundColor Yellow
    }
}

function Invoke-Stop {
    $state = Read-State
    if ($null -eq $state) { Write-Host 'Fast phone test is not set up for this runtime.'; return }
    $previewRoot = [int](Get-StateValue $state 'preview_root_pid' 0)
    if ($previewRoot -gt 0 -and (Get-Process -Id $previewRoot -ErrorAction SilentlyContinue)) {
        $cl = Get-ProcessCommandLine $previewRoot
        if ($cl -match 'preview\.ps1') { Stop-Tree $previewRoot; Write-Host "Stopped vite preview (PID $previewRoot)." }
    }
    Update-OwnedRecords @($previewRoot) @()
    if ((Get-StateValue $state 'tailnet_host' $null)) { Stop-TailscaleServe ([int]$state.https_port); Write-Host "Removed tailscale serve on https $($state.https_port)." }
    $state.preview_root_pid = 0
    $state.tailscale_serve_ok = $false
    Write-State $state
    Write-Host 'The built files and the extra backend origins stay until the runtime restarts.'
}

function Invoke-Rebuild {
    $state = Read-State
    if ($null -eq $state) { throw 'Not started yet. Run start first.' }
    Invoke-FastBuild (Get-FrontendEnv)
    $state.built_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    Write-State $state
    Write-Host 'Reload the page on the phone to pick up the new build.'
}

function Invoke-Status {
    $state = Read-State
    if ($null -eq $state) { Write-Host "Fast phone test: not set up for $RuntimeId."; return }
    $previewPort = [int]$state.preview_port
    $listening = Test-PortListening $previewPort
    Write-Host "Runtime:        $RuntimeId"
    Write-Host "Preview:        $(if ($listening) { 'running' } else { 'stopped' }) on 127.0.0.1:$previewPort"
    Write-Host "Built:          $($state.built_at_utc)"
    Write-Host "Backend origins requested: $($state.origins -join ', ')$(if ($state.tailnet_origin_rejected) { '  (https origin refused by the server)' })"
    Write-Host "Dev extra origins (AUTH_DEV_EXTRA_ORIGINS): $(@(Get-StateValue $state 'dev_extra_origins' @()) -join ', ')"
    if ($state.tailnet_host) {
        $ErrorActionPreference = 'Continue'
        Write-Host ("Tailscale serve: " + ((& (Get-TailscaleExe) serve status 2>&1 | Out-String).Trim()))
        Write-Host "Phone URL:      https://$($state.tailnet_host):$($state.https_port)/"
    }
    $global:LASTEXITCODE = 0
}

function Invoke-Watch {
    $state = Read-State
    if ($null -eq $state) { throw 'Not started yet. Run start first.' }
    $roots = @(
        (Join-Path $ClientRoot 'src'), (Join-Path $ClientRoot 'public'),
        (Join-Path $Worktree 'packages\shared\src'), (Join-Path $Worktree 'packages\player-renderer\src')
    ) | Where-Object { Test-Path -LiteralPath $_ }
    $watchers = @()
    foreach ($root in $roots) {
        $w = New-Object IO.FileSystemWatcher $root
        $w.IncludeSubdirectories = $true
        $w.NotifyFilter = [IO.NotifyFilters]'FileName, LastWrite, DirectoryName'
        $w.EnableRaisingEvents = $true
        $watchers += $w
    }
    Write-Host "Watching for changes (debounce ${DebounceSeconds}s). Ctrl+C to stop." -ForegroundColor Cyan
    try {
        while ($true) {
            $changed = $false
            foreach ($w in $watchers) { if (-not $w.WaitForChanged([IO.WatcherChangeTypes]::All, 500).TimedOut) { $changed = $true } }
            if (-not $changed) { continue }
            # Debounce: keep draining until a quiet period passes.
            do {
                Start-Sleep -Seconds $DebounceSeconds
                $more = $false
                foreach ($w in $watchers) { if (-not $w.WaitForChanged([IO.WatcherChangeTypes]::All, 50).TimedOut) { $more = $true } }
            } while ($more)
            try { Invoke-Rebuild } catch { Write-Host "Rebuild failed: $($_.Exception.Message)" -ForegroundColor Red }
        }
    } finally {
        foreach ($w in $watchers) { $w.Dispose() }
    }
}

switch ($Operation) {
    'start' { Invoke-Start }
    'stop' { Invoke-Stop }
    'rebuild' { Invoke-Rebuild }
    'status' { Invoke-Status }
    'watch' { Invoke-Watch }
}
