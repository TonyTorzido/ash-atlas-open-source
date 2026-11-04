[CmdletBinding()]
param(
    [Parameter(Position = 0, Mandatory = $true)]
    [ValidateSet('status', 'initialize', 'advance', 'publish-infrastructure')]
    [string]$Operation,
    [ValidatePattern('^[0-9a-fA-F]{40}$')]
    [string]$IntegrationTestSha,
    [ValidatePattern('^[0-9a-fA-F]{40}$')]
    [string]$ExpectedIntegrationTestSha,
    [ValidatePattern('^[0-9a-fA-F]{40}$')]
    [string]$ExpectedMasterSha,
    [ValidatePattern('^[0-9a-fA-F]{64}$')]
    [string]$ExpectedSnapshotId,
    [switch]$ConfirmGenerationCheckpoint,
    [switch]$PublishMaster,
    [switch]$ConfirmInfrastructurePublication,
    [switch]$DryRun,
    [switch]$Json,
    [string]$RepositoryPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $RepositoryPath) { $RepositoryPath = Join-Path $PSScriptRoot '..\..' }
$RepositoryPath = [IO.Path]::GetFullPath($RepositoryPath).TrimEnd('\')
$script:RemoteCommandCount = 0
$script:InfrastructureOnlyPaths = @(
    '.gitattributes',
    'tools/dev/test-generation.ps1',
    'tools/dev/test-generation.tests.ps1',
    'tools/dev/integration-admission-policy.tests.ps1',
    'tools/dev/feature-runtime.ps1',
    'tools/dev/feature-merged-receipt.tests.ps1',
    'tools/release/accept-and-publish-test-server.ps1',
    'tools/release/accept-and-publish-test-server.tests.ps1',
    'tools/release/deployment-transport.ps1',
    'tools/release/install-vps-updater.ps1',
    'tools/release/invoke-client-only-canary-rollback.ps1',
    'tools/release/promote-world-runtime.ps1',
    'tools/release/promote-world-runtime.tests.ps1',
    'tools/release/release-coordination.tests.ps1',
    'tools/release/release-flow.tests.ps1',
    'tools/release/release-path-lib.ps1',
    'tools/release/vps/ash-atlas-deploy@.service',
    'tools/release/vps/ash-atlas-deployment-reconcile.service',
    'tools/release/vps/ash-atlas-deployment-reconcile.timer',
    'tools/release/vps/ash-atlas-deployment-request.service',
    'tools/release/vps/ash-atlas-deployment-request.timer',
    'tools/release/vps/deploy-control.sh',
    'tools/release/vps/deploy-control.tests.sh',
    'tools/release/vps/deploy-test-update.sh',
    'tools/release/vps/deployment-controller.conf',
    'tools/release/vps/deployment-status.caddy',
    'tools/release/vps/game-cache-policy.caddy',
    'tools/release/vps/install-release-controller.sh',
    'tools/release/vps/poll-deployment-request.sh',
    'tools/release/vps/promote-world-runtime.sh',
    'tools/release/vps/promote-world-runtime.tests.sh'
)
$script:RequiredReleaseLfAttributes = @(
    'tools/release/vps/*.sh text eol=lf',
    'tools/release/vps/*.service text eol=lf',
    'tools/release/vps/*.caddy text eol=lf',
    'tools/release/vps/deployment-controller.conf text eol=lf'
)

function ConvertTo-GenerationNativeArgument {
    param([AllowEmptyString()][Parameter(Mandatory = $true)][string]$Value)
    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
    $quoted = [Text.StringBuilder]::new()
    [void]$quoted.Append('"')
    $backslashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') { $backslashes++; continue }
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

function Invoke-GenerationGit {
    param([Parameter(Mandatory = $true)][string[]]$Arguments, [switch]$AllowFailure)
    if ($Arguments.Count -gt 0 -and $Arguments[0] -in @('fetch', 'ls-remote', 'push')) {
        $script:RemoteCommandCount++
    }
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = 'git'
    $startInfo.WorkingDirectory = $RepositoryPath
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.Arguments = (@($Arguments | ForEach-Object { ConvertTo-GenerationNativeArgument ([string]$_) }) -join ' ')
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) { throw 'Could not start git.' }
        $stdout = $process.StandardOutput.ReadToEnd()
        $stderr = $process.StandardError.ReadToEnd()
        $process.WaitForExit()
        $result = [pscustomobject]@{
            ExitCode = [int]$process.ExitCode
            StdOut = $stdout.Trim()
            StdErr = $stderr.Trim()
        }
        if (-not $AllowFailure -and $result.ExitCode -ne 0) {
            throw "git $($Arguments -join ' ') failed: $($result.StdErr)"
        }
        return $result
    } finally {
        $process.Dispose()
    }
}

