[CmdletBinding()]
param(
    [string]$RequestPath,
    [string]$ReceiptPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# This file is installed in the ACL-protected validator directory.  The caller
# is deliberately not allowed to select a VM, checkpoint, guest script, or
# configuration file.  Provisioning changes this file's adjacent config and
# the Hyper-V guest, then records those identities in the config.
$script:ValidatorConfigPath = 'C:\ProgramData\AshAtlas\CoordinatedRelease\validator\isolated-batch-validator.json'
$script:GuestRunnerName = 'isolated-batch-validator-guest.ps1'
$script:MaxLogBytes = 4MB
$script:MaxRequestBytes = 8MB
$script:VmWaitSeconds = 120

function Stop-IsolatedBatchValidator {
    param([Parameter(Mandatory = $true)][string]$Message)
    throw "isolated batch validator: $Message"
}

function Get-IsolatedProperty {
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

function Get-IsolatedFullPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) {
        Stop-IsolatedBatchValidator 'a provisioned path is empty'
    }
    try { return [IO.Path]::GetFullPath($Path).TrimEnd('\') }
    catch { Stop-IsolatedBatchValidator "invalid provisioned path: $Path" }
}

function Test-IsolatedPathUnderRoot {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root
    )
    $fullPath = Get-IsolatedFullPath $Path
    $fullRoot = Get-IsolatedFullPath $Root
    return [string]::Equals($fullPath, $fullRoot, [StringComparison]::OrdinalIgnoreCase) -or
        $fullPath.StartsWith($fullRoot + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Assert-IsolatedNoReparsePath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root
    )
    $fullPath = Get-IsolatedFullPath $Path
    $fullRoot = Get-IsolatedFullPath $Root
    $itemPath = $fullPath
    while ($true) {
        $item = Get-Item -LiteralPath $itemPath -Force -ErrorAction Stop
        if (([IO.FileAttributes]$item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            Stop-IsolatedBatchValidator "validator path contains a reparse point: $itemPath"
        }
        if ([string]::Equals($itemPath, $fullRoot, [StringComparison]::OrdinalIgnoreCase)) { break }
        $parent = Split-Path -Parent $itemPath
        if (-not $parent -or [string]::Equals($parent, $itemPath, [StringComparison]::OrdinalIgnoreCase)) {
            Stop-IsolatedBatchValidator "validator path escaped its configured root: $fullPath"
        }
        $itemPath = $parent.TrimEnd('\')
        if (-not (Test-IsolatedPathUnderRoot $itemPath $fullRoot)) {
            Stop-IsolatedBatchValidator "validator path escaped its configured root: $fullPath"
        }
    }
}

function Assert-IsolatedAcl {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string[]]$RequiredPrincipals,
        [string]$Label = 'validator path'
    )
    $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    $aclText = [string]$acl.AccessToString
    foreach ($principal in @($RequiredPrincipals)) {
        if (-not $principal -or $aclText -notmatch [Regex]::Escape([string]$principal)) {
            Stop-IsolatedBatchValidator "$Label ACL does not name the provisioned principal $principal"
        }
    }
    if ($aclText -match '(?im)(^|;)\s*(Everyone|BUILTIN\\Users|NT AUTHORITY\\Authenticated Users)\s+') {
        Stop-IsolatedBatchValidator "$Label ACL grants access to a broad interactive principal"
    }
}

function Assert-IsolatedProtectedPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string[]]$RequiredPrincipals,
        [bool]$LeafRequired = $true,
        [string]$Label = 'validator path'
    )
    $fullPath = Get-IsolatedFullPath $Path
    if (-not (Test-IsolatedPathUnderRoot $fullPath $Root)) {
        Stop-IsolatedBatchValidator "$Label is outside the provisioned ACL root"
    }
    if ($LeafRequired -and -not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        Stop-IsolatedBatchValidator "$Label does not exist: $fullPath"
    }
    $aclPath = if (Test-Path -LiteralPath $fullPath) { $fullPath } else { Split-Path -Parent $fullPath }
    if (-not (Test-Path -LiteralPath $aclPath -PathType Container) -and
        -not (Test-Path -LiteralPath $aclPath -PathType Leaf)) {
        Stop-IsolatedBatchValidator "$Label parent does not exist: $aclPath"
    }
    Assert-IsolatedNoReparsePath $aclPath $Root
    Assert-IsolatedAcl $aclPath $RequiredPrincipals $Label
}

