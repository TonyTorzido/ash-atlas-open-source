Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:Passed = 0
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
    $script:Passed++
}

function Assert-Throws([scriptblock]$Action, [string]$Message) {
    $thrown = $false
    try { & $Action | Out-Null } catch { $thrown = $true }
    Assert-True $thrown $Message
}

$supervisorPath = Join-Path $PSScriptRoot 'isolated-batch-validator-supervisor.ps1'
$guestPath = Join-Path $PSScriptRoot 'isolated-batch-validator-guest.ps1'
$supervisorSource = Get-Content -Raw -LiteralPath $supervisorPath
$guestSource = Get-Content -Raw -LiteralPath $guestPath

Assert-True ($null -ne [scriptblock]::Create($supervisorSource)) 'supervisor parses as PowerShell'
Assert-True ($null -ne [scriptblock]::Create($guestSource)) 'guest runner parses as PowerShell'
. $supervisorPath
. $guestPath
. (Join-Path $PSScriptRoot '..\dev\runtime-lib.ps1')

Assert-True ((ConvertTo-IsolatedCanonicalJson ([ordered]@{ z = 2; a = 'x'; nested = @($true, $null) })) -ceq
    '{"a":"x","nested":[true,null],"z":2}') 'host canonical JSON sorts object keys and preserves arrays'
Assert-True ((Get-IsolatedTextSha256 'abc') -ceq
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad') `
    'host SHA-256 known answer matches'
$hmacKey = [Text.Encoding]::UTF8.GetBytes('01234567890123456789012345678901')
Assert-True ((Get-IsolatedHmacSha256 'abc' $hmacKey) -ceq
    'd5c75dc69d8243aa0882a04342d9ff7c73537a0311a7950800607be225594009') `
    'host HMAC helper matches the known answer'

$candidate = 'a' * 40
$baseline = 'b' * 40
$plan = [pscustomobject][ordered]@{
    candidate_sha = $candidate
    gates = @(
        [pscustomobject][ordered]@{
            name = 'git_diff_check'; kind = 'native'; file_path = 'git'
            arguments = @('diff', '--check', $baseline, $candidate)
            parallel = $false; deadline_seconds = 60; baseline_comparable = $false
        },
        [pscustomobject][ordered]@{
            name = 'repository_hygiene'; kind = 'native'; file_path = 'pnpm.cmd'
            arguments = @('check:hygiene')
            parallel = $true; deadline_seconds = 60; baseline_comparable = $false
        }
    )
}
$request = [pscustomobject][ordered]@{
    schema_version = 1
    kind = 'ash-atlas-isolated-batch-validation-request'
    operation_id = 'validator-test-001'
    candidate_sha = $candidate
    baseline_sha = $baseline
    manifest_sha256 = 'c' * 64
    tooling_sha = 'd' * 40
    validation_plan_sha256 = 'e' * 64
    validation_toolchain_fingerprint = 'f' * 64
    validator_contract = 'ash-atlas-isolated-uncredentialed-vm/v1'
    plan = $plan
}
$request.validation_plan_sha256 = Get-IsolatedTextSha256 (ConvertTo-IsolatedCanonicalJson $plan)
Assert-True ((Assert-IsolatedGatePlan $request).Count -eq 2) 'host accepts the exact named gate plan'
Assert-True ((Assert-GuestRequest $request).Count -eq 2) 'guest accepts the exact named gate plan'

$vmGuid = [Guid]::NewGuid()
$checkpointGuid = [Guid]::NewGuid()
$imageDigest = 'sha256:' + ('1' * 64)
$imageArtifact = Join-Path ([IO.Path]::GetTempPath()) "isolated-validator-image-$PID.bin"
[IO.File]::WriteAllBytes($imageArtifact, [Text.Encoding]::UTF8.GetBytes('immutable fixture'))
$imageArtifactSha = Get-IsolatedFileSha256 $imageArtifact
function Get-VM { param([Guid]$Id) return [pscustomobject]@{ Id = $Id; Name = 'AshAtlasValidator'; State = 'Off'; Notes = 'misleading-notes-must-not-identify-the-image' } }
function Get-VMSnapshot { param([string]$VMName, [string]$Name) return [pscustomobject]@{ Id = $script:checkpointGuid; Name = $Name; Notes = 'misleading-notes-must-not-identify-the-image' } }
$vmConfigFixture = [pscustomobject]@{
    __vm_guid = $vmGuid
    __checkpoint = 'daily-clean'
    __checkpoint_guid = $checkpointGuid
    __image_digest = $imageDigest
    __image_artifacts = @([pscustomobject]@{ path = $imageArtifact; sha256 = $imageArtifactSha })
}
Assert-True ((Assert-IsolatedVmIdentity $vmConfigFixture).Name -ceq 'AshAtlasValidator') `
    'host accepts only the mocked pinned VM, immutable checkpoint GUID, and image artifact hash'
Remove-Item -LiteralPath $imageArtifact -Force

$unexpected = [pscustomobject][ordered]@{
    name = 'run_arbitrary_command'; kind = 'native'; file_path = 'cmd.exe'
    arguments = @('/c', 'whoami'); deadline_seconds = 60
}
$request.plan.gates = @($request.plan.gates + $unexpected)
Assert-Throws { Assert-IsolatedGatePlan $request } 'host refuses an unexpected gate name or command'
Assert-Throws { Assert-GuestRequest $request } 'guest refuses an unexpected gate name or command'
$request.plan.gates = @($plan.gates)

Assert-True (Test-IsolatedRelativePath 'apps/client/src/App.tsx') 'host accepts a relative changed path'
Assert-True (-not (Test-IsolatedRelativePath '..\outside.txt')) 'host rejects changed path traversal'
Assert-True (Test-GuestRelativePath 'packages/shared/index.ts') 'guest accepts a relative changed path'
Assert-True (-not (Test-GuestRelativePath '\\host\share\secret')) 'guest rejects UNC changed paths'
$script:GuestOperationId = 'validator-test-001'
$browserCommand = Get-GuestBrowserAcceptanceCommand (Join-Path $PSScriptRoot '..\..')
Assert-True ($browserCommand -match 'feature-runtime.ps1' -and $browserCommand -match 'test:full-app' -and
    $browserCommand -match 'ASH_ATLAS_TEST_BASE_URL') 'guest expands the canonical browser gate inside the guest checkout'
Assert-True ($guestSource -match 'Get-GuestRuntimeWorktreeRoot' -and
    $guestSource -match 'feature_worktree_root' -and
    $guestSource -match 'feature_launcher_root' -and
    $guestSource -notmatch 'Join-Path \$Root ''runtime-worktree''') `
    'guest browser worktree follows the pinned canonical feature-runtime root'

function Invoke-GuestRuntimeTestGit {
    param(
        [Parameter(Mandatory = $true)][string]$Repository,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )
    $output = @(& git -C $Repository @Arguments 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "guest runtime fixture git command failed: git -C $Repository $($Arguments -join ' ')`n$($output -join "`n")" }
    return (($output | ForEach-Object { [string]$_ }) -join "`n").Trim()
}