function Get-TextSha256 {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)))).Replace('-', '').ToLowerInvariant()
    } finally {
        $algorithm.Dispose()
    }
}

function Assert-GenerationNames {
    param([object[]]$Records)
    $numbers = @()
    foreach ($record in @($Records)) {
        if ([string]$record.name -notmatch '^test/t(\d{3,4})$') {
            throw "REFUSED: malformed generation tag '$($record.name)'. Expected test/tNNN or test/tNNNN."
        }
        $numbers += [int]$Matches[1]
    }
    $numbers = @($numbers | Sort-Object)
    for ($index = 0; $index -lt $numbers.Count; $index++) {
        $expectedName = "test/t$($index.ToString('D3'))"
        if ($numbers[$index] -ne $index -or @($Records.name) -notcontains $expectedName) {
            throw "REFUSED: generation tags contain a duplicate or gap at test/t$($index.ToString('D3'))."
        }
    }
}

function Get-RemoteGenerationSnapshot {
    $result = Invoke-GenerationGit @(
        'ls-remote', 'origin',
        'refs/heads/integration/test',
        'refs/heads/master',
        'refs/tags/test/*'
    )
    $branchSha = ''
    $masterSha = ''
    $tagObjects = @{}
    $peeled = @{}
    foreach ($line in @($result.StdOut -split '\r?\n' | Where-Object { $_ })) {
        if ($line -notmatch '^([0-9a-f]{40})\s+(.+)$') {
            throw "REFUSED: malformed remote ref output: $line"
        }
        $sha = $Matches[1]
        $ref = $Matches[2]
        if ($ref -eq 'refs/heads/integration/test') {
            if ($branchSha) { throw 'REFUSED: origin/integration/test appeared more than once.' }
            $branchSha = $sha
            continue
        }
        if ($ref -eq 'refs/heads/master') {
            if ($masterSha) { throw 'REFUSED: origin/master appeared more than once.' }
            $masterSha = $sha
            continue
        }
        if ($ref -notmatch '^refs/tags/(test/.+?)(\^\{\})?$') {
            throw "REFUSED: unexpected remote ref in generation snapshot: $ref"
        }
        $name = $Matches[1]
        if ($Matches[2]) { $peeled[$name] = $sha }
        else { $tagObjects[$name] = $sha }
    }
    if ($branchSha -notmatch '^[0-9a-f]{40}$') {
        throw 'REFUSED: origin/integration/test did not resolve to one exact SHA.'
    }
    foreach ($name in $peeled.Keys) {
        if (-not $tagObjects.ContainsKey($name)) {
            throw "REFUSED: peeled generation tag '$name' has no tag object."
        }
    }
    $records = @($tagObjects.Keys | ForEach-Object {
        [pscustomobject]@{
            name = [string]$_
            object_sha = [string]$tagObjects[$_]
            commit_sha = $(if ($peeled.ContainsKey($_)) { [string]$peeled[$_] } else { [string]$tagObjects[$_] })
        }
    })
    Assert-GenerationNames $records
    $records = @($records | Sort-Object { [int]([string]$_.name).Substring(6) })
    $duplicateCommits = @($records | Group-Object commit_sha | Where-Object Count -gt 1)
    if ($duplicateCommits.Count -gt 0) {
        throw "REFUSED: multiple generation tags point to $($duplicateCommits[0].Name)."
    }
    $canonical = @(
        "refs/heads/integration/test $branchSha",
        "refs/heads/master $masterSha"
    )
    $canonical += @($records | ForEach-Object {
        "refs/tags/$($_.name) $($_.object_sha) $($_.commit_sha)"
    })
    return [pscustomobject][ordered]@{
        integration_test_sha = $branchSha
        master_sha = $masterSha
        generation_refs = $records
        snapshot_id = Get-TextSha256 ($canonical -join "`n")
    }
}

function Get-CommitChangedPaths {
    param([Parameter(Mandatory = $true)][string]$Commit)
    $result = Invoke-GenerationGit @(
        'diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-m', $Commit
    )
    return @($result.StdOut -split '\r?\n' | Where-Object { $_ })
}

function Get-CommitFileLines {
    param(
        [Parameter(Mandatory = $true)][string]$Commit,
        [Parameter(Mandatory = $true)][string]$Path
    )
    $result = Invoke-GenerationGit @('show', "$Commit`:$Path") -AllowFailure
    if ($result.ExitCode -ne 0) { return $null }
    if ($result.StdOut.Contains("`r")) {
        throw "REFUSED: infrastructure path '$Path' contains carriage returns in $Commit."
    }
    return @($result.StdOut -split '\n')
}