function Get-IsolatedValidatorConfig {
    param([string]$Path = $script:ValidatorConfigPath)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        Stop-IsolatedBatchValidator "provisioned validator config is missing: $Path"
    }
    $configDirectory = Split-Path -Parent ([IO.Path]::GetFullPath($Path))
    $configAclPrincipals = @('SYSTEM', 'BUILTIN\Administrators')
    Assert-IsolatedNoReparsePath $configDirectory $configDirectory
    Assert-IsolatedNoReparsePath $Path $configDirectory
    Assert-IsolatedAcl $Path $configAclPrincipals 'validator config'
    try {
        $raw = [IO.File]::ReadAllText($Path, [Text.UTF8Encoding]::new($false))
        if ($raw.Length -gt 0 -and [int]$raw[0] -eq 0xfeff) {
            Stop-IsolatedBatchValidator 'validator config contains a UTF-8 BOM'
        }
        $config = $raw | ConvertFrom-Json -ErrorAction Stop
    } catch {
        if ($_.Exception.Message -like 'validator config *') { throw }
        Stop-IsolatedBatchValidator 'provisioned validator config is not valid UTF-8 JSON'
    }
    if ([int](Get-IsolatedProperty $config 'schema_version' 0) -ne 1 -or
        [string](Get-IsolatedProperty $config 'kind' '') -cne 'ash-atlas-isolated-batch-validator-config' -or
        [string](Get-IsolatedProperty $config 'status' '') -cne 'ready') {
        Stop-IsolatedBatchValidator 'provisioned validator config is not ready or has an unsupported schema'
    }
    $vm = Get-IsolatedProperty $config 'vm' $null
    $paths = Get-IsolatedProperty $config 'paths' $null
    $guest = Get-IsolatedProperty $config 'guest' $null
    $hostAccount = [string](Get-IsolatedProperty $config 'host_account' '')
    if (-not $hostAccount -or [Environment]::UserName -cne $hostAccount) {
        Stop-IsolatedBatchValidator 'validator supervisor is not running as the provisioned host account'
    }
    $aclPrincipals = @((Get-IsolatedProperty $paths 'acl_principals' @()))
    if ($aclPrincipals.Count -eq 0) {
        Stop-IsolatedBatchValidator 'validator config has no ACL principal allowlist'
    }
    $stateRoot = Get-IsolatedFullPath ([string](Get-IsolatedProperty $paths 'state_root' ''))
    if (-not (Test-Path -LiteralPath $stateRoot -PathType Container)) {
        Stop-IsolatedBatchValidator "validator state root is missing: $stateRoot"
    }
    Assert-IsolatedNoReparsePath $stateRoot $stateRoot
    Assert-IsolatedAcl $stateRoot $aclPrincipals 'validator state root'
    $vmGuid = [Guid]::Empty
    if (-not [Guid]::TryParse([string](Get-IsolatedProperty $vm 'guid' ''), [ref]$vmGuid) -or
        $vmGuid -eq [Guid]::Empty) {
        Stop-IsolatedBatchValidator 'validator config VM GUID is invalid'
    }
    $checkpoint = [string](Get-IsolatedProperty $vm 'checkpoint' '')
    $checkpointGuid = [Guid]::Empty
    if (-not [Guid]::TryParse([string](Get-IsolatedProperty $vm 'checkpoint_guid' ''), [ref]$checkpointGuid) -or
        $checkpointGuid -eq [Guid]::Empty) {
        Stop-IsolatedBatchValidator 'validator config checkpoint GUID is invalid or missing'
    }
    $imageDigest = [string](Get-IsolatedProperty $vm 'image_digest' '')
    if ($checkpoint -notmatch '^[A-Za-z0-9][A-Za-z0-9 ._:-]{0,127}$' -or
        $imageDigest -notmatch '^sha256:[0-9a-f]{64}$') {
        Stop-IsolatedBatchValidator 'validator config checkpoint or image digest is not canonical'
    }
    $validatorId = [string](Get-IsolatedProperty $vm 'validator_id' '')
    if ($validatorId -notmatch '^[A-Za-z0-9._:-]{1,96}$') {
        Stop-IsolatedBatchValidator 'validator config validator ID is invalid'
    }
    $supervisorUser = [string](Get-IsolatedProperty $guest 'supervisor_user_name' '')
    $supervisorCredentialPath = Get-IsolatedFullPath ([string](Get-IsolatedProperty $guest 'supervisor_credential_path' ''))
    $buildUser = [string](Get-IsolatedProperty $guest 'build_user_name' '')
    $buildCredentialPath = Get-IsolatedFullPath ([string](Get-IsolatedProperty $guest 'build_credential_path' ''))
    if (-not $supervisorUser -or -not $buildUser -or
        [string]::Equals($supervisorUser, $buildUser, [StringComparison]::OrdinalIgnoreCase) -or
        -not (Test-Path -LiteralPath $supervisorCredentialPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $buildCredentialPath -PathType Leaf)) {
        Stop-IsolatedBatchValidator 'validator config requires distinct provisioned supervisor and standard build accounts'
    }
    Assert-IsolatedAcl $supervisorCredentialPath $aclPrincipals 'guest supervisor credential'
    Assert-IsolatedAcl $buildCredentialPath $aclPrincipals 'guest build credential'
    $imageArtifacts = @((Get-IsolatedProperty $vm 'image_artifacts' @()))
    if ($imageArtifacts.Count -eq 0) { Stop-IsolatedBatchValidator 'validator config has no immutable image artifacts' }
    $normalizedArtifacts = @()
    foreach ($artifact in $imageArtifacts) {
        $artifactPath = Get-IsolatedFullPath ([string](Get-IsolatedProperty $artifact 'path' ''))
        $artifactSha = [string](Get-IsolatedProperty $artifact 'sha256' '')
        if (-not [IO.Path]::IsPathRooted($artifactPath) -or
            $artifactSha -notmatch '^[0-9a-f]{64}$' -or
            -not (Test-Path -LiteralPath $artifactPath -PathType Leaf)) {
            Stop-IsolatedBatchValidator 'validator config contains a missing or invalid immutable image artifact'
        }
        Assert-IsolatedNoReparsePath $artifactPath (Split-Path -Parent $artifactPath)
        $actualArtifactSha = Get-IsolatedFileSha256 $artifactPath
        if ($actualArtifactSha -cne $artifactSha) {
            Stop-IsolatedBatchValidator "immutable image artifact hash differs from provisioned config: $artifactPath"
        }
        $normalizedArtifacts += [pscustomobject][ordered]@{ path = $artifactPath; sha256 = $artifactSha }
    }
    $config | Add-Member -NotePropertyName __full_config_path -NotePropertyValue ([IO.Path]::GetFullPath($Path)) -Force
    $config | Add-Member -NotePropertyName __state_root -NotePropertyValue $stateRoot -Force
    $config | Add-Member -NotePropertyName __vm_guid -NotePropertyValue $vmGuid -Force
    $config | Add-Member -NotePropertyName __checkpoint -NotePropertyValue $checkpoint -Force
    $config | Add-Member -NotePropertyName __checkpoint_guid -NotePropertyValue $checkpointGuid -Force
    $config | Add-Member -NotePropertyName __image_digest -NotePropertyValue $imageDigest -Force
    $config | Add-Member -NotePropertyName __image_artifacts -NotePropertyValue $normalizedArtifacts -Force
    $config | Add-Member -NotePropertyName __validator_id -NotePropertyValue $validatorId -Force
    $config | Add-Member -NotePropertyName __acl_principals -NotePropertyValue $aclPrincipals -Force
    $config | Add-Member -NotePropertyName __guest_supervisor_user -NotePropertyValue $supervisorUser -Force
    $config | Add-Member -NotePropertyName __guest_supervisor_credential_path -NotePropertyValue $supervisorCredentialPath -Force
    $config | Add-Member -NotePropertyName __guest_build_user -NotePropertyValue $buildUser -Force
    $config | Add-Member -NotePropertyName __guest_build_credential_path -NotePropertyValue $buildCredentialPath -Force
    $config | Add-Member -NotePropertyName __host_account -NotePropertyValue $hostAccount -Force
    return $config
}

function Get-IsolatedGuestRunnerPath {
    $path = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot $script:GuestRunnerName))
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Stop-IsolatedBatchValidator "trusted guest runner is missing beside the supervisor: $path"
    }
    $item = Get-Item -LiteralPath $path -Force
    if (([IO.FileAttributes]$item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        Stop-IsolatedBatchValidator 'trusted guest runner is a reparse point'
    }
    return $path
}

function Get-IsolatedFileSha256 {
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

function Get-IsolatedTextSha256 {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)))).Replace('-', '').ToLowerInvariant()
    } finally { $algorithm.Dispose() }
}

