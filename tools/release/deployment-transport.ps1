Set-StrictMode -Version Latest

# The one deployment server every release tool targets unless -SshHost overrides it.
# Set ASH_ATLAS_SSH_HOST (user@host) and ASH_ATLAS_SSH_KEY to point at your own server.
$script:AshAtlasProductionSshHost = $(if ($env:ASH_ATLAS_SSH_HOST) { $env:ASH_ATLAS_SSH_HOST } else { 'deploy@your-server.example' })

# The SSH identity the server accepts unless -SshKey overrides it. The default is a
# placeholder key name; override with -SshKey or ASH_ATLAS_SSH_KEY.
$script:AshAtlasProductionSshKeyPath = $(if ($env:ASH_ATLAS_SSH_KEY) { $env:ASH_ATLAS_SSH_KEY } else { Join-Path $(if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }) '.ssh\your_deploy_key' })

function ConvertTo-NativeCommandArgument {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)
    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
}

function Stop-NativeProcessTree {
    param([Parameter(Mandatory = $true)][Diagnostics.Process]$Process)
    if ($Process.HasExited) { return $true }

    $taskkill = New-Object Diagnostics.Process
    $taskkill.StartInfo = New-Object Diagnostics.ProcessStartInfo
    $taskkill.StartInfo.FileName = 'taskkill.exe'
    $taskkill.StartInfo.Arguments = "/PID $($Process.Id) /T /F"
    $taskkill.StartInfo.UseShellExecute = $false
    $taskkill.StartInfo.CreateNoWindow = $true
    $taskkill.StartInfo.RedirectStandardOutput = $true
    $taskkill.StartInfo.RedirectStandardError = $true
    try {
        if ($taskkill.Start()) {
            $taskkill.StandardOutput.ReadToEndAsync() | Out-Null
            $taskkill.StandardError.ReadToEndAsync() | Out-Null
            if (-not $taskkill.WaitForExit(5000)) {
                try { $taskkill.Kill() } catch { }
                $taskkill.WaitForExit(1000) | Out-Null
            }
        }
    } catch {
        # The root-process kill below is still attempted if taskkill itself is unavailable.
    } finally {
        $taskkill.Dispose()
    }

    if (-not $Process.WaitForExit(5000)) {
        try { $Process.Kill() } catch { }
        $Process.WaitForExit(2000) | Out-Null
    }
    return $Process.HasExited
}