function Test-ReleaseAttributesTransition {
    param(
        [Parameter(Mandatory = $true)][string]$Parent,
        [Parameter(Mandatory = $true)][string]$Commit
    )
    $before = @(Get-CommitFileLines $Parent '.gitattributes')
    $after = @(Get-CommitFileLines $Commit '.gitattributes')
    if ($after.Count -eq 0) { return $false }

    foreach ($rule in $script:RequiredReleaseLfAttributes) {
        if (@($after | Where-Object { $_ -ceq $rule }).Count -ne 1) { return $false }
    }

    $requiredAdditions = @()
    foreach ($rule in $script:RequiredReleaseLfAttributes) {
        if (@($before | Where-Object { $_ -ceq $rule }).Count -eq 0) {
            $requiredAdditions += $rule
        }
    }
    $added = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $patch = Invoke-GenerationGit @(
        'diff', '--no-ext-diff', '--unified=0', $Parent, $Commit, '--', '.gitattributes'
    )
    foreach ($line in @($patch.StdOut -split '\r?\n')) {
        if ($line.StartsWith('---') -or $line.StartsWith('+++')) { continue }
        if ($line.StartsWith('-')) { return $false }
        if ($line.StartsWith('+')) {
            $addition = $line.Substring(1)
            if ($requiredAdditions -cnotcontains $addition -or -not $added.Add($addition)) {
                return $false
            }
        }
    }
    return $added.Count -eq $requiredAdditions.Count
}

function Test-CommitReleaseAttributes {
    param([Parameter(Mandatory = $true)][string]$Commit)
    $parentsResult = Invoke-GenerationGit @('rev-list', '--parents', '-n', '1', $Commit)
    $parts = @($parentsResult.StdOut -split ' ' | Where-Object { $_ })
    if ($parts.Count -lt 2) { return $false }
    foreach ($parent in @($parts | Select-Object -Skip 1)) {
        if (-not (Test-ReleaseAttributesTransition $parent $Commit)) { return $false }
    }
    return $true
}

function Get-InfrastructureIntervalAdmission {
    param(
        [Parameter(Mandatory = $true)]$Base,
        [Parameter(Mandatory = $true)][string]$HeadSha
    )
    if ([string]$Base.commit_sha -eq $HeadSha) {
        return [pscustomobject]@{ accepted = $false; reason = 'interval is gameplay-tagged'; base = $Base }
    }
    Assert-LocalCommit ([string]$Base.commit_sha) "refs/tags/$($Base.name)"
    Assert-LocalCommit $HeadSha 'refs/heads/integration/test'
    $ancestor = Invoke-GenerationGit @(
        'merge-base', '--is-ancestor', [string]$Base.commit_sha, $HeadSha
    ) -AllowFailure
    if ($ancestor.ExitCode -ne 0) {
        return [pscustomobject]@{ accepted = $false; reason = 'head does not descend from gameplay generation'; base = $Base }
    }
    $commitsResult = Invoke-GenerationGit @('rev-list', '--reverse', "$($Base.commit_sha)..$HeadSha")
    $commits = @($commitsResult.StdOut -split '\r?\n' | Where-Object { $_ })
    if ($commits.Count -eq 0) {
        return [pscustomobject]@{ accepted = $false; reason = 'infrastructure interval is empty'; base = $Base }
    }
    foreach ($commit in $commits) {
        foreach ($path in @(Get-CommitChangedPaths $commit)) {
            if ($script:InfrastructureOnlyPaths -cnotcontains $path) {
                return [pscustomobject]@{
                    accepted = $false
                    reason = "non-infrastructure path '$path' appears in $commit"
                    base = $Base
                }
            }
            if ($path -ceq '.gitattributes' -and -not (Test-CommitReleaseAttributes $commit)) {
                return [pscustomobject]@{
                    accepted = $false
                    reason = "unsafe .gitattributes mutation appears in $commit"
                    base = $Base
                }
            }
        }
    }
    return [pscustomobject]@{
        accepted = $true
        reason = 'every intervening commit changes only exact approved release-controller paths'
        base = $Base
        commits = $commits
    }
}