function ConvertTo-IsolatedCanonicalJson {
    param([AllowNull()]$Value)
    if ($null -eq $Value) { return 'null' }
    if ($Value -is [string]) { return ($Value | ConvertTo-Json -Compress) }
    if ($Value -is [bool]) { return $(if ($Value) { 'true' } else { 'false' }) }
    if ($Value -is [System.Collections.IDictionary]) {
        $keys = [string[]]@($Value.Keys | ForEach-Object { [string]$_ })
        if ($keys.Count -gt 1) { [Array]::Sort($keys, [StringComparer]::Ordinal) }
        $pairs = @($keys | ForEach-Object {
                $key = $_
                '{0}:{1}' -f ($key | ConvertTo-Json -Compress), (ConvertTo-IsolatedCanonicalJson $Value[$_])
            })
        return '{' + ($pairs -join ',') + '}'
    }
    if ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [string]) {
        return '[' + (@($Value | ForEach-Object { ConvertTo-IsolatedCanonicalJson $_ }) -join ',') + ']'
    }
    if ($Value -is [ValueType]) { return ($Value | ConvertTo-Json -Compress) }
    $properties = @($Value.PSObject.Properties)
    $keys = [string[]]@($properties | ForEach-Object { [string]$_.Name })
    if ($keys.Count -gt 1) { [Array]::Sort($keys, [StringComparer]::Ordinal) }
    $pairs = @($keys | ForEach-Object {
            $property = $Value.PSObject.Properties[$_]
            '{0}:{1}' -f ($_.ToString() | ConvertTo-Json -Compress), (ConvertTo-IsolatedCanonicalJson $property.Value)
        })
    return '{' + ($pairs -join ',') + '}'
}

function ConvertTo-IsolatedUtf8Json {
    param([Parameter(Mandatory = $true)]$Value)
    return (ConvertTo-IsolatedCanonicalJson $Value)
}

function Write-IsolatedJsonAtomic {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)]$Value)
    $directory = Split-Path -Parent $Path
    $temporary = "$Path.$PID.tmp"
    try {
        [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 32) + [Environment]::NewLine,
            [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    } finally {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        }
    }
}

function Read-IsolatedJson {
    param([Parameter(Mandatory = $true)][string]$Path, [int]$MaximumBytes = $script:MaxRequestBytes)
    $length = (Get-Item -LiteralPath $Path -Force).Length
    if ($length -gt $MaximumBytes) { Stop-IsolatedBatchValidator 'validator request or receipt exceeds its bounded size' }
    $raw = [IO.File]::ReadAllText($Path, [Text.UTF8Encoding]::new($false))
    if ($raw.Length -gt 0 -and [int]$raw[0] -eq 0xfeff) {
        Stop-IsolatedBatchValidator 'validator JSON contains a UTF-8 BOM'
    }
    try { return $raw | ConvertFrom-Json -ErrorAction Stop }
    catch { Stop-IsolatedBatchValidator "validator JSON is unreadable: $Path" }
}

function Test-IsolatedRelativePath {
    param([Parameter(Mandatory = $true)][string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path) -or $Path -match '^(?:[A-Za-z]:[\\/]|[\\/]{2})' -or
        $Path -match '(^|[\\/])\.\.(?:[\\/]|$)' -or $Path -match '[\x00-\x1f]') { return $false }
    return $true
}

function Get-IsolatedGateNames {
    return @(
        'git_diff_check', 'repository_hygiene', 'workspace_install', 'focused_candidate_admission',
        'changed_file_lint', 'client_affected_tests', 'server_affected_tests', 'shared_affected_tests',
        'client_typecheck', 'server_typecheck', 'shared_typecheck', 'disposable_postgres_matrix',
        'client_production_build', 'server_production_build', 'server_build_verify',
        'combined_disposable_browser_acceptance'
    )
}

function Assert-IsolatedGatePlan {
    param([Parameter(Mandatory = $true)]$Request)
    $plan = Get-IsolatedProperty $Request 'plan' $null
    if ($null -eq $plan -or [string](Get-IsolatedProperty $plan 'candidate_sha' '') -cne
        [string](Get-IsolatedProperty $Request 'candidate_sha' '')) {
        Stop-IsolatedBatchValidator 'validator request plan is not bound to its candidate'
    }
    $gates = @((Get-IsolatedProperty $plan 'gates' @()))
    if ($gates.Count -eq 0 -or $gates.Count -gt 64) { Stop-IsolatedBatchValidator 'validator request has an invalid gate count' }
    $allowed = @(Get-IsolatedGateNames)
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    $baseline = [string](Get-IsolatedProperty $Request 'baseline_sha' '')
    $candidate = [string](Get-IsolatedProperty $Request 'candidate_sha' '')
    foreach ($gate in $gates) {
        $name = [string](Get-IsolatedProperty $gate 'name' '')
        $kind = [string](Get-IsolatedProperty $gate 'kind' '')
        $file = [string](Get-IsolatedProperty $gate 'file_path' '')
        $arguments = @((Get-IsolatedProperty $gate 'arguments' @()) | ForEach-Object { [string]$_ })
        if ($name -notin $allowed -or -not $seen.Add($name)) { Stop-IsolatedBatchValidator "unexpected or duplicate validator gate: $name" }
        if ($kind -notin @('native', 'install', 'browser')) { Stop-IsolatedBatchValidator "unsupported gate kind: $name" }
        if ([int](Get-IsolatedProperty $gate 'deadline_seconds' 0) -lt 1 -or
            [int](Get-IsolatedProperty $gate 'deadline_seconds' 0) -gt 7200) {
            Stop-IsolatedBatchValidator "gate deadline is outside its bounded range: $name"
        }
        switch ($name) {
            'git_diff_check' {
                if ($file -cne 'git' -or $arguments.Count -ne 4 -or $arguments[0] -cne 'diff' -or
                    $arguments[1] -cne '--check' -or $arguments[2] -cne $baseline -or $arguments[3] -cne $candidate) {
                    Stop-IsolatedBatchValidator 'git_diff_check is not the canonical baseline-to-candidate command'
                }
            }
            'repository_hygiene' {
                if ($file -cne 'pnpm.cmd' -or ($arguments -join [char]0x1f) -cne 'check:hygiene') { Stop-IsolatedBatchValidator 'repository_hygiene command is unexpected' }
            }
            'workspace_install' {
                if ($file -cne 'pnpm.cmd' -or ($arguments -join [char]0x1f) -cne "install$([char]0x1f)--frozen-lockfile") { Stop-IsolatedBatchValidator 'workspace_install command is unexpected' }
            }
            'changed_file_lint' {
                if ($file -cne 'pnpm.cmd' -or $arguments.Count -lt 4 -or $arguments[0] -cne 'exec' -or
                    $arguments[1] -cne 'eslint' -or $arguments[2] -cne '--') { Stop-IsolatedBatchValidator 'changed_file_lint command is unexpected' }
                foreach ($path in @($arguments | Select-Object -Skip 3)) {
                    if (-not (Test-IsolatedRelativePath $path)) { Stop-IsolatedBatchValidator 'changed_file_lint contains an unsafe path' }
                }
            }
            { $_ -in @('client_affected_tests', 'server_affected_tests', 'shared_affected_tests') } {
                $package = switch ($name) { 'client_affected_tests' { '@ash-atlas/client' } 'server_affected_tests' { '@ash-atlas/server' } default { '@ash-atlas/shared' } }
                if ($file -cne 'pnpm.cmd' -or ($arguments -join [char]0x1f) -cne "--filter$([char]0x1f)$package$([char]0x1f)test") { Stop-IsolatedBatchValidator "$name command is unexpected" }
            }
            { $_ -in @('client_typecheck', 'server_typecheck', 'shared_typecheck') } {
                $package = switch ($name) { 'client_typecheck' { '@ash-atlas/client' } 'server_typecheck' { '@ash-atlas/server' } default { '@ash-atlas/shared' } }
                if ($file -cne 'pnpm.cmd' -or ($arguments -join [char]0x1f) -cne "--filter$([char]0x1f)$package$([char]0x1f)typecheck") { Stop-IsolatedBatchValidator "$name command is unexpected" }
            }
            'disposable_postgres_matrix' {
                if ($file -cne 'pnpm.cmd' -or ($arguments -join [char]0x1f) -cne 'test:postgres') { Stop-IsolatedBatchValidator 'disposable_postgres_matrix command is unexpected' }
            }
            'client_production_build' {
                if ($file -cne 'pnpm.cmd' -or ($arguments -join [char]0x1f) -cne "--filter$([char]0x1f)@ash-atlas/client$([char]0x1f)build") { Stop-IsolatedBatchValidator 'client_production_build command is unexpected' }
            }
            'server_production_build' {
                if ($file -cne 'pnpm.cmd' -or ($arguments -join [char]0x1f) -cne "--filter$([char]0x1f)@ash-atlas/server$([char]0x1f)build") { Stop-IsolatedBatchValidator 'server_production_build command is unexpected' }
            }
            'server_build_verify' {
                if ($file -cne 'pnpm.cmd' -or ($arguments -join [char]0x1f) -cne "--filter$([char]0x1f)@ash-atlas/server$([char]0x1f)build:verify") { Stop-IsolatedBatchValidator 'server_build_verify command is unexpected' }
            }
            'focused_candidate_admission' {
                if ($file -cne 'powershell.exe' -or $arguments.Count -ne 5 -or $arguments[0] -cne '-NoProfile' -or
                    $arguments[1] -cne '-ExecutionPolicy' -or $arguments[2] -cne 'Bypass' -or $arguments[3] -cne '-Command' -or
                    [string](Get-IsolatedProperty $gate 'binding_sha' '') -cne $candidate -or
                    [string]::IsNullOrWhiteSpace($arguments[4]) -or $arguments[4] -match '(?i)(?:[A-Za-z]:[\\/]|\\\\|Invoke-WebRequest|Start-BitsTransfer|ConvertFrom-SecureString|HMAC|SECRET|TOKEN|PASSWORD)') {
                    Stop-IsolatedBatchValidator 'focused_candidate_admission command is not a portable guest command'
                }
            }
            'combined_disposable_browser_acceptance' {
                if ($file -cne 'internal' -or $arguments.Count -ne 1 -or $arguments[0] -cne 'Invoke-BatchBrowserAcceptance:v1') {
                    Stop-IsolatedBatchValidator 'combined browser acceptance command is unexpected'
                }
            }
        }
    }
    return $gates
}