function Invoke-BoundedNativeProcess {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][ValidateRange(1, 3600000)][int]$TimeoutMilliseconds,
        [AllowNull()][string]$StandardInput = $null
    )
    $startedAt = (Get-Date).ToUniversalTime()
    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    $process = New-Object Diagnostics.Process
    $process.StartInfo = New-Object Diagnostics.ProcessStartInfo
    $process.StartInfo.FileName = $FilePath
    $process.StartInfo.Arguments = (@($Arguments | ForEach-Object {
        ConvertTo-NativeCommandArgument ([string]$_)
    }) -join ' ')
    $process.StartInfo.UseShellExecute = $false
    $process.StartInfo.CreateNoWindow = $true
    $process.StartInfo.RedirectStandardOutput = $true
    $process.StartInfo.RedirectStandardError = $true
    $process.StartInfo.RedirectStandardInput = $true

    $startSucceeded = $false
    $processId = 0
    $startupMilliseconds = 0L
    $timedOut = $false
    $treeTerminated = $false
    $outputCaptureComplete = $false
    $exitCode = -1
    $stdoutText = ''
    $stderrText = ''
    $startError = ''
    $stdoutTask = $null
    $stderrTask = $null
    try {
        try {
            $startSucceeded = $process.Start()
            $startupMilliseconds = [long]$stopwatch.ElapsedMilliseconds
            if ($startSucceeded) { $processId = $process.Id }
        } catch {
            $startError = $_.Exception.Message
        }
        if (-not $startSucceeded) {
            return [pscustomobject][ordered]@{
                start_succeeded = $false
                process_id = 0
                started_at_utc = $startedAt.ToString('o')
                startup_duration_ms = $startupMilliseconds
                duration_ms = [long]$stopwatch.ElapsedMilliseconds
                exit_code = -1
                timed_out = $false
                watchdog_terminated = $false
                process_tree_terminated = $true
                output_capture_complete = $true
                stdout = ''
                stderr = $startError
            }
        }

        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if ($null -ne $StandardInput) {
            $process.StandardInput.Write($StandardInput)
            $process.StandardInput.Flush()
        }
        $process.StandardInput.Close()

        $timedOut = -not $process.WaitForExit($TimeoutMilliseconds)
        if ($timedOut) {
            $treeTerminated = Stop-NativeProcessTree $process
        } else {
            $treeTerminated = $true
        }

        try { $stdoutCompleted = $stdoutTask.Wait(2000) } catch { $stdoutCompleted = $false }
        try { $stderrCompleted = $stderrTask.Wait(2000) } catch { $stderrCompleted = $false }
        $outputCaptureComplete = $stdoutCompleted -and $stderrCompleted
        if ($stdoutCompleted) {
            try { $stdoutText = $stdoutTask.GetAwaiter().GetResult() } catch { }
        }
        if ($stderrCompleted) {
            try { $stderrText = $stderrTask.GetAwaiter().GetResult() } catch { }
        }
        if (-not $timedOut -and $process.HasExited) { $exitCode = $process.ExitCode }
        elseif ($timedOut) { $exitCode = 124 }
    } finally {
        $stopwatch.Stop()
        $process.Dispose()
    }

    return [pscustomobject][ordered]@{
        start_succeeded = $startSucceeded
        process_id = $processId
        started_at_utc = $startedAt.ToString('o')
        startup_duration_ms = $startupMilliseconds
        duration_ms = [long]$stopwatch.ElapsedMilliseconds
        exit_code = $exitCode
        timed_out = $timedOut
        watchdog_terminated = $timedOut
        process_tree_terminated = $treeTerminated
        output_capture_complete = $outputCaptureComplete
        stdout = $stdoutText
        stderr = $stderrText
    }
}

function ConvertTo-WslPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    $fullPath = [IO.Path]::GetFullPath($Path)
    if ($fullPath -notmatch '^(?<drive>[A-Za-z]):\\(?<tail>.*)$') {
        throw 'WSL transport supports only local drive paths for SSH identity files'
    }
    $tail = $Matches.tail.Replace('\', '/')
    return "/mnt/$($Matches.drive.ToLowerInvariant())/$tail"
}

function Get-ReleaseSshEndpoint {
    param([Parameter(Mandatory = $true)][string]$SshHost)
    if ($SshHost -notmatch '^(?<user>[A-Za-z_][A-Za-z0-9_-]*)@(?<host>[A-Za-z0-9.-]+)$') {
        throw 'SSH endpoint must use the safe user@host form'
    }
    return [pscustomobject]@{
        user = $Matches.user
        host = $Matches.host
        endpoint = $SshHost
    }
}

function Protect-ReleaseTransportText {
    param(
        [AllowNull()][string]$Text,
        [Parameter(Mandatory = $true)]$Transport
    )
    if ($null -eq $Text) { return '' }
    $protected = $Text
    foreach ($secretPath in @(
        [string]$Transport.key_windows_path,
        [string]$Transport.known_hosts_windows_path,
        [string]$Transport.key_wsl_path,
        [string]$Transport.known_hosts_wsl_path
    )) {
        if ($secretPath) {
            $protected = $protected -replace [regex]::Escape($secretPath), '[redacted-ssh-path]'
        }
    }
    $protected = $protected -replace (
        '/tmp/ash-atlas-release-transport[.][^/\s]+/(?:identity|known_hosts)'
    ), '[redacted-ssh-path]'
    return $protected
}