function Get-InfrastructureHeadAdmission {
    param(
        [Parameter(Mandatory = $true)]$Snapshot,
        [Parameter(Mandatory = $true)][string]$HeadSha
    )
    $records = @($Snapshot.generation_refs)
    if ($records.Count -eq 0) {
        return [pscustomobject]@{ accepted = $false; reason = 'no immutable gameplay generation exists'; base = $null }
    }
    $base = $records[-1]
    if ([string]$Snapshot.integration_test_sha -eq $HeadSha -and
        [string]$Snapshot.master_sha -ne $HeadSha) {
        return [pscustomobject]@{ accepted = $false; reason = 'protected refs diverge'; base = $base }
    }
    return Get-InfrastructureIntervalAdmission $base $HeadSha
}

function Get-ApprovedGenerationBase {
    param(
        [Parameter(Mandatory = $true)]$Snapshot,
        [Parameter(Mandatory = $true)][string]$HeadSha
    )
    $records = @($Snapshot.generation_refs)
    $exact = @($records | Where-Object commit_sha -eq $HeadSha)
    if ($exact.Count -eq 1) { return $exact[0] }
    Assert-LocalCommit $HeadSha 'refs/heads/integration/test'
    foreach ($record in @($records | Sort-Object {
                [int]([string]$_.name).Substring(6)
            } -Descending)) {
        $ancestor = Invoke-GenerationGit @(
            'merge-base', '--is-ancestor', [string]$record.commit_sha, $HeadSha
        ) -AllowFailure
        if ($ancestor.ExitCode -eq 0) {
            $admission = Get-InfrastructureIntervalAdmission $record $HeadSha
            if ($admission.accepted) { return $record }
            throw "REFUSED: approved original integration SHA $HeadSha is not an admitted infrastructure head: $($admission.reason)."
        }
    }
    throw "REFUSED: approved original integration SHA $HeadSha does not descend from an immutable gameplay generation."
}

function Get-GenerationState {
    param([Parameter(Mandatory = $true)]$Snapshot)
    $exact = @($Snapshot.generation_refs | Where-Object commit_sha -eq $Snapshot.integration_test_sha)
    if ($exact.Count -gt 1) {
        throw "REFUSED: origin/integration/test has multiple generation labels at $($Snapshot.integration_test_sha)."
    }
    $nextNumber = @($Snapshot.generation_refs).Count
    if ($nextNumber -gt 9999) { throw 'REFUSED: four-digit generation labels are exhausted.' }
    $latest = if ($nextNumber -gt 0) { @($Snapshot.generation_refs)[-1] } else { $null }
    $infrastructure = if ($exact.Count -eq 0 -and $null -ne $latest) {
        Get-InfrastructureHeadAdmission $Snapshot ([string]$Snapshot.integration_test_sha)
    } else { $null }
    return [pscustomobject][ordered]@{
        integration_test_sha = [string]$Snapshot.integration_test_sha
        master_sha = [string]$Snapshot.master_sha
        generation = $(if ($exact.Count -eq 1) { [string]$exact[0].name.Substring(5) } else { $null })
        latest_generation = $(if ($null -ne $latest) { [string]$latest.name.Substring(5) } else { $null })
        latest_generation_sha = $(if ($null -ne $latest) { [string]$latest.commit_sha } else { $null })
        infrastructure_head_accepted = [bool]($null -ne $infrastructure -and $infrastructure.accepted)
        infrastructure_head_reason = $(if ($null -ne $infrastructure) { [string]$infrastructure.reason } else { '' })
        next_generation = "t$($nextNumber.ToString('D3'))"
        records = @($Snapshot.generation_refs)
        snapshot_id = [string]$Snapshot.snapshot_id
    }
}

function Assert-ExpectedSnapshot {
    param([Parameter(Mandatory = $true)]$Snapshot)
    if ($ExpectedSnapshotId -and [string]$Snapshot.snapshot_id -ne $ExpectedSnapshotId.ToLowerInvariant()) {
        throw "REFUSED: remote snapshot $($Snapshot.snapshot_id) differs from approved snapshot $($ExpectedSnapshotId.ToLowerInvariant())."
    }
}

function Assert-LocalCommit {
    param([Parameter(Mandatory = $true)][string]$Sha, [string]$RemoteRef)
    $resolved = Invoke-GenerationGit @('rev-parse', "$Sha^{commit}") -AllowFailure
    if ($resolved.ExitCode -ne 0 -and $RemoteRef) {
        Invoke-GenerationGit @('fetch', 'origin', '--no-tags', $RemoteRef) | Out-Null
        $resolved = Invoke-GenerationGit @('rev-parse', "$Sha^{commit}") -AllowFailure
    }
    if ($resolved.ExitCode -ne 0 -or $resolved.StdOut -ne $Sha) {
        throw "REFUSED: $Sha is not an available exact commit."
    }
}