function Assert-IsolatedRequest {
    param(
        [Parameter(Mandatory = $true)]$Request,
        [Parameter(Mandatory = $true)][string]$RequestPath,
        [Parameter(Mandatory = $true)][string]$StateRoot
    )
    if ([int](Get-IsolatedProperty $Request 'schema_version' 0) -ne 1 -or
        [string](Get-IsolatedProperty $Request 'kind' '') -cne 'ash-atlas-isolated-batch-validation-request' -or
        [string](Get-IsolatedProperty $Request 'validator_contract' '') -cne 'ash-atlas-isolated-uncredentialed-vm/v1') {
        Stop-IsolatedBatchValidator 'validator request schema or contract is unsupported'
    }
    $operationId = [string](Get-IsolatedProperty $Request 'operation_id' '')
    if ($operationId -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$') { Stop-IsolatedBatchValidator 'validator operation ID is unsafe' }
    foreach ($field in @('candidate_sha', 'baseline_sha', 'tooling_sha')) {
        if ([string](Get-IsolatedProperty $Request $field '') -notmatch '^[0-9a-f]{40}$') { Stop-IsolatedBatchValidator "validator request $field is not canonical" }
    }
    foreach ($field in @('manifest_sha256', 'validation_plan_sha256', 'validation_toolchain_fingerprint')) {
        if ([string](Get-IsolatedProperty $Request $field '') -notmatch '^[0-9a-f]{64}$') { Stop-IsolatedBatchValidator "validator request $field is not canonical" }
    }
    $planJson = ConvertTo-IsolatedCanonicalJson (Get-IsolatedProperty $Request 'plan' $null)
    if ((Get-IsolatedTextSha256 $planJson) -cne [string](Get-IsolatedProperty $Request 'validation_plan_sha256' '')) {
        Stop-IsolatedBatchValidator 'validator request plan hash does not match its exact plan'
    }
    if (-not (Test-IsolatedPathUnderRoot $RequestPath $StateRoot)) { Stop-IsolatedBatchValidator 'validator request path is outside the ACL state root' }
    $bundleDirectory = Split-Path -Parent ([IO.Path]::GetFullPath($RequestPath))
    $bundles = Get-IsolatedProperty $Request 'bundles' $null
    foreach ($entry in @(@{ key = 'baseline'; sha = [string](Get-IsolatedProperty $Request 'baseline_sha' ''); file = 'baseline.bundle' },
            @{ key = 'candidate'; sha = [string](Get-IsolatedProperty $Request 'candidate_sha' ''); file = 'candidate.bundle' })) {
        $bundle = Get-IsolatedProperty $bundles $entry.key $null
        $path = Get-IsolatedFullPath ([string](Get-IsolatedProperty $bundle 'path' ''))
        $expected = Get-IsolatedFullPath (Join-Path $bundleDirectory $entry.file)
        if (-not [String]::Equals($path, $expected, [StringComparison]::OrdinalIgnoreCase) -or
            [string](Get-IsolatedProperty $bundle 'sha' '') -cne $entry.sha -or
            [string](Get-IsolatedProperty $bundle 'sha256' '') -notmatch '^[0-9a-f]{64}$') {
            Stop-IsolatedBatchValidator "$($entry.key) bundle identity is not exact"
        }
        Assert-IsolatedProtectedPath $path $StateRoot @((Get-IsolatedProperty $script:CurrentValidatorConfig '__acl_principals' @())) $true "$($entry.key) bundle"
        if ((Get-IsolatedFileSha256 $path) -cne [string](Get-IsolatedProperty $bundle 'sha256' '')) { Stop-IsolatedBatchValidator "$($entry.key) bundle hash differs from the request" }
        # Git bundle prerequisite and advertised-ref validation intentionally run
        # inside the freshly initialized guest repository.  A host-side
        # `git bundle verify` has no object database to resolve prerequisites
        # against, and would also make the host the source of candidate refs.
    }
    $null = Assert-IsolatedGatePlan $Request
    return $Request
}

function Get-IsolatedValidatorHmacKey {
    $encoded = [Environment]::GetEnvironmentVariable('ASH_ATLAS_BATCH_VALIDATOR_HMAC_KEY')
    $keyId = [Environment]::GetEnvironmentVariable('ASH_ATLAS_BATCH_VALIDATOR_HMAC_KEY_ID')
    if (-not $encoded -or -not $keyId) { Stop-IsolatedBatchValidator 'host-only validator HMAC key configuration is missing' }
    try { $bytes = [Convert]::FromBase64String($encoded) } catch { Stop-IsolatedBatchValidator 'host-only validator HMAC key is not valid base64' }
    if ($bytes.Length -lt 32 -or $keyId -notmatch '^[A-Za-z0-9._:-]{1,96}$') { Stop-IsolatedBatchValidator 'host-only validator HMAC key or key ID is invalid' }
    return [pscustomobject][ordered]@{ bytes = $bytes; id = $keyId }
}

function Get-IsolatedHmacSha256 {
    param([Parameter(Mandatory = $true)][string]$Text, [Parameter(Mandatory = $true)][byte[]]$Key)
    $algorithm = [Security.Cryptography.HMACSHA256]::new($Key)
    try { return ([BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)))).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose() }
}

