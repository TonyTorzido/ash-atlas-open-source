[CmdletBinding()]
param(
    [string]$RequestPath,
    [string]$ReceiptPath,
    [string]$WorkRoot,
    [string]$ExpectedSupervisorUser,
    [string]$ExpectedBuildUser,
    [PSCredential]$BuildCredential
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:MaxLogBytes = 4MB
$script:MaxRequestBytes = 8MB

# Windows PowerShell 5.1 executes stream callback scriptblocks on reader
# threads that do not carry the caller's runspace.  Use a tiny .NET
# reader instead: it consumes fixed-size bytes until EOF, bounds retained
# memory, and exposes completion through Tasks.
if ($null -eq ('AshAtlas.IsolatedBatchValidator.BoundedStreamCapture' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace AshAtlas.IsolatedBatchValidator {
    public sealed class BoundedStreamResult {
        public string Text { get; private set; }
        public bool Overflow { get; private set; }

        public BoundedStreamResult(string text, bool overflow) {
            Text = text;
            Overflow = overflow;
        }
    }

    public sealed class BoundedStreamCapture {
        public Task<BoundedStreamResult> StdoutTask { get; private set; }
        public Task<BoundedStreamResult> StderrTask { get; private set; }

        private BoundedStreamCapture(
            Task<BoundedStreamResult> stdoutTask,
            Task<BoundedStreamResult> stderrTask) {
            StdoutTask = stdoutTask;
            StderrTask = stderrTask;
        }

        public static BoundedStreamCapture Start(Process process, int maxBytes) {
            if (process == null) throw new ArgumentNullException("process");
            if (maxBytes < 1) throw new ArgumentOutOfRangeException("maxBytes");
            Task<BoundedStreamResult> stdout = Task.Factory.StartNew<BoundedStreamResult>(
                delegate { return Read(process.StandardOutput.BaseStream, maxBytes); },
                CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
            Task<BoundedStreamResult> stderr = Task.Factory.StartNew<BoundedStreamResult>(
                delegate { return Read(process.StandardError.BaseStream, maxBytes); },
                CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
            return new BoundedStreamCapture(stdout, stderr);
        }

        public bool Wait(int millisecondsTimeout) {
            return Task.WaitAll(new Task[] { StdoutTask, StderrTask }, millisecondsTimeout);
        }

        private static BoundedStreamResult Read(Stream stream, int maxBytes) {
            byte[] buffer = new byte[81920];
            using (MemoryStream retained = new MemoryStream(Math.Min(maxBytes, buffer.Length))) {
                int total = 0;
                bool overflow = false;
                int count;
                while ((count = stream.Read(buffer, 0, buffer.Length)) > 0) {
                    if (total < maxBytes) {
                        int keep = Math.Min(count, maxBytes - total);
                        retained.Write(buffer, 0, keep);
                        total += keep;
                        if (keep != count) overflow = true;
                    } else {
                        overflow = true;
                    }
                }
                return new BoundedStreamResult(
                    new UTF8Encoding(false, false).GetString(retained.ToArray()), overflow);
            }
        }
    }
}
'@
}

function Stop-IsolatedGuest {
    param([Parameter(Mandatory = $true)][string]$Message)
    throw "isolated batch validator guest: $Message"
}

function Get-GuestProperty {
    param(
        [Parameter(Mandatory = $true)]$Object,
        [Parameter(Mandatory = $true)][string]$Name,
        $Default = $null
    )
    if ($null -eq $Object) { return $Default }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value) { return $Default }
    return $property.Value
}

function Get-GuestFullPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    try { return [IO.Path]::GetFullPath($Path).TrimEnd('\') }
    catch { Stop-IsolatedGuest "invalid guest path: $Path" }
}

function Test-GuestUnderRoot {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Root)
    $pathFull = Get-GuestFullPath $Path
    $rootFull = Get-GuestFullPath $Root
    return [String]::Equals($pathFull, $rootFull, [StringComparison]::OrdinalIgnoreCase) -or
        $pathFull.StartsWith($rootFull + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Assert-GuestNoReparsePath {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Root)
    $itemPath = Get-GuestFullPath $Path
    $rootFull = Get-GuestFullPath $Root
    while ($true) {
        $item = Get-Item -LiteralPath $itemPath -Force -ErrorAction Stop
        if (([IO.FileAttributes]$item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            Stop-IsolatedGuest "guest validator path is a reparse point: $itemPath"
        }
        if ([String]::Equals($itemPath, $rootFull, [StringComparison]::OrdinalIgnoreCase)) { break }
        $parent = (Split-Path -Parent $itemPath).TrimEnd('\')
        if (-not $parent -or -not (Test-GuestUnderRoot $parent $rootFull)) { Stop-IsolatedGuest 'guest validator path escaped its work root' }
        $itemPath = $parent
    }
}

function Get-GuestFileSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    $stream = $null
    try {
        $stream = [IO.File]::OpenRead($Path)
        return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
        $algorithm.Dispose()
    }
}

function Read-GuestJson {
    param([Parameter(Mandatory = $true)][string]$Path)
    if ((Get-Item -LiteralPath $Path -Force).Length -gt $script:MaxRequestBytes) { Stop-IsolatedGuest 'guest validator request is too large' }
    $raw = [IO.File]::ReadAllText($Path, [Text.UTF8Encoding]::new($false))
    if ($raw.Length -gt 0 -and [int]$raw[0] -eq 0xfeff) { Stop-IsolatedGuest 'guest validator request contains a UTF-8 BOM' }
    try { return $raw | ConvertFrom-Json -ErrorAction Stop }
    catch { Stop-IsolatedGuest 'guest validator request is not valid UTF-8 JSON' }
}

function Test-GuestRelativePath {
    param([Parameter(Mandatory = $true)][string]$Path)
    return -not [string]::IsNullOrWhiteSpace($Path) -and
        $Path -notmatch '^(?:[A-Za-z]:[\\/]|[\\/]{2})' -and
        $Path -notmatch '(^|[\\/])\.\.(?:[\\/]|$)' -and
        $Path -notmatch '[\x00-\x1f]'
}

function Assert-GuestIdentity {
    param(
        [Parameter(Mandatory = $true)][string]$ExpectedSupervisorUser,
        [Parameter(Mandatory = $true)][string]$ExpectedBuildUser,
        [Parameter(Mandatory = $true)][string]$Root
    )
    if ([Environment]::UserName -cne $ExpectedSupervisorUser) { Stop-IsolatedGuest 'PowerShell Direct session is not running as the pinned trusted supervisor identity' }
    $supervisorSid = Get-GuestIdentitySid $ExpectedSupervisorUser
    $buildSid = Get-GuestIdentitySid $ExpectedBuildUser
    if ([string]::Equals($supervisorSid, $buildSid, [StringComparison]::OrdinalIgnoreCase)) {
        Stop-IsolatedGuest 'trusted supervisor and uncredentialed build identities must be distinct'
    }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if ($Root -notmatch '^C:\\ProgramData\\AshAtlas\\IsolatedBatchValidator\\[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$' -or
        $Root -match '^(?:\\\\|[A-Za-z]:.*[\\/]{2})') {
        Stop-IsolatedGuest 'guest validator work root is not a fixed local path'
    }
    $secretNames = @(Get-ChildItem Env: | Where-Object {
            $_.Name -match '(?i)(?:HMAC|SECRET|TOKEN|PASSWORD|PRIVATE_KEY|SSH_AUTH_SOCK|AWS_ACCESS_KEY|AWS_SECRET|GITHUB_TOKEN|AZURE_CLIENT_SECRET)'
        })
    if ($secretNames.Count -gt 0) { Stop-IsolatedGuest 'guest environment contains a release credential or secret variable' }
    $uncDrives = @(Get-PSDrive -PSProvider FileSystem | Where-Object { [string]$_.Root -match '^\\\\' })
    if ($uncDrives.Count -gt 0) { Stop-IsolatedGuest 'guest validator has a mapped host or network file-system drive' }
    $env:ASH_ATLAS_ISOLATED_VALIDATOR = '1'
    $env:ASH_ATLAS_VALIDATOR_CONTRACT = 'ash-atlas-isolated-uncredentialed-vm/v1'
    if ($env:ASH_ATLAS_ISOLATED_VALIDATOR -cne '1' -or
        $env:ASH_ATLAS_VALIDATOR_CONTRACT -cne 'ash-atlas-isolated-uncredentialed-vm/v1') {
        Stop-IsolatedGuest 'guest validator positive environment marker could not be established'
    }
    return [pscustomobject][ordered]@{
        supervisor_user = [Environment]::UserName
        build_user = $ExpectedBuildUser
        trusted_supervisor = $true
        build_processes_observed = $false
        standard_user = $false
        positive_environment = $true
        no_host_mounts = $true
        no_secrets = $true
    }
}

function Assert-GuestProtectedOutput {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$BuildUser
    )
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { Stop-IsolatedGuest "protected guest output directory is missing: $Path" }
    $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    if (-not [bool]$acl.AreAccessRulesProtected) { Stop-IsolatedGuest "protected guest output ACL is inheriting: $Path" }
    if ([string]$acl.AccessToString -match [Regex]::Escape($BuildUser)) {
        Stop-IsolatedGuest "guest build identity can modify protected output: $Path"
    }
}

function Assert-GuestRepositoryAcl {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$BuildUser
    )
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { Stop-IsolatedGuest "provisioned guest repository is missing: $Path" }
    $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    if (-not [bool]$acl.AreAccessRulesProtected -or [string]$acl.AccessToString -notmatch [Regex]::Escape($BuildUser)) {
        Stop-IsolatedGuest 'provisioned guest repository ACL does not retain the pinned build identity'
    }
}

function Get-GuestProcessUserName {
    param([Parameter(Mandatory = $true)][int]$ProcessId)
    try {
        $process = Get-Process -Id $ProcessId -IncludeUserName -ErrorAction Stop
        $userName = [string](Get-GuestProperty $process 'UserName' '')
        if ($userName) { return $userName }
    } catch { }
    Stop-IsolatedGuest "could not independently observe the guest gate process identity: $ProcessId"
}

function Get-GuestIdentitySid {
    param([Parameter(Mandatory = $true)][string]$Identity)
    if ([string]::IsNullOrWhiteSpace($Identity)) { Stop-IsolatedGuest 'guest process identity is empty' }
    $candidates = New-Object 'System.Collections.Generic.List[string]'
    [void]$candidates.Add($Identity)
    if ($Identity -notmatch '[\\/]' -and $Identity -notmatch '@') {
        foreach ($machineName in @([string]$env:COMPUTERNAME, [string][Environment]::MachineName)) {
            if ($machineName) { [void]$candidates.Add("$machineName\$Identity") }
        }
    }
    foreach ($candidate in $candidates) {
        try {
            $account = New-Object Security.Principal.NTAccount($candidate)
            $sid = $account.Translate([Security.Principal.SecurityIdentifier])
            return [string]$sid.Value
        } catch { }
    }
    Stop-IsolatedGuest "could not resolve guest process identity to a SID: $Identity"
}

function Test-GuestIdentityEqual {
    param(
        [Parameter(Mandatory = $true)][string]$Left,
        [Parameter(Mandatory = $true)][string]$Right
    )
    try {
        return [string]::Equals((Get-GuestIdentitySid $Left), (Get-GuestIdentitySid $Right), [StringComparison]::OrdinalIgnoreCase)
    } catch {
        return $false
    }
}

function Get-GuestCredentialParts {
    param([Parameter(Mandatory = $true)][PSCredential]$Credential)
    $userName = [string]$Credential.UserName
    if ($userName -match '^(?<domain>[^\\/]+)[\\/](?<user>[^\\/]+)$') {
        return [pscustomobject]@{ domain = $Matches.domain; user = $Matches.user }
    }
    return [pscustomobject]@{ domain = ''; user = $userName }
}

function Assert-GuestBuildAccountStandard {
    param(
        [Parameter(Mandatory = $true)][PSCredential]$BuildCredential,
        [Parameter(Mandatory = $true)][string]$ExpectedBuildUser
    )
    if (-not (Test-GuestIdentityEqual ([string]$BuildCredential.UserName) $ExpectedBuildUser)) { Stop-IsolatedGuest 'guest build credential is not the pinned account' }
    $parts = Get-GuestCredentialParts $BuildCredential
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = 'powershell.exe'
    $probe = '$i=[Security.Principal.WindowsIdentity]::GetCurrent();$p=[Security.Principal.WindowsPrincipal]::new($i);Start-Sleep -Milliseconds 250;if($p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){exit 42};exit 0'
    $info.Arguments = (@('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', (ConvertTo-GuestNativeArgument $probe)) -join ' ')
    $info.UserName = $parts.user
    $info.Domain = $parts.domain
    $info.Password = $BuildCredential.Password
    $info.LoadUserProfile = $true
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    foreach ($variableName in @($info.EnvironmentVariables.Keys)) {
        if ([string]$variableName -match '(?i)(?:HMAC|SECRET|TOKEN|PASSWORD|PRIVATE_KEY|SSH_AUTH_SOCK|AWS_ACCESS_KEY|AWS_SECRET|GITHUB_TOKEN|AZURE_CLIENT_SECRET)') {
            $info.EnvironmentVariables.Remove([string]$variableName)
        }
    }
    $info.EnvironmentVariables['ASH_ATLAS_ISOLATED_VALIDATOR'] = '1'
    $info.EnvironmentVariables['ASH_ATLAS_VALIDATOR_CONTRACT'] = 'ash-atlas-isolated-uncredentialed-vm/v1'
    $info.EnvironmentVariables['ASH_ATLAS_VALIDATOR_BUILD_USER'] = $ExpectedBuildUser
    $probeProcess = [Diagnostics.Process]::new()
    $probeProcess.StartInfo = $info
    try {
        if (-not $probeProcess.Start()) { Stop-IsolatedGuest 'could not start guest standard-identity probe' }
        $observedUser = Get-GuestProcessUserName $probeProcess.Id
        if (-not (Test-GuestIdentityEqual $observedUser ([string]$BuildCredential.UserName)) -and
            -not (Test-GuestIdentityEqual $observedUser $ExpectedBuildUser)) {
            Stop-IsolatedGuest 'guest standard-identity probe ran under an unexpected account'
        }
        if (-not $probeProcess.WaitForExit(15000)) {
            Stop-GuestProcessTree $probeProcess
            Stop-IsolatedGuest 'guest standard-identity probe exceeded its deadline'
        }
        if ($probeProcess.ExitCode -ne 0) { Stop-IsolatedGuest 'pinned guest build account is an administrator' }
    } finally {
        $probeProcess.Dispose()
    }
}

function Grant-GuestBuildWorktreeAccess {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$BuildUser
    )
    $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    $acl.SetAccessRuleProtection($true, $false)
    $rights = [Security.AccessControl.FileSystemRights]::Modify
    $inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($BuildUser, $rights, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
    $acl.SetAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $acl -ErrorAction Stop
    $updated = [string](Get-Acl -LiteralPath $Path -ErrorAction Stop).AccessToString
    if ($updated -notmatch [Regex]::Escape($BuildUser)) { Stop-IsolatedGuest 'guest browser worktree did not receive the pinned build ACL' }
}

function Get-GuestGateNames {
    return @(
        'git_diff_check', 'repository_hygiene', 'workspace_install', 'focused_candidate_admission',
        'changed_file_lint', 'client_affected_tests', 'server_affected_tests', 'shared_affected_tests',
        'client_typecheck', 'server_typecheck', 'shared_typecheck', 'disposable_postgres_matrix',
        'client_production_build', 'server_production_build', 'server_build_verify',
        'combined_disposable_browser_acceptance'
    )
}

function Assert-GuestRequest {
    param([Parameter(Mandatory = $true)]$Request)
    if ([int](Get-GuestProperty $Request 'schema_version' 0) -ne 1 -or
        [string](Get-GuestProperty $Request 'kind' '') -cne 'ash-atlas-isolated-batch-validation-request' -or
        [string](Get-GuestProperty $Request 'validator_contract' '') -cne 'ash-atlas-isolated-uncredentialed-vm/v1') {
        Stop-IsolatedGuest 'guest validator request schema or contract is unsupported'
    }
    if ([string](Get-GuestProperty $Request 'operation_id' '') -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$' -or
        [string](Get-GuestProperty $Request 'operation_id' '') -match '(?:\.\.|[.]$|/$)') {
        Stop-IsolatedGuest 'guest validator operation ID is unsafe'
    }
    foreach ($field in @('candidate_sha', 'baseline_sha', 'tooling_sha')) {
        if ([string](Get-GuestProperty $Request $field '') -notmatch '^[0-9a-f]{40}$') { Stop-IsolatedGuest "guest request $field is not canonical" }
    }
    foreach ($field in @('manifest_sha256', 'validation_plan_sha256', 'validation_toolchain_fingerprint')) {
        if ([string](Get-GuestProperty $Request $field '') -notmatch '^[0-9a-f]{64}$') { Stop-IsolatedGuest "guest request $field is not canonical" }
    }
    $plan = Get-GuestProperty $Request 'plan' $null
    $gates = @((Get-GuestProperty $plan 'gates' @()))
    if ($gates.Count -eq 0 -or $gates.Count -gt 64) { Stop-IsolatedGuest 'guest request gate count is invalid' }
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    $allowed = @(Get-GuestGateNames)
    $baseline = [string](Get-GuestProperty $Request 'baseline_sha' '')
    $candidate = [string](Get-GuestProperty $Request 'candidate_sha' '')
    foreach ($gate in $gates) {
        $name = [string](Get-GuestProperty $gate 'name' '')
        $file = [string](Get-GuestProperty $gate 'file_path' '')
        $arguments = @((Get-GuestProperty $gate 'arguments' @()) | ForEach-Object { [string]$_ })
        if ($name -notin $allowed -or -not $seen.Add($name)) { Stop-IsolatedGuest "guest request has an unexpected or duplicate gate: $name" }
        if ([int](Get-GuestProperty $gate 'deadline_seconds' 0) -lt 1 -or [int](Get-GuestProperty $gate 'deadline_seconds' 0) -gt 7200) { Stop-IsolatedGuest "guest gate deadline is invalid: $name" }
        switch ($name) {
            'git_diff_check' { if ($file -cne 'git' -or $arguments.Count -ne 4 -or $arguments[0] -cne 'diff' -or $arguments[1] -cne '--check' -or $arguments[2] -cne $baseline -or $arguments[3] -cne $candidate) { Stop-IsolatedGuest 'guest git diff gate is unexpected' } }
            'repository_hygiene' { if ($file -cne 'pnpm.cmd' -or ($arguments -join [char]0x1f) -cne 'check:hygiene') { Stop-IsolatedGuest 'guest repository hygiene gate is unexpected' } }
            'workspace_install' { if ($file -cne 'pnpm.cmd' -or ($arguments -join [char]0x1f) -cne "install$([char]0x1f)--frozen-lockfile") { Stop-IsolatedGuest 'guest workspace install gate is unexpected' } }
            'changed_file_lint' {
                if ($file -cne 'pnpm.cmd' -or $arguments.Count -lt 4 -or $arguments[0] -cne 'exec' -or $arguments[1] -cne 'eslint' -or $arguments[2] -cne '--') { Stop-IsolatedGuest 'guest lint gate is unexpected' }
                foreach ($path in @($arguments | Select-Object -Skip 3)) { if (-not (Test-GuestRelativePath $path)) { Stop-IsolatedGuest 'guest lint path is unsafe' } }
            }
            { $_ -in @('client_affected_tests', 'server_affected_tests', 'shared_affected_tests') } {
                $package = switch ($name) { 'client_affected_tests' { '@ash-atlas/client' } 'server_affected_tests' { '@ash-atlas/server' } default { '@ash-atlas/shared' } }
                if ($file -cne 'pnpm.cmd' -or ($arguments -join [char]0x1f) -cne "--filter$([char]0x1f)$package$([char]0x1f)test") { Stop-IsolatedGuest "$name gate is unexpected" }
            }
            { $_ -in @('client_typecheck', 'server_typecheck', 'shared_typecheck') } {
                $package = switch ($name) { 'client_typecheck' { '@ash-atlas/client' } 'server_typecheck' { '@ash-atlas/server' } default { '@ash-atlas/shared' } }
                if ($file -cne 'pnpm.cmd' -or ($arguments -join [char]0x1f) -cne "--filter$([char]0x1f)$package$([char]0x1f)typecheck") { Stop-IsolatedGuest "$name gate is unexpected" }
            }
            'disposable_postgres_matrix' { if ($file -cne 'pnpm.cmd' -or ($arguments -join [char]0x1f) -cne 'test:postgres') { Stop-IsolatedGuest 'guest PostgreSQL gate is unexpected' } }
            'client_production_build' { if ($file -cne 'pnpm.cmd' -or ($arguments -join [char]0x1f) -cne "--filter$([char]0x1f)@ash-atlas/client$([char]0x1f)build") { Stop-IsolatedGuest 'guest client build gate is unexpected' } }
            'server_production_build' { if ($file -cne 'pnpm.cmd' -or ($arguments -join [char]0x1f) -cne "--filter$([char]0x1f)@ash-atlas/server$([char]0x1f)build") { Stop-IsolatedGuest 'guest server build gate is unexpected' } }
            'server_build_verify' { if ($file -cne 'pnpm.cmd' -or ($arguments -join [char]0x1f) -cne "--filter$([char]0x1f)@ash-atlas/server$([char]0x1f)build:verify") { Stop-IsolatedGuest 'guest server build verification gate is unexpected' } }
            'focused_candidate_admission' {
                if ($file -cne 'powershell.exe' -or $arguments.Count -ne 5 -or $arguments[0] -cne '-NoProfile' -or $arguments[1] -cne '-ExecutionPolicy' -or $arguments[2] -cne 'Bypass' -or $arguments[3] -cne '-Command' -or [string](Get-GuestProperty $gate 'binding_sha' '') -cne $candidate -or [string]::IsNullOrWhiteSpace($arguments[4]) -or $arguments[4] -match '(?i)(?:[A-Za-z]:[\\/]|\\\\|Invoke-WebRequest|Start-BitsTransfer|ConvertFrom-SecureString|HMAC|SECRET|TOKEN|PASSWORD)') { Stop-IsolatedGuest 'guest admission command is not portable' }
            }
            'combined_disposable_browser_acceptance' { if ($file -cne 'internal' -or $arguments.Count -ne 1 -or $arguments[0] -cne 'Invoke-BatchBrowserAcceptance:v1') { Stop-IsolatedGuest 'guest browser gate is unexpected' } }
        }
    }
    return $gates
}

function Get-GuestBundleAdvertisedRef {
    param(
        [Parameter(Mandatory = $true)][string]$Repository,
        [Parameter(Mandatory = $true)][string]$BundlePath,
        [Parameter(Mandatory = $true)][string]$ExpectedSha,
        [Parameter(Mandatory = $true)][string]$ExpectedRef,
        [Parameter(Mandatory = $true)][string]$Label
    )
    $verify = Invoke-GuestTrustedCommand 'git.exe' @('-C', $Repository, 'bundle', 'verify', $BundlePath) $Repository 120
    if ($verify.output_overflow -or [int]$verify.exit_code -ne 0) { Stop-IsolatedGuest "$Label guest bundle failed git verification" }
    $heads = Invoke-GuestTrustedCommand 'git.exe' @('-C', $Repository, 'bundle', 'list-heads', $BundlePath) $Repository 120
    if ($heads.output_overflow -or [int]$heads.exit_code -ne 0) { Stop-IsolatedGuest "$Label guest bundle head listing failed" }
    $headPattern = [regex]::new('^(?<sha>[0-9a-f]{40})\s+(?<ref>\S+)$')
    $advertisedMatches = @()
    foreach ($line in @($heads.stdout -split "`r?`n")) {
        $headMatch = $headPattern.Match(([string]$line).Trim())
        if ($headMatch.Success -and $headMatch.Groups['sha'].Value -ceq $ExpectedSha) {
            $advertisedMatches += [pscustomobject]@{
                sha = $headMatch.Groups['sha'].Value
                ref = $headMatch.Groups['ref'].Value
            }
        }
    }
    if ($advertisedMatches.Count -ne 1 -or
        [string]$advertisedMatches[0].ref -cne $ExpectedRef) {
        Stop-IsolatedGuest "$Label guest bundle does not advertise the exact authenticated named ref"
    }
    return [string]$advertisedMatches[0].ref
}

function ConvertTo-GuestNativeArgument {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)
    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
}

function ConvertTo-GuestSingleQuotedLiteral {
    param([Parameter(Mandatory = $true)][string]$Value)
    return "'" + $Value.Replace("'", "''") + "'"
}

function Get-GuestRuntimeWorktreeRoot {
    param(
        [Parameter(Mandatory = $true)][string]$Repository,
        [Parameter(Mandatory = $true)][string]$OperationId
    )
    $defaultsPath = Join-Path $Repository 'config\dev-runtime.defaults.json'
    if (-not (Test-Path -LiteralPath $defaultsPath -PathType Leaf)) {
        Stop-IsolatedGuest 'guest browser runtime defaults are missing from the exact candidate checkout'
    }
    try { $defaults = Get-Content -Raw -LiteralPath $defaultsPath | ConvertFrom-Json -ErrorAction Stop }
    catch { Stop-IsolatedGuest 'guest browser runtime defaults are not valid JSON' }
    $configuredRoot = Get-GuestFullPath ([string](Get-GuestProperty $defaults 'feature_worktree_root' ''))
    $canonicalRoot = Get-GuestFullPath 'C:\Users\dev\Documents\worktrees'
    if (-not [string]::Equals($configuredRoot, $canonicalRoot, [StringComparison]::OrdinalIgnoreCase)) {
        Stop-IsolatedGuest 'guest browser runtime defaults do not use the pinned feature worktree root'
    }
    $configuredLauncherRoot = Get-GuestFullPath ([string](Get-GuestProperty $defaults 'feature_launcher_root' ''))
    $canonicalLauncherRoot = Get-GuestFullPath 'C:\Users\dev\Documents\Ash Atlas Feature Launchers'
    if (-not [string]::Equals($configuredLauncherRoot, $canonicalLauncherRoot, [StringComparison]::OrdinalIgnoreCase)) {
        Stop-IsolatedGuest 'guest browser runtime defaults do not use the pinned feature launcher root'
    }
    if (-not (Test-Path -LiteralPath $canonicalRoot -PathType Container)) {
        New-Item -ItemType Directory -Path $canonicalRoot -Force | Out-Null
    }
    Assert-GuestNoReparsePath $canonicalRoot $canonicalRoot
    $safeOperationId = ($OperationId -replace '[^A-Za-z0-9._-]', '-')
    $safeOperationId = $safeOperationId.Trim('.','-')
    if (-not $safeOperationId) { Stop-IsolatedGuest 'guest browser runtime operation ID is empty after canonicalization' }
    $worktree = Join-Path $canonicalRoot "isolated-batch-$safeOperationId"
    if (Test-Path -LiteralPath $worktree) {
        Stop-IsolatedGuest "guest browser runtime worktree already exists: $worktree"
    }
    return $worktree
}

function Assert-GuestRuntimeLauncherDirectory {
    param([Parameter(Mandatory = $true)][string]$BuildUser)
    $launcherProfileRoot = Get-GuestFullPath 'C:\Users\dev'
    $launcherRoot = Get-GuestFullPath 'C:\Users\dev\Documents\Ash Atlas Feature Launchers'
    if (-not (Test-Path -LiteralPath $launcherRoot -PathType Container)) {
        Stop-IsolatedGuest 'pinned guest feature launcher directory is missing'
    }
    Assert-GuestNoReparsePath $launcherRoot $launcherProfileRoot
    $launcherAcl = Get-Acl -LiteralPath $launcherRoot -ErrorAction Stop
    $modify = [Security.AccessControl.FileSystemRights]::Modify
    $launcherBuildRules = @($launcherAcl.Access | Where-Object {
        [string]$_.AccessControlType -ceq 'Allow' -and
        [string]$_.IdentityReference -match [Regex]::Escape($BuildUser) -and
        (([Security.AccessControl.FileSystemRights]$_.FileSystemRights -band $modify) -eq $modify)
    })
    if (-not [bool]$launcherAcl.AreAccessRulesProtected -or
        $launcherBuildRules.Count -ne 1 -or
        [string]$launcherAcl.AccessToString -match '(?im)(^|;)\s*(Everyone|BUILTIN\\Users|NT AUTHORITY\\Authenticated Users)\s+') {
        Stop-IsolatedGuest 'pinned guest feature launcher ACL is not limited to the trusted and build identities'
    }
}

function Materialize-GuestRuntimeWorktree {
    param(
        [Parameter(Mandatory = $true)][string]$Repository,
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$CandidateSha,
        [Parameter(Mandatory = $true)][string]$OperationId,
        [Parameter(Mandatory = $true)][string]$BuildUser
    )
    $worktree = Get-GuestRuntimeWorktreeRoot $Repository $OperationId
    $safeOperationId = (Split-Path -Leaf $worktree).Substring('isolated-batch-'.Length)
    $branch = "fix/isolated-batch-$safeOperationId"
    & git -C $Repository worktree add --quiet -b $branch $worktree $CandidateSha
    if ($LASTEXITCODE -ne 0) { Stop-IsolatedGuest 'guest browser runtime worktree creation failed' }
    Assert-GuestNoReparsePath $worktree (Split-Path -Parent $worktree)
    $actualBranch = [string](& git -C $worktree branch --show-current 2>$null)
    if ($LASTEXITCODE -ne 0 -or $actualBranch -cne $branch) { Stop-IsolatedGuest 'guest browser runtime worktree branch identity differs' }
    $actualHead = [string](& git -C $worktree rev-parse HEAD 2>$null)
    if ($LASTEXITCODE -ne 0 -or $actualHead -cne $CandidateSha) { Stop-IsolatedGuest 'guest browser runtime worktree commit identity differs' }
    Grant-GuestBuildWorktreeAccess $worktree $BuildUser
    $metadata = [pscustomobject][ordered]@{
        schema_version = 1
        kind = 'ash-atlas-isolated-browser-runtime-worktree'
        operation_id = $OperationId
        branch = $branch
        candidate_sha = $CandidateSha
        worktree = $worktree
    }
    [IO.File]::WriteAllText((Join-Path $Root 'input\runtime-worktree.json'), ($metadata | ConvertTo-Json -Depth 8) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    return [pscustomobject][ordered]@{ branch = $branch; worktree = $worktree }
}

function Get-GuestBrowserAcceptanceCommand {
    param([Parameter(Mandatory = $true)][string]$Repository)
    $featureRuntime = Join-Path $Repository 'tools\dev\feature-runtime.ps1'
    $runMain = Join-Path $Repository 'tools\dev\run-main.ps1'
    if (-not (Test-Path -LiteralPath $featureRuntime -PathType Leaf) -or
        -not (Test-Path -LiteralPath $runMain -PathType Leaf)) {
        Stop-IsolatedGuest 'guest browser gate tooling is missing from the exact candidate checkout'
    }
    $featureRuntimeLiteral = ConvertTo-GuestSingleQuotedLiteral $featureRuntime
    $runMainLiteral = ConvertTo-GuestSingleQuotedLiteral $runMain
    $worktreeLiteral = ConvertTo-GuestSingleQuotedLiteral $Repository
    $displayLiteral = ConvertTo-GuestSingleQuotedLiteral ("Batch Release $script:GuestOperationId")
    return @(
        '$ErrorActionPreference = ''Stop'''
        "`$featureRuntime = $featureRuntimeLiteral"
        "`$runMain = $runMainLiteral"
        "`$worktree = $worktreeLiteral"
        "`$display = $displayLiteral"
        '$registered = $false'
        'try {'
        '& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $featureRuntime create -WorktreePath $worktree -DisplayName $display'
        'if ($LASTEXITCODE -ne 0) { throw ''could not register the disposable guest batch runtime'' }'
        '$registered = $true'
        '$validated = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $runMain -RuntimeMode Feature -WorktreePath $worktree -ValidateOnly 2>&1)'
        'if ($LASTEXITCODE -ne 0) { throw "guest batch runtime validation failed: $($validated -join [Environment]::NewLine)" }'
        '$runtime = ($validated -join [Environment]::NewLine) | ConvertFrom-Json'
        'try {'
        '& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $runMain -RuntimeMode Feature -WorktreePath $worktree -NoBrowser'
        'if ($LASTEXITCODE -ne 0) { throw ''disposable guest batch runtime failed to start'' }'
        '$env:ASH_ATLAS_TEST_BASE_URL = "http://127.0.0.1:$($runtime.ports.frontend)"'
        '& pnpm.cmd --dir $worktree --filter ''@ash-atlas/client'' test:full-app'
        'if ($LASTEXITCODE -ne 0) { throw ''combined disposable guest browser acceptance failed'' }'
        '} finally {'
        'Remove-Item Env:\ASH_ATLAS_TEST_BASE_URL -ErrorAction SilentlyContinue'
        '& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $runMain -RuntimeMode Feature -WorktreePath $worktree -Stop'
        '}'
        '} finally {'
        'if ($registered) {'
        '& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $featureRuntime remove -WorktreePath $worktree'
        'if ($LASTEXITCODE -ne 0) { throw ''could not remove the disposable guest batch runtime'' }'
        '}'
        '}'
    ) -join '; '
}

function Stop-GuestProcessTree {
    param([Parameter(Mandatory = $true)][Diagnostics.Process]$Process)
    try { & taskkill.exe /PID $Process.Id /T /F *> $null } catch {
        try { if (-not $Process.HasExited) { $Process.Kill() } } catch { }
    }
    try { $Process.WaitForExit(5000) | Out-Null } catch { }
}

function Invoke-GuestTrustedCommand {
    param(
        [Parameter(Mandatory = $true)][string]$FileName,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][int]$TimeoutSeconds
    )
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $FileName
    $startInfo.Arguments = (@($Arguments | ForEach-Object { ConvertTo-GuestNativeArgument $_ }) -join ' ')
    $startInfo.WorkingDirectory = $WorkingDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    $capture = $null
    try {
        if (-not $process.Start()) { Stop-IsolatedGuest "could not start trusted guest command: $FileName" }
        $capture = [AshAtlas.IsolatedBatchValidator.BoundedStreamCapture]::Start($process, $script:MaxLogBytes)
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            Stop-GuestProcessTree $process
            Stop-IsolatedGuest "trusted guest command exceeded its deadline: $FileName"
        }
        if (-not $capture.Wait(5000)) {
            Stop-IsolatedGuest "trusted guest command streams did not reach EOF: $FileName"
        }
        $stdout = $capture.StdoutTask.Result
        $stderr = $capture.StderrTask.Result
        return [pscustomobject][ordered]@{
            exit_code = [int]$process.ExitCode
            stdout = [string]$stdout.Text
            stderr = [string]$stderr.Text
            output_overflow = [bool]($stdout.Overflow -or $stderr.Overflow)
        }
    } finally {
        if ($null -ne $capture) { try { $capture.Wait(5000) | Out-Null } catch { } }
        $process.Dispose()
    }
}

function Write-GuestBoundedText {
    param([Parameter(Mandatory = $true)][string]$Path, [AllowEmptyString()][string]$Text)
    $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
    $truncated = $bytes.Length -gt $script:MaxLogBytes
    if ($truncated) {
        $bounded = [byte[]]::new($script:MaxLogBytes)
        [Array]::Copy($bytes, $bounded, $script:MaxLogBytes)
        $bytes = $bounded
    }
    [IO.File]::WriteAllBytes($Path, $bytes)
    return $truncated
}

function Invoke-GuestGate {
    param(
        [Parameter(Mandatory = $true)]$Gate,
        [Parameter(Mandatory = $true)][string]$Repository,
        [Parameter(Mandatory = $true)][string]$LogBase,
        [Parameter(Mandatory = $true)][PSCredential]$BuildCredential,
        [Parameter(Mandatory = $true)][string]$ExpectedBuildUser
    )
    $file = [string](Get-GuestProperty $Gate 'file_path' '')
    $arguments = @((Get-GuestProperty $Gate 'arguments' @()) | ForEach-Object { [string]$_ })
    $name = [string](Get-GuestProperty $Gate 'name' '')
    if ($file -ceq 'internal') {
        $file = 'powershell.exe'
        $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', (Get-GuestBrowserAcceptanceCommand $Repository))
    }
    if ($name -eq 'focused_candidate_admission') {
        $env:ASH_ATLAS_ADMISSION_SHA = [string]$script:GuestCandidateSha
        $env:ASH_ATLAS_ADMISSION_CWD = $Repository
    }
    $nativeFile = $file
    $nativeArguments = @($arguments)
    if ($file -match '(?i)\.(?:cmd|bat)$') {
        $commandLine = (ConvertTo-GuestNativeArgument $file) + ' ' + (@($arguments | ForEach-Object { ConvertTo-GuestNativeArgument $_ }) -join ' ')
        $nativeFile = 'cmd.exe'
        $nativeArguments = @('/d', '/s', '/c', $commandLine)
    }
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $nativeFile
    $startInfo.Arguments = (@($nativeArguments | ForEach-Object { ConvertTo-GuestNativeArgument $_ }) -join ' ')
    $startInfo.WorkingDirectory = $Repository
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $credentialParts = Get-GuestCredentialParts $BuildCredential
    $startInfo.UserName = $credentialParts.user
    $startInfo.Domain = $credentialParts.domain
    $startInfo.Password = $BuildCredential.Password
    $startInfo.LoadUserProfile = $true
    foreach ($variableName in @($startInfo.EnvironmentVariables.Keys)) {
        if ([string]$variableName -match '(?i)(?:HMAC|SECRET|TOKEN|PASSWORD|PRIVATE_KEY|SSH_AUTH_SOCK|AWS_ACCESS_KEY|AWS_SECRET|GITHUB_TOKEN|AZURE_CLIENT_SECRET)') {
            $startInfo.EnvironmentVariables.Remove([string]$variableName)
        }
    }
    $startInfo.EnvironmentVariables['ASH_ATLAS_ISOLATED_VALIDATOR'] = '1'
    $startInfo.EnvironmentVariables['ASH_ATLAS_VALIDATOR_CONTRACT'] = 'ash-atlas-isolated-uncredentialed-vm/v1'
    $startInfo.EnvironmentVariables['ASH_ATLAS_VALIDATOR_BUILD_USER'] = $ExpectedBuildUser
    $startInfo.EnvironmentVariables['GIT_CONFIG_COUNT'] = '1'
    $startInfo.EnvironmentVariables['GIT_CONFIG_KEY_0'] = 'safe.directory'
    $startInfo.EnvironmentVariables['GIT_CONFIG_VALUE_0'] = $Repository
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    $startedAt = Get-Date
    $capture = $null
    try {
        if (-not $process.Start()) { throw "could not start guest gate $name" }
        $capture = [AshAtlas.IsolatedBatchValidator.BoundedStreamCapture]::Start($process, $script:MaxLogBytes)
        try {
            $observedUser = Get-GuestProcessUserName $process.Id
            if (-not (Test-GuestIdentityEqual $observedUser ([string]$BuildCredential.UserName)) -and
                -not (Test-GuestIdentityEqual $observedUser $ExpectedBuildUser)) {
                Stop-IsolatedGuest "guest gate $name was not owned by the pinned standard build identity"
            }
        } catch {
            Stop-GuestProcessTree $process
            throw
        }
        $deadline = [int](Get-GuestProperty $Gate 'deadline_seconds' 0)
        if (-not $process.WaitForExit($deadline * 1000)) {
            Stop-GuestProcessTree $process
            throw "guest gate $name exceeded its deadline"
        }
        if (-not $capture.Wait(5000)) { throw "guest gate $name output capture did not reach EOF" }
        $stdoutResult = $capture.StdoutTask.Result
        $stderrResult = $capture.StderrTask.Result
        $stdout = [string]$stdoutResult.Text
        $stderr = [string]$stderrResult.Text
        $stdoutTruncated = Write-GuestBoundedText "$LogBase.stdout.log" $stdout
        $stderrTruncated = Write-GuestBoundedText "$LogBase.stderr.log" $stderr
        $combinedTruncated = Write-GuestBoundedText "$LogBase.log" ($stdout + [Environment]::NewLine + $stderr)
        if ($stdoutResult.Overflow -or $stderrResult.Overflow -or $stdoutTruncated -or $stderrTruncated -or $combinedTruncated) { throw "guest gate $name produced output over the bounded log limit" }
        return [pscustomobject][ordered]@{
            name = $name
            candidate_sha = [string]$script:GuestCandidateSha
            exit_code = [int]$process.ExitCode
            stdout_sha256 = Get-GuestFileSha256 "$LogBase.stdout.log"
            stderr_sha256 = Get-GuestFileSha256 "$LogBase.stderr.log"
            log_sha256 = Get-GuestFileSha256 "$LogBase.log"
            duration_ms = [int]((Get-Date) - $startedAt).TotalMilliseconds
        }
    } finally {
        if ($name -eq 'focused_candidate_admission') {
            Remove-Item Env:\ASH_ATLAS_ADMISSION_SHA -ErrorAction SilentlyContinue
            Remove-Item Env:\ASH_ATLAS_ADMISSION_CWD -ErrorAction SilentlyContinue
        }
        if ($null -ne $capture) { try { $capture.Wait(5000) | Out-Null } catch { } }
        $process.Dispose()
    }
}

function Invoke-IsolatedBatchValidatorGuest {
    param(
        [Parameter(Mandatory = $true)][string]$RequestPath,
        [Parameter(Mandatory = $true)][string]$ReceiptPath,
        [Parameter(Mandatory = $true)][string]$WorkRoot,
        [Parameter(Mandatory = $true)][string]$ExpectedSupervisorUser,
        [Parameter(Mandatory = $true)][string]$ExpectedBuildUser,
        [Parameter(Mandatory = $true)][PSCredential]$BuildCredential
    )
    $root = Get-GuestFullPath $WorkRoot
    if (-not (Test-GuestUnderRoot $RequestPath $root) -or -not (Test-GuestUnderRoot $ReceiptPath $root)) { Stop-IsolatedGuest 'guest request and receipt paths must stay under the fixed work root' }
    if (-not (Test-Path -LiteralPath $RequestPath -PathType Leaf)) { Stop-IsolatedGuest 'guest validator request is missing' }
    New-Item -ItemType Directory -Path (Split-Path -Parent $ReceiptPath) -Force | Out-Null
    $logRoot = Join-Path $root 'output\logs'
    New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
    Assert-GuestNoReparsePath $root $root
    Assert-GuestNoReparsePath $RequestPath $root
    $identity = Assert-GuestIdentity $ExpectedSupervisorUser $ExpectedBuildUser $root
    Assert-GuestProtectedOutput (Split-Path -Parent $ReceiptPath) $ExpectedBuildUser
    Assert-GuestProtectedOutput $logRoot $ExpectedBuildUser
    Assert-GuestBuildAccountStandard $BuildCredential $ExpectedBuildUser
    Assert-GuestRuntimeLauncherDirectory $ExpectedBuildUser
    $request = Read-GuestJson $RequestPath
    $gates = Assert-GuestRequest $request
    $bundleRoot = Split-Path -Parent $RequestPath
    $baselineBundle = Join-Path $bundleRoot 'baseline.bundle'
    $candidateBundle = Join-Path $bundleRoot 'candidate.bundle'
    if (-not (Test-Path -LiteralPath $baselineBundle -PathType Leaf) -or -not (Test-Path -LiteralPath $candidateBundle -PathType Leaf)) { Stop-IsolatedGuest 'guest validator bundles are missing beside the exact request' }
    $bundles = Get-GuestProperty $request 'bundles' $null
    $repository = Join-Path $root 'repo'
    Assert-GuestRepositoryAcl $repository $ExpectedBuildUser
    Assert-GuestNoReparsePath $repository $root
    if (@(Get-ChildItem -LiteralPath $repository -Force -ErrorAction Stop).Count -ne 0) {
        Stop-IsolatedGuest 'provisioned guest repository must be empty before Git initialization'
    }
    & git init --quiet $repository
    if ($LASTEXITCODE -ne 0) { Stop-IsolatedGuest 'guest repository initialization failed' }
    $bundleRefs = @{}
    foreach ($entry in @(@{ key = 'baseline'; file = $baselineBundle; sha = [string](Get-GuestProperty $request 'baseline_sha' '') }, @{ key = 'candidate'; file = $candidateBundle; sha = [string](Get-GuestProperty $request 'candidate_sha' '') })) {
        $bundle = Get-GuestProperty $bundles $entry.key $null
        if ([string](Get-GuestProperty $bundle 'path' '') -notmatch '(?i)(?:^|[\\/])' + [Regex]::Escape((Split-Path -Leaf $entry.file)) + '$' -or
            [string](Get-GuestProperty $bundle 'sha' '') -cne $entry.sha -or
            (Get-GuestFileSha256 $entry.file) -cne [string](Get-GuestProperty $bundle 'sha256' '')) { Stop-IsolatedGuest "$($entry.key) guest bundle identity differs from the request" }
        $operationId = [string](Get-GuestProperty $request 'operation_id' '')
        $expectedRef = "refs/ash-atlas/isolated-validation/$operationId/$($entry.key)"
        $bundleRefs[$entry.key] = Get-GuestBundleAdvertisedRef $repository $entry.file $entry.sha $expectedRef $entry.key
        $destination = "refs/validator/$($entry.key)"
        & git -C $repository fetch --no-tags --quiet $entry.file "$($bundleRefs[$entry.key]):$destination"
        if ($LASTEXITCODE -ne 0) { Stop-IsolatedGuest "$($entry.key) guest bundle import failed for its advertised named ref" }
    }
    & git -C $repository cat-file -e (([string](Get-GuestProperty $request 'baseline_sha' '')) + '^{commit}')
    if ($LASTEXITCODE -ne 0) { Stop-IsolatedGuest 'guest baseline bundle did not materialize its exact commit' }
    & git -C $repository cat-file -e (([string](Get-GuestProperty $request 'candidate_sha' '')) + '^{commit}')
    if ($LASTEXITCODE -ne 0) { Stop-IsolatedGuest 'guest candidate bundle did not materialize its exact commit' }
    & git -C $repository checkout --quiet --detach ([string](Get-GuestProperty $request 'candidate_sha' ''))
    if ($LASTEXITCODE -ne 0) { Stop-IsolatedGuest 'guest candidate checkout failed' }
    $script:GuestCandidateSha = [string](Get-GuestProperty $request 'candidate_sha' '')
    $script:GuestOperationId = [string](Get-GuestProperty $request 'operation_id' '')
    $runtimeWorktree = $null
    if (@($gates | Where-Object { [string](Get-GuestProperty $_ 'name' '') -ceq 'combined_disposable_browser_acceptance' }).Count -gt 0) {
        $runtimeWorktree = Materialize-GuestRuntimeWorktree $repository $root $script:GuestCandidateSha $script:GuestOperationId $ExpectedBuildUser
    }
    # The VM is discarded after the host retrieves the result. Do not run
    # privileged Git cleanup against candidate-writable metadata after gates.
    $receiptGates = @()
    for ($index = 0; $index -lt $gates.Count; $index++) {
        $gate = $gates[$index]
        $name = [string](Get-GuestProperty $gate 'name' '')
        $base = Join-Path $logRoot (('{0:D2}-{1}' -f $index, $name))
        try {
            $gateRepository = if ($name -ceq 'combined_disposable_browser_acceptance') { [string]$runtimeWorktree.worktree } else { $repository }
            $gateReceipt = Invoke-GuestGate $gate $gateRepository $base $BuildCredential $ExpectedBuildUser
        } catch {
            if (-not (Test-Path -LiteralPath "$base.stdout.log")) { Write-GuestBoundedText "$base.stdout.log" '' | Out-Null }
            if (-not (Test-Path -LiteralPath "$base.stderr.log")) { Write-GuestBoundedText "$base.stderr.log" $_.Exception.Message | Out-Null }
            if (-not (Test-Path -LiteralPath "$base.log")) { Write-GuestBoundedText "$base.log" $_.Exception.Message | Out-Null }
            $gateReceipt = [pscustomobject][ordered]@{ name = $name; candidate_sha = $script:GuestCandidateSha; exit_code = 1; stdout_sha256 = Get-GuestFileSha256 "$base.stdout.log"; stderr_sha256 = Get-GuestFileSha256 "$base.stderr.log"; log_sha256 = Get-GuestFileSha256 "$base.log"; duration_ms = 0 }
            $receiptGates += $gateReceipt
            break
        }
        $receiptGates += $gateReceipt
        $identity.build_processes_observed = $true
        if ([int]$gateReceipt.exit_code -ne 0) { break }
    }
    if ($receiptGates.Count -eq $gates.Count -and @($receiptGates | Where-Object { [int]$_.exit_code -ne 0 }).Count -eq 0) {
        $identity.standard_user = $true
    }
    $guestReceipt = [pscustomobject][ordered]@{
        schema_version = 1
        kind = 'ash-atlas-isolated-batch-validation-guest-result'
        operation_id = [string](Get-GuestProperty $request 'operation_id' '')
        candidate_sha = [string](Get-GuestProperty $request 'candidate_sha' '')
        baseline_sha = [string](Get-GuestProperty $request 'baseline_sha' '')
        identity = $identity
        gates = @($receiptGates)
        issued_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    }
    [IO.File]::WriteAllText($ReceiptPath, ($guestReceipt | ConvertTo-Json -Depth 16) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    if (@($receiptGates | Where-Object { [int]$_.exit_code -ne 0 }).Count -gt 0 -or $receiptGates.Count -ne $gates.Count) {
        throw 'one or more required guest validation gates failed'
    }
    return $guestReceipt
}

if ($MyInvocation.InvocationName -ne '.') {
    if (-not $RequestPath -or -not $ReceiptPath -or -not $WorkRoot -or
        -not $ExpectedSupervisorUser -or -not $ExpectedBuildUser -or $null -eq $BuildCredential) {
        Stop-IsolatedGuest 'guest validator requires its fixed request, receipt, work root, distinct identities, and build credential'
    }
    Invoke-IsolatedBatchValidatorGuest -RequestPath $RequestPath -ReceiptPath $ReceiptPath -WorkRoot $WorkRoot `
        -ExpectedSupervisorUser $ExpectedSupervisorUser -ExpectedBuildUser $ExpectedBuildUser -BuildCredential $BuildCredential | Out-Null
}