function Resolve-WslOpenSshTransport {
    param(
        [Parameter(Mandatory = $true)][string]$SshHost,
        [Parameter(Mandatory = $true)][string]$SshKey,
        [Parameter(Mandatory = $true)][string]$KnownHostsFile
    )
    $endpoint = Get-ReleaseSshEndpoint $SshHost
    $wslCommand = Get-Command 'wsl.exe' -ErrorAction SilentlyContinue
    if ($null -eq $wslCommand) { throw 'WSL OpenSSH transport is unavailable: wsl.exe was not found' }
    foreach ($entry in @(
        @{ label = 'SSH private key'; path = $SshKey },
        @{ label = 'pinned known-hosts file'; path = $KnownHostsFile }
    )) {
        if (-not (Test-Path -LiteralPath $entry.path -PathType Leaf)) {
            throw "$($entry.label) is absent"
        }
    }

    $keyWindowsPath = [IO.Path]::GetFullPath($SshKey)
    $knownHostsWindowsPath = [IO.Path]::GetFullPath($KnownHostsFile)
    $keyWslPath = ConvertTo-WslPath $keyWindowsPath
    $knownHostsWslPath = ConvertTo-WslPath $knownHostsWindowsPath
    $probe = Invoke-BoundedNativeProcess -FilePath $wslCommand.Source -Arguments @(
        '-e', 'sh', '-c',
        'command -v bash >/dev/null && command -v ssh >/dev/null && command -v scp >/dev/null && command -v ssh-keygen >/dev/null && command -v timeout >/dev/null && command -v install >/dev/null && command -v mktemp >/dev/null',
        'ash-atlas-release-preflight'
    ) -TimeoutMilliseconds 10000
    if (-not $probe.start_succeeded -or $probe.timed_out -or $probe.exit_code -ne 0) {
        throw 'WSL OpenSSH transport is unavailable or lacks bash, ssh, scp, ssh-keygen, timeout, install, or mktemp'
    }
    $hostProbe = Invoke-BoundedNativeProcess -FilePath $wslCommand.Source -Arguments @(
        '-e', 'ssh-keygen', '-F', [string]$endpoint.host, '-f', $knownHostsWslPath
    ) -TimeoutMilliseconds 10000
    if (-not $hostProbe.start_succeeded -or $hostProbe.timed_out -or $hostProbe.exit_code -ne 0) {
        throw "pinned known-hosts file has no entry for $($endpoint.host)"
    }

    return [pscustomobject][ordered]@{
        name = 'wsl-openssh'
        wsl_file_path = $wslCommand.Source
        endpoint = [string]$endpoint.endpoint
        host = [string]$endpoint.host
        key_windows_path = $keyWindowsPath
        known_hosts_windows_path = $knownHostsWindowsPath
        key_wsl_path = $keyWslPath
        known_hosts_wsl_path = $knownHostsWslPath
    }
}

function Get-SshTransportFailureClass {
    param(
        [Parameter(Mandatory = $true)]$NativeResult,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Output
    )
    if (-not [bool]$NativeResult.start_succeeded) { return 'local-preflight-failure' }
    if ([bool]$NativeResult.timed_out -or [int]$NativeResult.exit_code -eq 124) {
        return 'external-watchdog-timeout'
    }
    if ([int]$NativeResult.exit_code -eq 0) { return 'transport-succeeded' }
    if ($Output -match '(?i)REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|No .* host key is known') {
        return 'host-key-verification-failure'
    }
    if ($Output -match '(?i)Permission denied \(publickey\)|no mutual signature algorithm|sign_and_send_pubkey') {
        return 'ssh-authentication-failure'
    }
    if ($Output -match '(?i)Connection timed out during banner exchange|banner exchange|key exchange|kex_exchange_identification') {
        return 'ssh-banner-or-kex-timeout'
    }
    if ($Output -match '(?i)connect to host .* port \d+: Connection timed out') {
        return 'tcp-connect-timeout'
    }
    if ($Output -match '(?m)^STOP:|deployment controller is busy|origin/master does not equal|installed updater hash differs') {
        return 'controller-rejected'
    }
    return 'transport-unavailable'
}

function Invoke-WslOpenSshCommand {
    param(
        [Parameter(Mandatory = $true)]$Transport,
        [Parameter(Mandatory = $true)][ValidateSet('ssh', 'scp')][string]$Program,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][ValidateRange(1, 300)][int]$ConnectTimeoutSeconds,
        [Parameter(Mandatory = $true)][ValidateRange(2, 3600)][int]$HardDeadlineSeconds,
        [AllowNull()][string]$StandardInput = $null
    )
    $linuxDeadlineSeconds = [math]::Max(1, $HardDeadlineSeconds - 2)
    $standardInputPath = $null
    $wrapper = @'