function Assert-IsolatedVmIdentity {
    param([Parameter(Mandatory = $true)]$Config)
    $vm = @(Get-VM -Id $Config.__vm_guid -ErrorAction Stop)
    if ($vm.Count -ne 1) { Stop-IsolatedBatchValidator 'provisioned validator VM GUID did not resolve exactly one VM' }
    $resolvedVmGuid = [Guid]::Empty
    if (-not [Guid]::TryParse([string](Get-IsolatedProperty $vm[0] 'Id' ''), [ref]$resolvedVmGuid) -or
        $resolvedVmGuid -ne [Guid]$Config.__vm_guid -or
        [string]::IsNullOrWhiteSpace([string](Get-IsolatedProperty $vm[0] 'Name' ''))) {
        Stop-IsolatedBatchValidator 'resolved validator VM identity differs from the pinned GUID'
    }
    $snapshot = @(Get-VMSnapshot -VMName ([string]$vm[0].Name) -Name $Config.__checkpoint -ErrorAction Stop)
    $resolvedCheckpointGuid = [Guid]::Empty
    if ($snapshot.Count -ne 1 -or
        [string](Get-IsolatedProperty $snapshot[0] 'Name' '') -cne [string]$Config.__checkpoint -or
        -not [Guid]::TryParse([string](Get-IsolatedProperty $snapshot[0] 'Id' ''), [ref]$resolvedCheckpointGuid) -or
        $resolvedCheckpointGuid -ne [Guid]$Config.__checkpoint_guid) {
        Stop-IsolatedBatchValidator 'pinned validator checkpoint is missing or ambiguous'
    }
    foreach ($artifact in @((Get-IsolatedProperty $Config '__image_artifacts' @()))) {
        $artifactPath = [string](Get-IsolatedProperty $artifact 'path' '')
        $expectedSha = [string](Get-IsolatedProperty $artifact 'sha256' '')
        if (-not (Test-Path -LiteralPath $artifactPath -PathType Leaf) -or
            (Get-IsolatedFileSha256 $artifactPath) -cne $expectedSha) {
            Stop-IsolatedBatchValidator "immutable validator image artifact changed: $artifactPath"
        }
    }
    return $vm[0]
}

function Wait-IsolatedVmState {
    param([Parameter(Mandatory = $true)][Guid]$VmGuid, [Parameter(Mandatory = $true)][string]$ExpectedState)
    $deadline = (Get-Date).AddSeconds($script:VmWaitSeconds)
    do {
        $vm = @(Get-VM -Id $VmGuid -ErrorAction Stop)
        if ($vm.Count -eq 1 -and [string]$vm[0].State -ceq $ExpectedState) { return $vm[0] }
        Start-Sleep -Seconds 1
    } while ((Get-Date) -lt $deadline)
    Stop-IsolatedBatchValidator "validator VM did not reach state $ExpectedState"
}

function Import-IsolatedGuestCredentials {
    param([Parameter(Mandatory = $true)]$Config)
    try {
        $supervisorCredential = Import-Clixml -LiteralPath $Config.__guest_supervisor_credential_path -ErrorAction Stop
        $buildCredential = Import-Clixml -LiteralPath $Config.__guest_build_credential_path -ErrorAction Stop
    } catch {
        Stop-IsolatedBatchValidator 'guest-only credentials could not be loaded from the provisioned host store'
    }
    if (-not ($supervisorCredential -is [PSCredential]) -or
        $supervisorCredential.UserName -cne $Config.__guest_supervisor_user -or
        -not ($buildCredential -is [PSCredential]) -or
        $buildCredential.UserName -cne $Config.__guest_build_user -or
        [string]::Equals($supervisorCredential.UserName, $buildCredential.UserName, [StringComparison]::OrdinalIgnoreCase)) {
        Stop-IsolatedBatchValidator 'loaded credentials are not the distinct pinned guest identities'
    }
    return [pscustomobject][ordered]@{ supervisor = $supervisorCredential; build = $buildCredential }
}

function Get-IsolatedGateLogName {
    param([Parameter(Mandatory = $true)][int]$Index, [Parameter(Mandatory = $true)][string]$Name)
    return ('{0:D2}-{1}' -f $Index, $Name)
}