function Assert-Ancestor {
    param([string]$Ancestor, [string]$Descendant, [string]$Message)
    $result = Invoke-GenerationGit @('merge-base', '--is-ancestor', $Ancestor, $Descendant) -AllowFailure
    if ($result.ExitCode -ne 0) { throw $Message }
}

function Compare-GenerationNamespace {
    param([object[]]$Before, [object[]]$After, [string]$AllowedNewName = '', [string]$AllowedNewSha = '')
    $expected = @($Before | ForEach-Object { "$($_.name) $($_.object_sha) $($_.commit_sha)" })
    if ($AllowedNewName) { $expected += "test/$AllowedNewName $AllowedNewSha $AllowedNewSha" }
    $actual = @($After | ForEach-Object { "$($_.name) $($_.object_sha) $($_.commit_sha)" })
    return (($expected -join "`n") -ceq ($actual -join "`n"))
}

function Write-GenerationSuccess {
    param(
        [string]$PreviousGeneration,
        [string]$NewGeneration,
        [string]$Sha,
        [string]$SnapshotId,
        [bool]$AlreadyCompleted = $false
    )
    $result = [pscustomobject][ordered]@{
        previous_generation = $PreviousGeneration
        new_generation = $NewGeneration
        integration_test_sha = $Sha
        snapshot_id = $SnapshotId
        already_completed = $AlreadyCompleted
        remote_command_count = $script:RemoteCommandCount
    }
    if ($Json) { $result | ConvertTo-Json -Compress }
    else {
        if ($AlreadyCompleted) { Write-Host "Already completed: test/$NewGeneration at $Sha." -ForegroundColor Green }
        else { Write-Host "Published test/$NewGeneration at $Sha." -ForegroundColor Green }
        if ($PreviousGeneration) { Write-Host "Previous generation: $PreviousGeneration" }
        Write-Host "Remote commands: $($script:RemoteCommandCount)"
    }
}