set -eu
key_source=$1
known_hosts_source=$2
deadline=$3
program=$4
connect_timeout=$5
stdin_source=$6
shift 6
transport_dir=$(mktemp -d "${TMPDIR:-/tmp}/ash-atlas-release-transport.XXXXXX")
cleanup() {
  rm -rf -- "$transport_dir"
}
trap cleanup EXIT HUP INT TERM
install -m 0600 -- "$key_source" "$transport_dir/identity"
install -m 0600 -- "$known_hosts_source" "$transport_dir/known_hosts"
if [[ -n "$stdin_source" ]]; then
  exec < "$stdin_source"
fi
timeout --foreground --signal=TERM --kill-after=2s "${deadline}s" "$program" \
  -o BatchMode=yes \
  -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes \
  -o "UserKnownHostsFile=$transport_dir/known_hosts" \
  -o PasswordAuthentication=no \
  -o KbdInteractiveAuthentication=no \
  -o PreferredAuthentications=publickey \
  -o NumberOfPasswordPrompts=0 \
  -o "ConnectTimeout=$connect_timeout" \
  -o ConnectionAttempts=1 \
  -o ServerAliveInterval=10 \
  -o ServerAliveCountMax=2 \
  -i "$transport_dir/identity" \
  "$@"
'@
    $wrapper = $wrapper.Replace("`r`n", "`n").Replace("`r", "`n")
    try {
        if ($null -ne $StandardInput) {
            $StandardInput = $StandardInput.Replace("`r`n", "`n").Replace("`r", "`n")
            $standardInputPath = Join-Path ([IO.Path]::GetTempPath()) (
                'ash-atlas-release-stdin-' + [guid]::NewGuid().ToString('n')
            )
            [IO.File]::WriteAllBytes(
                $standardInputPath,
                [Text.UTF8Encoding]::new($false).GetBytes($StandardInput)
            )
        }
        $standardInputWslPath = if ($null -eq $standardInputPath) {
            ''
        } else {
            ConvertTo-WslPath $standardInputPath
        }
        $nativeArguments = @(
            '-e', 'bash', '-c', $wrapper, 'ash-atlas-release-transport',
            [string]$Transport.key_wsl_path,
            [string]$Transport.known_hosts_wsl_path,
            [string]$linuxDeadlineSeconds,
            $Program,
            [string]$ConnectTimeoutSeconds,
            $standardInputWslPath
        ) + $Arguments
        $native = Invoke-BoundedNativeProcess -FilePath ([string]$Transport.wsl_file_path) `
            -Arguments $nativeArguments -TimeoutMilliseconds ($HardDeadlineSeconds * 1000)
    } finally {
        if ($null -ne $standardInputPath -and (Test-Path -LiteralPath $standardInputPath)) {
            Remove-Item -LiteralPath $standardInputPath -Force
        }
    }
    $stdout = Protect-ReleaseTransportText ([string]$native.stdout) $Transport
    $stderr = Protect-ReleaseTransportText ([string]$native.stderr) $Transport
    $output = (@($stdout.Trim(), $stderr.Trim()) | Where-Object { $_ }) -join "`n"
    $failureClass = Get-SshTransportFailureClass $native $output
    return [pscustomobject][ordered]@{
        transport = 'wsl-openssh'
        exit_code = [int]$native.exit_code
        timed_out = [bool]$native.timed_out
        watchdog_terminated = [bool]$native.timed_out -or [int]$native.exit_code -eq 124
        process_tree_terminated = [bool]$native.process_tree_terminated
        output_capture_complete = [bool]$native.output_capture_complete
        startup_duration_ms = [long]$native.startup_duration_ms
        duration_ms = [long]$native.duration_ms
        failure_class = $failureClass
        acceptance_ambiguous = $failureClass -in @(
            'transport-unavailable',
            'tcp-connect-timeout',
            'ssh-banner-or-kex-timeout',
            'external-watchdog-timeout'
        )
        stdout = $stdout
        stderr = $stderr
        output = $output
    }
}