function Assert-IsolatedRemoteArtifactBounds {
    param([Parameter(Mandatory = $true)]$Session, [Parameter(Mandatory = $true)][string[]]$Paths)
    $metadata = Invoke-Command -Session $Session -ScriptBlock {
        param($items)
        foreach ($path in @($items)) {
            $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
            if (([IO.FileAttributes]$item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "remote validator artifact is a reparse point: $path" }
            [pscustomobject]@{ path = $path; length = [long]$item.Length }
        }
    } -ArgumentList (,@($Paths))
    foreach ($item in @($metadata)) {
        if ([long]$item.length -gt $script:MaxLogBytes) { Stop-IsolatedBatchValidator "guest validator log exceeds the bounded size: $($item.path)" }
    }
}

function Invoke-IsolatedBatchValidatorSupervisor {
    param(
        [Parameter(Mandatory = $true)][string]$RequestPath,
        [Parameter(Mandatory = $true)][string]$ReceiptPath
    )
    $script:CurrentValidatorConfig = Get-IsolatedValidatorConfig
    $stateRoot = [string]$script:CurrentValidatorConfig.__state_root
    $requestFull = Get-IsolatedFullPath $RequestPath
    $receiptFull = Get-IsolatedFullPath $ReceiptPath
    Assert-IsolatedProtectedPath $requestFull $stateRoot @($script:CurrentValidatorConfig.__acl_principals) $true 'validator request'
    $receiptParent = Split-Path -Parent $receiptFull
    if (-not (Test-Path -LiteralPath $receiptParent -PathType Container)) { New-Item -ItemType Directory -Path $receiptParent -Force | Out-Null }
    Assert-IsolatedProtectedPath $receiptParent $stateRoot @($script:CurrentValidatorConfig.__acl_principals) $false 'validator receipt directory'
    if ([String]::Equals($requestFull, $receiptFull, [StringComparison]::OrdinalIgnoreCase)) { Stop-IsolatedBatchValidator 'request and receipt paths must differ' }
    $request = Read-IsolatedJson $requestFull
    Assert-IsolatedRequest $request $requestFull $stateRoot | Out-Null
    $guestRunner = Get-IsolatedGuestRunnerPath
    $configuredGuestHash = [string](Get-IsolatedProperty (Get-IsolatedProperty $script:CurrentValidatorConfig 'guest' $null) 'runner_sha256' '')
    if ($configuredGuestHash -notmatch '^[0-9a-f]{64}$' -or (Get-IsolatedFileSha256 $guestRunner) -cne $configuredGuestHash) {
        Stop-IsolatedBatchValidator 'trusted guest runner hash does not match the provisioned config'
    }
    $vm = Assert-IsolatedVmIdentity $script:CurrentValidatorConfig
    $credentials = Import-IsolatedGuestCredentials $script:CurrentValidatorConfig
    $bundleDirectory = Split-Path -Parent $requestFull
    $operationId = [string](Get-IsolatedProperty $request 'operation_id' '')
    $remoteRoot = "C:\ProgramData\AshAtlas\IsolatedBatchValidator\$operationId"
    $remoteRequest = Join-Path $remoteRoot 'input\request.json'
    $remoteBaseline = Join-Path $remoteRoot 'input\baseline.bundle'
    $remoteCandidate = Join-Path $remoteRoot 'input\candidate.bundle'
    $remoteRunner = Join-Path $remoteRoot 'input\isolated-batch-validator-guest.ps1'
    $remoteGuestReceipt = Join-Path $remoteRoot 'output\guest-receipt.json'
    $remoteLogs = Join-Path $remoteRoot 'output\logs'
    $retrievedRoot = Join-Path $bundleDirectory 'host-retrieved-logs'
    New-Item -ItemType Directory -Path $retrievedRoot -Force | Out-Null
    Assert-IsolatedNoReparsePath $retrievedRoot $stateRoot
    $session = $null
    $vmReady = $false
    $guestFailure = $null
    $guestReceiptPath = Join-Path $retrievedRoot 'guest-receipt.json'
    try {
        # From this point forward the supervisor owns cleanup even if restore,
        # boot, or PowerShell Direct setup fails halfway through.
        $vmReady = $true
        $state = [string]$vm.State
        if ($state -ne 'Off') {
            Stop-VM -Id $script:CurrentValidatorConfig.__vm_guid -TurnOff -Confirm:$false -ErrorAction Stop
            Wait-IsolatedVmState $script:CurrentValidatorConfig.__vm_guid 'Off' | Out-Null
        }
        Restore-VMSnapshot -VMName ([string]$vm.Name) -Name $script:CurrentValidatorConfig.__checkpoint -Confirm:$false -ErrorAction Stop
        Start-VM -Id $script:CurrentValidatorConfig.__vm_guid -ErrorAction Stop | Out-Null
        Wait-IsolatedVmState $script:CurrentValidatorConfig.__vm_guid 'Running' | Out-Null
        # PowerShell Direct is established only as the trusted supervisor.  The
        # standard build credential is encrypted in the remoting argument and is
        # consumed by the trusted guest runner for each candidate gate.
        $session = New-PSSession -VMId $script:CurrentValidatorConfig.__vm_guid -Credential $credentials.supervisor -ErrorAction Stop
        Invoke-Command -Session $session -ScriptBlock {
            param($root, $supervisorUser, $buildUser)
            if ($root -notmatch '^C:\\ProgramData\\AshAtlas\\IsolatedBatchValidator\\[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$') { throw 'invalid fixed guest validator root' }
            if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction Stop }
            $input = Join-Path $root 'input'
            $output = Join-Path $root 'output'
            $logs = Join-Path $output 'logs'
            $repo = Join-Path $root 'repo'
            $launcherProfileRoot = 'C:\Users\dev'
            $launcherParent = Join-Path $launcherProfileRoot 'Documents'
            $launcherRoot = Join-Path $launcherParent 'Ash Atlas Feature Launchers'
            New-Item -ItemType Directory -Path $input, $logs, $repo -Force | Out-Null
            if (-not (Test-Path -LiteralPath $launcherProfileRoot -PathType Container) -or
                -not (Test-Path -LiteralPath $launcherParent -PathType Container)) {
                throw 'pinned guest launcher profile path is missing'
            }
            function Assert-GuestNoReparsePath {
                param([string]$path, [string]$boundary)
                $itemPath = [IO.Path]::GetFullPath($path).TrimEnd('\')
                $boundaryPath = [IO.Path]::GetFullPath($boundary).TrimEnd('\')
                while ($true) {
                    $item = Get-Item -LiteralPath $itemPath -Force -ErrorAction Stop
                    if (([IO.FileAttributes]$item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                        throw "guest launcher path contains a reparse point: $itemPath"
                    }
                    if ([string]::Equals($itemPath, $boundaryPath, [StringComparison]::OrdinalIgnoreCase)) { break }
                    $parent = (Split-Path -Parent $itemPath).TrimEnd('\')
                    if (-not $parent -or -not $itemPath.StartsWith($boundaryPath + '\', [StringComparison]::OrdinalIgnoreCase)) {
                        throw "guest launcher path escaped its pinned profile boundary: $path"
                    }
                    $itemPath = $parent
                }
            }
            Assert-GuestNoReparsePath $launcherParent $launcherProfileRoot
            if (Test-Path -LiteralPath $launcherRoot -PathType Leaf) { throw 'pinned guest launcher path is not a directory' }
            New-Item -ItemType Directory -Path $launcherRoot -Force | Out-Null
            Assert-GuestNoReparsePath $launcherRoot $launcherProfileRoot
            $full = [Security.AccessControl.FileSystemRights]::FullControl
            $modify = [Security.AccessControl.FileSystemRights]::Modify
            $readExecute = [Security.AccessControl.FileSystemRights]::ReadAndExecute
            $inheritNone = [Security.AccessControl.InheritanceFlags]::None
            $inheritChildren = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
            $noPropagation = [Security.AccessControl.PropagationFlags]::None
            $allow = [Security.AccessControl.AccessControlType]::Allow
            function Set-ValidatorDirectoryAcl {
                param([string]$path, [bool]$buildCanModify, [bool]$buildCanRead)
                $acl = New-Object Security.AccessControl.DirectorySecurity
                $acl.SetAccessRuleProtection($true, $false)
                foreach ($principal in @('SYSTEM', 'BUILTIN\Administrators', $supervisorUser)) {
                    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($principal, $full, $inheritChildren, $noPropagation, $allow))
                }
                if ($buildCanModify) {
                    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($buildUser, $modify, $inheritChildren, $noPropagation, $allow))
                } elseif ($buildCanRead) {
                    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($buildUser, $readExecute, $inheritNone, $noPropagation, $allow))
                }
                Set-Acl -LiteralPath $path -AclObject $acl -ErrorAction Stop
            }
            Set-ValidatorDirectoryAcl $root $false $true
            Set-ValidatorDirectoryAcl $input $false $true
            Set-ValidatorDirectoryAcl $output $false $false
            Set-ValidatorDirectoryAcl $logs $false $false
            Set-ValidatorDirectoryAcl $repo $true $true
            Set-ValidatorDirectoryAcl $launcherRoot $true $false
            $outputAcl = [string](Get-Acl -LiteralPath $output).AccessToString
            if ($outputAcl -match [Regex]::Escape($buildUser)) { throw 'build identity has access to protected validator output' }
            $launcherAcl = Get-Acl -LiteralPath $launcherRoot -ErrorAction Stop
            $launcherBuildRules = @($launcherAcl.Access | Where-Object {
                [string]$_.AccessControlType -ceq 'Allow' -and
                [string]$_.IdentityReference -match [Regex]::Escape($buildUser) -and
                (([Security.AccessControl.FileSystemRights]$_.FileSystemRights -band $modify) -eq $modify)
            })
            if (-not [bool]$launcherAcl.AreAccessRulesProtected -or
                $launcherBuildRules.Count -ne 1 -or
                [string]$launcherAcl.AccessToString -match '(?im)(^|;)\s*(Everyone|BUILTIN\\Users|NT AUTHORITY\\Authenticated Users)\s+') {
                throw 'pinned guest launcher directory ACL is not limited to the trusted and build identities'
            }
        } -ArgumentList $remoteRoot, $script:CurrentValidatorConfig.__guest_supervisor_user, $script:CurrentValidatorConfig.__guest_build_user | Out-Null
        Copy-Item -ToSession $session -LiteralPath $requestFull -Destination $remoteRequest -Force -ErrorAction Stop
        Copy-Item -ToSession $session -LiteralPath (Join-Path $bundleDirectory 'baseline.bundle') -Destination $remoteBaseline -Force -ErrorAction Stop
        Copy-Item -ToSession $session -LiteralPath (Join-Path $bundleDirectory 'candidate.bundle') -Destination $remoteCandidate -Force -ErrorAction Stop
        Copy-Item -ToSession $session -LiteralPath $guestRunner -Destination $remoteRunner -Force -ErrorAction Stop
        $guestInvocation = Invoke-Command -Session $session -ScriptBlock {
            param($runnerPath, $requestPath, $receiptPath, $workRoot, $supervisorIdentity, $buildIdentity, $buildCredentialValue)
            $exitCode = 1
            try {
                # Execute the trusted runner as its own script scope.  Dot-sourcing
                # it here would let its top-level parameters overwrite the
                # remoting scriptblock's same-named variables under Windows
                # PowerShell 5.1.
                & $runnerPath -RequestPath $requestPath -ReceiptPath $receiptPath -WorkRoot $workRoot `
                    -ExpectedSupervisorUser $supervisorIdentity -ExpectedBuildUser $buildIdentity -BuildCredential $buildCredentialValue
                $exitCode = 0
            } catch {
                Write-Error $_
                $exitCode = 1
            }
            [pscustomobject]@{ exit_code = $exitCode }
        } -ArgumentList $remoteRunner, $remoteRequest, $remoteGuestReceipt, $remoteRoot,
            $script:CurrentValidatorConfig.__guest_supervisor_user, $script:CurrentValidatorConfig.__guest_build_user, $credentials.build
        if (@($guestInvocation).Count -ne 1 -or [int]$guestInvocation.exit_code -ne 0) {
            $guestFailure = [InvalidOperationException]::new('guest validator returned a nonzero command result')
        }
        Assert-IsolatedRemoteArtifactBounds $session @($remoteGuestReceipt)
        $guestReceiptRemote = Join-Path $remoteRoot 'output\guest-receipt.json'
        Copy-Item -FromSession $session -LiteralPath $guestReceiptRemote -Destination $guestReceiptPath -Force -ErrorAction Stop
        $guestReceiptObject = Read-IsolatedJson $guestReceiptPath
        $guestGates = @((Get-IsolatedProperty $guestReceiptObject 'gates' @()))
        $expectedGates = @((Get-IsolatedProperty (Get-IsolatedProperty $request 'plan' $null) 'gates' @()))
        $remoteArtifacts = @()
        for ($index = 0; $index -lt $expectedGates.Count; $index++) {
            $name = [string](Get-IsolatedProperty $expectedGates[$index] 'name' '')
            $base = Get-IsolatedGateLogName $index $name
            $remoteArtifacts += @((Join-Path $remoteLogs "$base.stdout.log"), (Join-Path $remoteLogs "$base.stderr.log"), (Join-Path $remoteLogs "$base.log"))
        }
        Assert-IsolatedRemoteArtifactBounds $session $remoteArtifacts
        foreach ($artifact in $remoteArtifacts) {
            Copy-Item -FromSession $session -LiteralPath $artifact -Destination (Join-Path $retrievedRoot (Split-Path -Leaf $artifact)) -Force -ErrorAction Stop
        }
        if ($guestGates.Count -ne $expectedGates.Count) { Stop-IsolatedBatchValidator 'guest receipt gate count differs from the exact request plan' }
        if ($null -ne $guestFailure) { throw $guestFailure }
    } catch {
        $guestFailure = $_.Exception
    } finally {
        if ($null -ne $session) { try { Remove-PSSession -Session $session -ErrorAction SilentlyContinue } catch { } }
        if ($vmReady) {
            try {
                $currentVm = @(Get-VM -Id $script:CurrentValidatorConfig.__vm_guid -ErrorAction Stop)
                if ($currentVm.Count -eq 1 -and [string]$currentVm[0].State -ne 'Off') {
                    Stop-VM -Id $script:CurrentValidatorConfig.__vm_guid -TurnOff -Confirm:$false -ErrorAction Stop | Out-Null
                    Wait-IsolatedVmState $script:CurrentValidatorConfig.__vm_guid 'Off' | Out-Null
                }
            } catch {
                if ($null -eq $guestFailure) { $guestFailure = $_.Exception }
            }
        }
    }
    if ($null -ne $guestFailure) { throw $guestFailure }
    $guestReceipt = Read-IsolatedJson $guestReceiptPath
    if ([int](Get-IsolatedProperty $guestReceipt 'schema_version' 0) -ne 1 -or
        [string](Get-IsolatedProperty $guestReceipt 'kind' '') -cne 'ash-atlas-isolated-batch-validation-guest-result' -or
        [string](Get-IsolatedProperty $guestReceipt 'operation_id' '') -cne [string](Get-IsolatedProperty $request 'operation_id' '') -or
        [string](Get-IsolatedProperty $guestReceipt 'candidate_sha' '') -cne [string](Get-IsolatedProperty $request 'candidate_sha' '') -or
        [string](Get-IsolatedProperty $guestReceipt 'baseline_sha' '') -cne [string](Get-IsolatedProperty $request 'baseline_sha' '')) {
        Stop-IsolatedBatchValidator 'guest receipt is not bound to the exact validator request'
    }
    $guestIdentity = Get-IsolatedProperty $guestReceipt 'identity' $null
    if ([string](Get-IsolatedProperty $guestIdentity 'supervisor_user' '') -cne [string]$script:CurrentValidatorConfig.__guest_supervisor_user -or
        [string](Get-IsolatedProperty $guestIdentity 'build_user' '') -cne [string]$script:CurrentValidatorConfig.__guest_build_user -or
        -not [bool](Get-IsolatedProperty $guestIdentity 'trusted_supervisor' $false) -or
        -not [bool](Get-IsolatedProperty $guestIdentity 'build_processes_observed' $false) -or
        -not [bool](Get-IsolatedProperty $guestIdentity 'standard_user' $false) -or
        -not [bool](Get-IsolatedProperty $guestIdentity 'positive_environment' $false) -or
        -not [bool](Get-IsolatedProperty $guestIdentity 'no_host_mounts' $false) -or
        -not [bool](Get-IsolatedProperty $guestIdentity 'no_secrets' $false)) {
        Stop-IsolatedBatchValidator 'guest validator identity proof did not establish the required uncredentialed environment'
    }
    $planGates = @((Get-IsolatedProperty (Get-IsolatedProperty $request 'plan' $null) 'gates' @()))
    $guestGates = @((Get-IsolatedProperty $guestReceipt 'gates' @()))
    $finalGates = @()
    for ($index = 0; $index -lt $planGates.Count; $index++) {
        $planGate = $planGates[$index]
        $guestGate = $guestGates[$index]
        $name = [string](Get-IsolatedProperty $planGate 'name' '')
        if ([string](Get-IsolatedProperty $guestGate 'name' '') -cne $name -or
            [string](Get-IsolatedProperty $guestGate 'candidate_sha' '') -cne [string](Get-IsolatedProperty $request 'candidate_sha' '') -or
            [int](Get-IsolatedProperty $guestGate 'exit_code' -1) -ne 0) {
            Stop-IsolatedBatchValidator "guest validator gate failed or changed identity: $name"
        }
        $base = Get-IsolatedGateLogName $index $name
        $stdout = Join-Path $retrievedRoot "$base.stdout.log"
        $stderr = Join-Path $retrievedRoot "$base.stderr.log"
        $combined = Join-Path $retrievedRoot "$base.log"
        foreach ($path in @($stdout, $stderr, $combined)) {
            if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Item -LiteralPath $path).Length -gt $script:MaxLogBytes) {
                Stop-IsolatedBatchValidator "guest validator did not return a bounded log for $name"
            }
        }
        $stdoutHash = Get-IsolatedFileSha256 $stdout
        $stderrHash = Get-IsolatedFileSha256 $stderr
        $combinedHash = Get-IsolatedFileSha256 $combined
        if ($stdoutHash -cne [string](Get-IsolatedProperty $guestGate 'stdout_sha256' '') -or
            $stderrHash -cne [string](Get-IsolatedProperty $guestGate 'stderr_sha256' '') -or
            $combinedHash -cne [string](Get-IsolatedProperty $guestGate 'log_sha256' '')) {
            Stop-IsolatedBatchValidator "host hash of guest validator logs differs for $name"
        }
        $finalGates += [pscustomobject][ordered]@{
            name = $name
            candidate_sha = [string](Get-IsolatedProperty $request 'candidate_sha' '')
            exit_code = 0
            stdout_sha256 = $stdoutHash
            stderr_sha256 = $stderrHash
            log_sha256 = $combinedHash
        }
    }
    # Keep the secret in host memory only after the guest session and VM are
    # gone.  It is never included in the request, remoting arguments, or guest
    # environment.
    $key = Get-IsolatedValidatorHmacKey
    $receipt = [pscustomobject][ordered]@{
        schema_version = 1
        kind = 'ash-atlas-isolated-batch-validation-receipt'
        operation_id = [string](Get-IsolatedProperty $request 'operation_id' '')
        candidate_sha = [string](Get-IsolatedProperty $request 'candidate_sha' '')
        baseline_sha = [string](Get-IsolatedProperty $request 'baseline_sha' '')
        manifest_sha256 = [string](Get-IsolatedProperty $request 'manifest_sha256' '')
        tooling_sha = [string](Get-IsolatedProperty $request 'tooling_sha' '')
        validation_plan_sha256 = [string](Get-IsolatedProperty $request 'validation_plan_sha256' '')
        validation_toolchain_fingerprint = [string](Get-IsolatedProperty $request 'validation_toolchain_fingerprint' '')
        validator = [pscustomobject][ordered]@{
            mode = 'uncredentialed-vm'
            supervisor = 'host'
            id = [string]$script:CurrentValidatorConfig.__validator_id
            image_digest = [string]$script:CurrentValidatorConfig.__image_digest
            image_artifacts = @($script:CurrentValidatorConfig.__image_artifacts)
            vm_guid = ([Guid]$script:CurrentValidatorConfig.__vm_guid).ToString('D')
            checkpoint = [string]$script:CurrentValidatorConfig.__checkpoint
            checkpoint_guid = ([Guid]$script:CurrentValidatorConfig.__checkpoint_guid).ToString('D')
        }
        gates = @($finalGates)
        issued_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    }
    $payload = [ordered]@{}
    foreach ($property in @($receipt.PSObject.Properties)) { $payload[$property.Name] = $property.Value }
    # The canonical contract signs the same payload that is fingerprinted;
    # receipt_sha256 and signature are both absent from this payload.
    $canonicalPayload = ConvertTo-IsolatedCanonicalJson $payload
    $receiptHash = Get-IsolatedTextSha256 $canonicalPayload
    $receipt | Add-Member -NotePropertyName receipt_sha256 -NotePropertyValue $receiptHash -Force
    $receipt | Add-Member -NotePropertyName signature -NotePropertyValue ([pscustomobject][ordered]@{
            algorithm = 'HMAC-SHA256'; key_id = [string]$key.id; hmac_sha256 = (Get-IsolatedHmacSha256 $canonicalPayload $key.bytes)
        }) -Force
    Assert-IsolatedProtectedPath $receiptFull $stateRoot @($script:CurrentValidatorConfig.__acl_principals) $false 'validator receipt'
    Write-IsolatedJsonAtomic $receiptFull $receipt
    Assert-IsolatedProtectedPath $receiptFull $stateRoot @($script:CurrentValidatorConfig.__acl_principals) $true 'validator receipt'
    return $receipt
}

if ($MyInvocation.InvocationName -ne '.') {
    if (-not $RequestPath -or -not $ReceiptPath) { Stop-IsolatedBatchValidator 'only the canonical request and receipt paths may be supplied' }
    Invoke-IsolatedBatchValidatorSupervisor -RequestPath $RequestPath -ReceiptPath $ReceiptPath | Out-Null
}