if (-not (Test-Path -LiteralPath $RepositoryPath -PathType Container)) {
    throw "Repository path is missing: $RepositoryPath"
}
$topLevel = (Invoke-GenerationGit @('rev-parse', '--show-toplevel')).StdOut
if (-not [string]::Equals([IO.Path]::GetFullPath($topLevel).TrimEnd('\'), $RepositoryPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw "RepositoryPath must be the repository root, not '$RepositoryPath'."
}

$snapshot = Get-RemoteGenerationSnapshot
$state = Get-GenerationState $snapshot
Assert-ExpectedSnapshot $snapshot

if ($Operation -eq 'status') {
    if ($IntegrationTestSha -or $ExpectedIntegrationTestSha -or $ExpectedMasterSha -or $ConfirmGenerationCheckpoint -or
        $PublishMaster -or $ConfirmInfrastructurePublication -or $DryRun) {
        throw 'status accepts only -ExpectedSnapshotId, -RepositoryPath, and -Json.'
    }
    $output = [pscustomobject][ordered]@{
        integration_test_sha = $state.integration_test_sha
        master_sha = $state.master_sha
        generation = $state.generation
        latest_generation = $state.latest_generation
        latest_generation_sha = $state.latest_generation_sha
        infrastructure_head_accepted = $state.infrastructure_head_accepted
        infrastructure_head_reason = $state.infrastructure_head_reason
        next_generation = $state.next_generation
        snapshot_id = $state.snapshot_id
        generation_refs = $state.records
        remote_command_count = $script:RemoteCommandCount
    }
    if ($Json) { $output | ConvertTo-Json -Depth 5 -Compress }
    else {
        Write-Host "Integration test SHA: $($output.integration_test_sha)"
        Write-Host "Master SHA: $($output.master_sha)"
        Write-Host "Protected head generation: $(if ($output.generation) { $output.generation } else { '(untagged)' })"
        Write-Host "Latest gameplay generation: $($output.latest_generation)@$($output.latest_generation_sha)"
        Write-Host "Infrastructure head accepted: $($output.infrastructure_head_accepted)"
        Write-Host "Next generation: $($output.next_generation)"
        Write-Host "Snapshot: $($output.snapshot_id)"
        Write-Host "Remote commands: $($output.remote_command_count)"
    }
    exit 0
}

if ($Operation -eq 'publish-infrastructure') {
    if ($ExpectedMasterSha) { throw 'publish-infrastructure does not accept -ExpectedMasterSha.' }
    if (-not $ConfirmInfrastructurePublication) {
        throw 'publish-infrastructure requires -ConfirmInfrastructurePublication.'
    }
    if (-not $ConfirmGenerationCheckpoint) {
        throw 'publish-infrastructure requires -ConfirmGenerationCheckpoint.'
    }
    if (-not $IntegrationTestSha -or -not $ExpectedIntegrationTestSha) {
        throw 'publish-infrastructure requires the candidate and approved protected head SHAs.'
    }
    $IntegrationTestSha = $IntegrationTestSha.ToLowerInvariant()
    $ExpectedIntegrationTestSha = $ExpectedIntegrationTestSha.ToLowerInvariant()
    if ($snapshot.integration_test_sha -eq $IntegrationTestSha -and
        $snapshot.master_sha -eq $IntegrationTestSha) {
        if ($state.generation) {
            throw 'REFUSED: completed infrastructure publication unexpectedly created a gameplay tag.'
        }
        $admittedRetry = Get-InfrastructureHeadAdmission $snapshot $IntegrationTestSha
        if (-not $admittedRetry.accepted) {
            throw "REFUSED: completed infrastructure publication is not admitted: $($admittedRetry.reason)."
        }
        Write-GenerationSuccess $state.latest_generation '' $IntegrationTestSha $state.snapshot_id $true
        exit 0
    }
    if ($snapshot.integration_test_sha -ne $ExpectedIntegrationTestSha -or
        $snapshot.master_sha -ne $ExpectedIntegrationTestSha) {
        throw 'REFUSED: protected refs differ from the approved infrastructure publication base.'
    }
    if ($snapshot.integration_test_sha -ne $state.latest_generation_sha -and
        -not $state.infrastructure_head_accepted) {
        throw "REFUSED: current untagged protected head is not admitted: $($state.infrastructure_head_reason)."
    }
    if (@($snapshot.generation_refs | Where-Object name -eq "test/$($state.next_generation)").Count -ne 0) {
        throw "REFUSED: next gameplay generation test/$($state.next_generation) already exists."
    }
    Assert-LocalCommit $IntegrationTestSha ''
    Assert-Ancestor $ExpectedIntegrationTestSha $IntegrationTestSha `
        "REFUSED: infrastructure candidate $IntegrationTestSha does not descend from approved protected head $ExpectedIntegrationTestSha."
    $candidateAdmission = Get-InfrastructureIntervalAdmission `
        @($snapshot.generation_refs)[-1] $IntegrationTestSha
    if (-not $candidateAdmission.accepted) {
        throw "REFUSED: infrastructure candidate is not admitted: $($candidateAdmission.reason)."
    }
    if ($DryRun) {
        $dryRunResult = [pscustomobject][ordered]@{
            latest_tag = "test/$($state.latest_generation)"
            latest_tag_sha = [string]$state.latest_generation_sha
            protected_infrastructure_head = [string]$state.integration_test_sha
            interval_accepted = [bool]$state.infrastructure_head_accepted
            next_tag = "test/$($state.next_generation)"
            vps_verification = 'deferred'
            mutation_required = $IntegrationTestSha -ne $ExpectedIntegrationTestSha
        }
        if ($Json) { $dryRunResult | ConvertTo-Json -Compress }
        else {
            Write-Host "Latest tag: $($dryRunResult.latest_tag)"
            Write-Host "Protected infrastructure head: $($dryRunResult.protected_infrastructure_head)"
            Write-Host "Interval accepted: $($dryRunResult.interval_accepted)"
            Write-Host "Next tag: $($dryRunResult.next_tag)"
            Write-Host "VPS verification: $($dryRunResult.vps_verification)"
            Write-Host "Mutation required: $($dryRunResult.mutation_required)"
        }
        exit 0
    }
    $prePushSnapshot = Get-RemoteGenerationSnapshot
    if ($prePushSnapshot.snapshot_id -ne $snapshot.snapshot_id -or
        $prePushSnapshot.integration_test_sha -ne $ExpectedIntegrationTestSha -or
        $prePushSnapshot.master_sha -ne $ExpectedIntegrationTestSha) {
        throw 'REFUSED: authoritative protected refs or generation namespace changed before infrastructure publication.'
    }
    try {
        Invoke-GenerationGit @(
            'push', '--atomic', 'origin',
            "$IntegrationTestSha`:refs/heads/integration/test",
            "$IntegrationTestSha`:refs/heads/master"
        ) | Out-Null
    } catch {
        $pushFailure = $_.Exception.Message
        $failedSnapshot = Get-RemoteGenerationSnapshot
        if ($failedSnapshot.snapshot_id -ne $snapshot.snapshot_id) {
            throw "REFUSED: atomic infrastructure publication failed and remote state changed or is ambiguous: $pushFailure"
        }
        throw "REFUSED: atomic infrastructure publication failed; verified neither protected ref changed: $pushFailure"
    }
    $finalSnapshot = Get-RemoteGenerationSnapshot
    if ($finalSnapshot.integration_test_sha -ne $IntegrationTestSha -or
        $finalSnapshot.master_sha -ne $IntegrationTestSha -or
        -not (Compare-GenerationNamespace @($snapshot.generation_refs) @($finalSnapshot.generation_refs))) {
        throw 'REFUSED: infrastructure publication did not leave both protected refs exact with the generation namespace unchanged.'
    }
    $finalState = Get-GenerationState $finalSnapshot
    if (-not $finalState.infrastructure_head_accepted) {
        throw "REFUSED: published infrastructure head is not admitted: $($finalState.infrastructure_head_reason)."
    }
    Write-GenerationSuccess $state.latest_generation '' $IntegrationTestSha $finalSnapshot.snapshot_id
    exit 0
}

if (-not $ConfirmGenerationCheckpoint) {
    throw "$Operation requires -ConfirmGenerationCheckpoint."
}
if ($DryRun) { throw '-DryRun is supported only by publish-infrastructure.' }

if ($Operation -eq 'initialize') {
    if ($IntegrationTestSha -or $ExpectedIntegrationTestSha -or $ExpectedMasterSha) {
        throw 'initialize resolves origin/integration/test and does not accept integration SHA arguments.'
    }
    if ($state.records.Count -ne 0) {
        $existing = @($state.records | Where-Object name -eq 'test/t000')
        if ($existing.Count -eq 1 -and [string]$existing[0].commit_sha -eq $state.integration_test_sha) {
            Write-GenerationSuccess '' 't000' $state.integration_test_sha $state.snapshot_id $true
            exit 0
        }
        throw 'REFUSED: initialize is allowed only when no test/tNNN or test/tNNNN tags exist.'
    }
    Invoke-GenerationGit @(
        'push', '--atomic',
        'origin',
        "$($state.integration_test_sha):refs/tags/test/t000"
    ) | Out-Null
    $final = Get-RemoteGenerationSnapshot
    if ($final.integration_test_sha -ne $state.integration_test_sha -or
        -not (Compare-GenerationNamespace @() @($final.generation_refs) 't000' $state.integration_test_sha)) {
        throw 'REFUSED: initialization did not leave the exact branch-and-tag state requested.'
    }
    Write-GenerationSuccess '' 't000' $state.integration_test_sha $final.snapshot_id
    exit 0
}

if (-not $IntegrationTestSha -or -not $ExpectedIntegrationTestSha) {
    throw 'advance requires -IntegrationTestSha (candidate) and -ExpectedIntegrationTestSha (approved original remote tip).'
}
$IntegrationTestSha = $IntegrationTestSha.ToLowerInvariant()
$ExpectedIntegrationTestSha = $ExpectedIntegrationTestSha.ToLowerInvariant()
$approvedMasterSha = if ($ExpectedMasterSha) {
    $ExpectedMasterSha.ToLowerInvariant()
} else {
    $ExpectedIntegrationTestSha
}
if ($ExpectedMasterSha -and -not $PublishMaster) {
    throw '-ExpectedMasterSha requires -PublishMaster.'
}
if ($state.records.Count -eq 0) {
    throw 'REFUSED: advance requires an existing test/t000 checkpoint; run initialize first.'
}

$previous = Get-ApprovedGenerationBase $snapshot $ExpectedIntegrationTestSha
$previousNumber = [int]([string]$previous.name).Substring(6)
$newGeneration = "t$(($previousNumber + 1).ToString('D3'))"
$newName = "test/$newGeneration"
$newTag = @($state.records | Where-Object name -eq $newName)

if ($newTag.Count -eq 1) {
    if ([string]$newTag[0].commit_sha -ne $IntegrationTestSha) {
        throw "REFUSED: expected retry tag $newName exists at $($newTag[0].commit_sha), not requested SHA $IntegrationTestSha."
    }
    if ($state.integration_test_sha -eq $IntegrationTestSha) {
        if ($previousNumber + 1 -ne $state.records.Count - 1) {
            throw "REFUSED: completed retry tag $newName is not the final continuous generation."
        }
        if ($PublishMaster -and $snapshot.master_sha -ne $IntegrationTestSha) {
            throw "REFUSED: completed retry has master at $($snapshot.master_sha), not $IntegrationTestSha."
        }
        Assert-LocalCommit $IntegrationTestSha "refs/tags/$newName"
        Assert-LocalCommit $ExpectedIntegrationTestSha "refs/tags/$($previous.name)"
        Assert-Ancestor $ExpectedIntegrationTestSha $IntegrationTestSha `
            "REFUSED: completed retry SHA $IntegrationTestSha does not descend from $ExpectedIntegrationTestSha."
        Write-GenerationSuccess ([string]$previous.name.Substring(5)) $newGeneration $IntegrationTestSha $state.snapshot_id $true
        exit 0
    }
    if ($state.integration_test_sha -eq $ExpectedIntegrationTestSha) {
        throw "REFUSED: partial state: $newName exists at $IntegrationTestSha but origin/integration/test remains $ExpectedIntegrationTestSha."
    }
    throw "REFUSED: partial state: $newName is correct at $IntegrationTestSha but origin/integration/test is $($state.integration_test_sha)."
}
if ($newTag.Count -gt 1) { throw "REFUSED: duplicate remote ref records exist for $newName." }
if ($state.integration_test_sha -eq $IntegrationTestSha) {
    throw "REFUSED: partial state: origin/integration/test advanced to $IntegrationTestSha without required $newName."
}
if ($state.integration_test_sha -ne $ExpectedIntegrationTestSha) {
    throw "REFUSED: origin/integration/test changed from approved $ExpectedIntegrationTestSha to $($state.integration_test_sha)."
}
if ($PublishMaster -and $snapshot.master_sha -ne $approvedMasterSha) {
    throw "REFUSED: origin/master changed from approved $approvedMasterSha to $($snapshot.master_sha)."
}
if ($previousNumber -ne $state.records.Count - 1) {
    throw "REFUSED: approved original generation $($previous.name) is not the latest generation."
}
if ($IntegrationTestSha -eq $ExpectedIntegrationTestSha) {
    throw 'REFUSED: candidate integration SHA must differ from the approved original tip.'
}

Assert-LocalCommit $ExpectedIntegrationTestSha "refs/tags/$($previous.name)"
Assert-LocalCommit $IntegrationTestSha ''
Assert-Ancestor $ExpectedIntegrationTestSha $IntegrationTestSha `
    "REFUSED: candidate $IntegrationTestSha does not descend from approved integration tip $ExpectedIntegrationTestSha."
if ($PublishMaster) {
    Assert-LocalCommit $approvedMasterSha ''
    Assert-Ancestor $approvedMasterSha $ExpectedIntegrationTestSha `
        "REFUSED: approved master $approvedMasterSha is not an ancestor of approved integration tip $ExpectedIntegrationTestSha."
}

$prePushSnapshot = Get-RemoteGenerationSnapshot
if ($prePushSnapshot.snapshot_id -ne $snapshot.snapshot_id -or
    $prePushSnapshot.integration_test_sha -ne $ExpectedIntegrationTestSha -or
    ($PublishMaster -and $prePushSnapshot.master_sha -ne $approvedMasterSha) -or
    @($prePushSnapshot.generation_refs | Where-Object name -eq $newName).Count -ne 0) {
    throw 'REFUSED: authoritative branch or generation namespace changed during final pre-push validation.'
}

try {
    $refspecs = @(
        'push', '--atomic',
        'origin',
        "$IntegrationTestSha`:refs/heads/integration/test",
        "$IntegrationTestSha`:refs/tags/test/$newGeneration"
    )
    if ($PublishMaster) {
        $refspecs += "$IntegrationTestSha`:refs/heads/master"
    }
    Invoke-GenerationGit $refspecs | Out-Null
} catch {
    $pushFailure = $_.Exception.Message
    $failedSnapshot = Get-RemoteGenerationSnapshot
    if ($failedSnapshot.snapshot_id -ne $snapshot.snapshot_id) {
        throw "REFUSED: normal atomic publication failed and remote state changed or is ambiguous: $pushFailure"
    }
    throw "REFUSED: normal atomic publication failed; verified neither protected ref changed: $pushFailure"
}

$finalSnapshot = Get-RemoteGenerationSnapshot
if ($finalSnapshot.integration_test_sha -ne $IntegrationTestSha) {
    throw "REFUSED: atomic publication verification found integration/test at $($finalSnapshot.integration_test_sha), expected $IntegrationTestSha."
}
if ($PublishMaster -and $finalSnapshot.master_sha -ne $IntegrationTestSha) {
    throw "REFUSED: atomic publication verification found master at $($finalSnapshot.master_sha), expected $IntegrationTestSha."
}
if (-not (Compare-GenerationNamespace @($snapshot.generation_refs) @($finalSnapshot.generation_refs) $newGeneration $IntegrationTestSha)) {
    throw 'REFUSED: generation namespace after atomic publication differs from the exact expected snapshot plus one new tag.'
}
Write-GenerationSuccess ([string]$previous.name.Substring(5)) $newGeneration $IntegrationTestSha $finalSnapshot.snapshot_id