$guestRuntimeFixture = Join-Path $env:TEMP "isolated-validator-runtime-fixture-$PID"
$guestRuntimeRepository = Join-Path $guestRuntimeFixture 'repo'
$guestRuntimeMaterialized = $null
try {
    New-Item -ItemType Directory -Path (Join-Path $guestRuntimeRepository 'config'), (Join-Path $guestRuntimeFixture 'input') -Force | Out-Null
    Invoke-GuestRuntimeTestGit $guestRuntimeRepository @('init', '--quiet') | Out-Null
    Invoke-GuestRuntimeTestGit $guestRuntimeRepository @('config', 'user.name', 'Ash Atlas Validator Tests') | Out-Null
    Invoke-GuestRuntimeTestGit $guestRuntimeRepository @('config', 'user.email', 'validator@ash-atlas.invalid') | Out-Null
    Copy-Item -LiteralPath (Join-Path $root 'config\dev-runtime.defaults.json') -Destination (Join-Path $guestRuntimeRepository 'config\dev-runtime.defaults.json')
    Invoke-GuestRuntimeTestGit $guestRuntimeRepository @('add', 'config/dev-runtime.defaults.json') | Out-Null
    Invoke-GuestRuntimeTestGit $guestRuntimeRepository @('commit', '--quiet', '-m', 'guest runtime fixture') | Out-Null
    $guestRuntimeSha = Invoke-GuestRuntimeTestGit $guestRuntimeRepository @('rev-parse', 'HEAD')
    $guestRuntimeBuildUser = [string]([Security.Principal.WindowsIdentity]::GetCurrent().Name)
    $guestRuntimeMaterialized = Materialize-GuestRuntimeWorktree $guestRuntimeRepository $guestRuntimeFixture $guestRuntimeSha `
        "validator-runtime-$PID" $guestRuntimeBuildUser
    $guestRuntimeConfig = Read-AshAtlasRuntimeDefaults (Join-Path $guestRuntimeRepository 'config\dev-runtime.defaults.json')
    $guestRuntimeIdentity = New-AshAtlasFeatureIdentity $guestRuntimeConfig `
        $guestRuntimeMaterialized.worktree $guestRuntimeMaterialized.branch
    $guestRuntimeConfiguredRoot = [IO.Path]::GetFullPath([string]$guestRuntimeConfig.feature_worktree_root).TrimEnd('\')
    Assert-True ([IO.Path]::GetFullPath([string]$guestRuntimeMaterialized.worktree).StartsWith($guestRuntimeConfiguredRoot + '\', [StringComparison]::OrdinalIgnoreCase)) `
        'guest materialized browser worktree is beneath the canonical feature-runtime root'
    Assert-True ([string]$guestRuntimeIdentity.worktree -ceq [string]$guestRuntimeMaterialized.worktree -and
        [string]$guestRuntimeIdentity.branch -ceq [string]$guestRuntimeMaterialized.branch -and
        (Test-AshAtlasSafeFeatureRuntime $guestRuntimeConfig $guestRuntimeIdentity)) `
        'canonical feature-runtime identity accepts the materialized guest browser worktree'
} finally {
    if ($null -ne $guestRuntimeMaterialized -and (Test-Path -LiteralPath $guestRuntimeMaterialized.worktree)) {
        & git -C $guestRuntimeRepository worktree remove --force $guestRuntimeMaterialized.worktree *> $null
    }
    if (Test-Path -LiteralPath $guestRuntimeFixture) {
        Remove-Item -LiteralPath $guestRuntimeFixture -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Assert-True ($supervisorSource -match "ValidatorConfigPath = 'C:\\ProgramData\\AshAtlas") `
    'supervisor uses the fixed provisioned config location'
Assert-True ($supervisorSource -match 'Restore-VMSnapshot' -and
    $supervisorSource -match 'Start-VM' -and
    $supervisorSource -match 'New-PSSession -VMId' -and
    $supervisorSource -match 'Copy-Item -ToSession' -and
    $supervisorSource -match 'Copy-Item -FromSession' -and
    $supervisorSource -match 'Stop-VM') `
    'supervisor owns the complete restore, guest execution, retrieval, and stop lifecycle'
Assert-True ($supervisorSource -match 'Get-Acl' -and
    $supervisorSource -match 'HMACSHA256' -and
    $supervisorSource -match 'ASH_ATLAS_BATCH_VALIDATOR_HMAC_KEY' -and
    $supervisorSource -match 'host_account') `
    'supervisor enforces ACLs and signs receipts with the host-only HMAC key'
Assert-True ($guestSource -match 'WindowsBuiltInRole]::Administrator' -and
    $guestSource -match 'ASH_ATLAS_ISOLATED_VALIDATOR' -and
    $guestSource -match 'no_host_mounts' -and
    $guestSource -match 'no_secrets') `
    'guest proves standard identity, positive environment, and isolation properties'
Assert-True ($guestSource -notmatch 'ASH_ATLAS_BATCH_VALIDATOR_HMAC_KEY') `
    'guest runner never reads or carries the host validator HMAC key'
Assert-True ($supervisorSource -match 'supervisor_user_name' -and
    $supervisorSource -match 'build_user_name' -and
    $supervisorSource -match 'Set-ValidatorDirectoryAcl' -and
    $supervisorSource -match 'credentials.build') `
    'host provisions distinct trusted supervisor and standard build identities with protected paths'
Assert-True ($supervisorSource -match 'launcherProfileRoot' -and
    $supervisorSource -match 'launcherRoot' -and
    $supervisorSource -match 'Set-ValidatorDirectoryAcl \$launcherRoot \$true \$false' -and
    $supervisorSource -match 'launcher directory ACL' -and
    $supervisorSource -notmatch 'Set-ValidatorDirectoryAcl \$launcherProfileRoot' -and
    $supervisorSource -notmatch 'Set-ValidatorDirectoryAcl \$launcherParent') `
    'host provisions the canonical feature launcher directory with build-only Modify access'
Assert-True ($guestSource -match 'Assert-GuestRuntimeLauncherDirectory' -and
    $guestSource -match 'Ash Atlas Feature Launchers' -and
    $guestSource -match 'pinned guest feature launcher ACL') `
    'guest verifies the canonical launcher directory ACL and reparse boundary before browser execution'
Assert-True ($guestSource -match 'Get-GuestProcessUserName' -and
    $guestSource -match 'BuildCredential' -and
    $guestSource -match 'worktree add' -and
    $guestSource -match 'branch --show-current') `
    'guest runs gates under the pinned build credential and materializes a named browser worktree'
Assert-True ($guestSource -match 'Get-GuestIdentitySid' -and
    $guestSource -match 'SecurityIdentifier' -and
    $guestSource -match 'Test-GuestIdentityEqual') `
    'guest compares configured and observed build identities by resolved SID'
Assert-True ($guestSource -notmatch '(?m)^\s*& git -C \$repository worktree remove' -and
    $guestSource -notmatch '(?m)^\s*& git -C \$repository branch -D') `
    'guest performs no privileged Git cleanup after candidate gates'
$guestExecutionSource = $guestSource.Substring($guestSource.IndexOf('function Invoke-IsolatedBatchValidatorGuest'))
$verifyIndex = $guestSource.IndexOf("'bundle', 'verify'")
$fetchIndex = $guestSource.IndexOf('Get-GuestBundleAdvertisedRef', $guestSource.IndexOf('function Invoke-IsolatedBatchValidatorGuest'))
$initIndex = $guestSource.IndexOf('git init --quiet', $guestSource.IndexOf('function Invoke-IsolatedBatchValidatorGuest'))
Assert-True ($initIndex -ge 0 -and $verifyIndex -ge 0 -and $fetchIndex -gt $initIndex) `
    'guest initializes Git before verifying bundles and fetches their exact advertised refs'
Assert-True ($supervisorSource -notmatch '& git bundle verify' -and $supervisorSource -notmatch '& git bundle list-heads') `
    'host defers bundle prerequisite/ref verification to the initialized guest repository'
Assert-True ($guestSource -notmatch 'ReadToEndAsync') `
    'guest gate capture does not use unbounded ReadToEndAsync streams'
Assert-True ($guestSource -match 'BoundedStreamCapture' -and
    $guestSource -notmatch 'DataReceivedEventHandler' -and
    $guestSource -match 'StdoutTask' -and $guestSource -match 'StderrTask') `
    'guest uses bounded .NET stream tasks instead of PowerShell reader callbacks'
Assert-True ($guestSource -match 'ExpectedRef' -and
    $guestSource -match 'refs/ash-atlas/isolated-validation/' -and
    $guestSource -match 'headPattern') `
    'guest requires the exact authenticated ash-atlas bundle refs'
Assert-True ($guestSource -match 'Assert-GuestRepositoryAcl' -and
    $guestSource -notmatch 'Remove-Item -LiteralPath \$repository') `
    'guest preserves the host-provisioned repository ACL'
Assert-True ($supervisorSource -match '& \$runnerPath' -and
    $supervisorSource -notmatch '\.\s+\$runner') `
    'supervisor invokes the trusted runner without same-scope dot-source parameter collisions'
Assert-True ($supervisorSource -notmatch 'Get-IsolatedProperty \$vm\[0\] ''Notes''') `
    'host never trusts mutable VM Notes for checkpoint or image identity'
$stopIndex = $supervisorSource.IndexOf('Remove-PSSession')
$signIndex = $supervisorSource.LastIndexOf('Get-IsolatedValidatorHmacKey')
Assert-True ($stopIndex -ge 0 -and $signIndex -gt $stopIndex) `
    'host loads the HMAC key only after the guest session is removed'

$fixtureCapture = Invoke-GuestTrustedCommand -FileName 'cmd.exe' -Arguments @(
    '/d', '/s', '/c', 'echo validator-stdout & echo validator-stderr 1>&2 & exit /b 2'
) -WorkingDirectory $env:TEMP -TimeoutSeconds 15
Assert-True ([int]$fixtureCapture.exit_code -eq 2 -and
    [string]$fixtureCapture.stdout -match 'validator-stdout' -and
    [string]$fixtureCapture.stderr -match 'validator-stderr' -and
    -not [bool]$fixtureCapture.output_overflow) `
    'bounded .NET capture preserves stdout/stderr and nonzero cmd exit under Windows PowerShell'

$currentQualifiedIdentity = [string]([Security.Principal.WindowsIdentity]::GetCurrent().Name)
$currentShortIdentity = [string][Environment]::UserName
Assert-True (Test-GuestIdentityEqual $currentQualifiedIdentity $currentShortIdentity) `
    'guest identity comparison accepts qualified and local account forms for the same SID'

$hookFixture = Join-Path ([IO.Path]::GetTempPath()) "isolated-validator-hook-fixture-$PID"
$hookMarker = Join-Path $hookFixture 'hook-fired.txt'
try {
    New-Item -ItemType Directory -Path $hookFixture -Force | Out-Null
    & git init --quiet $hookFixture
    if ($LASTEXITCODE -ne 0) { throw 'could not initialize hook fixture repository' }
    $hookPath = Join-Path $hookFixture '.git\hooks\reference-transaction.cmd'
    Set-Content -LiteralPath $hookPath -Value "@echo hook-fired>>`"$hookMarker`"" -Encoding ASCII
    Assert-True ($guestSource -notmatch '(?m)^\s*& git -C \$repository (?:worktree remove|branch -D)') `
        'candidate reference transaction hook has no privileged post-gate cleanup path'
    Assert-True (-not (Test-Path -LiteralPath $hookMarker)) `
        'candidate reference transaction hook remains inert after gate processing'
} finally {
    if (Test-Path -LiteralPath $hookFixture) { Remove-Item -LiteralPath $hookFixture -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Output "isolated-batch-validator tests passed: $script:Passed"
