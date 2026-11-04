$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$helper = Join-Path $PSScriptRoot 'test-generation.ps1'
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$tempRoot = Join-Path $env:TEMP ("ash-atlas-generation-tests-" + [guid]::NewGuid().ToString('n'))
$script:Passed = 0
$script:Benchmark = @()

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
    $script:Passed++
}

function Assert-Equal($Actual, $Expected, [string]$Message) {
    if ($Actual -ne $Expected) { throw "ASSERTION FAILED: $Message. Expected '$Expected', got '$Actual'." }
    $script:Passed++
}

function Invoke-TestGit {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string[]]$Arguments)
    $old = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = @(& git -C $Path @Arguments 2>&1)
    } finally { $ErrorActionPreference = $old }
    if ($LASTEXITCODE -ne 0) { throw "git $($Arguments -join ' ') failed: $($output -join [Environment]::NewLine)" }
    return ($output -join "`n").Trim()
}

function Invoke-Helper {
    param([string]$Repository, [string[]]$Arguments, [switch]$ExpectFailure)
    $started = Get-Date
    $old = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = @(& powershell -NoProfile -ExecutionPolicy Bypass -File $helper @Arguments -RepositoryPath $Repository 2>&1)
    } finally { $ErrorActionPreference = $old }
    $duration = [math]::Round(((Get-Date) - $started).TotalMilliseconds)
    if ($ExpectFailure) {
        if ($LASTEXITCODE -eq 0) { throw "ASSERTION FAILED: helper unexpectedly succeeded: $($Arguments -join ' ')" }
        $script:Passed++
        return [pscustomobject]@{ Text = ($output -join "`n"); DurationMs = $duration; Json = $null }
    }
    if ($LASTEXITCODE -ne 0) { throw "helper failed: $($output -join [Environment]::NewLine)" }
    $text = ($output -join "`n")
    $json = if ($Arguments -contains '-Json') { $text | ConvertFrom-Json } else { $null }
    return [pscustomobject]@{ Text = $text; DurationMs = $duration; Json = $json }
}

function New-Fixture {
    param([string]$Name, [int]$TagCount)
    $root = Join-Path $tempRoot $Name
    $remote = Join-Path $root 'remote.git'
    $repository = Join-Path $root 'repository'
    New-Item -ItemType Directory -Path $root -Force | Out-Null
    & git init --bare $remote | Out-Null
    & git init $repository | Out-Null
    Invoke-TestGit $repository @('config', 'user.email', 'generation-tests@example.invalid') | Out-Null
    Invoke-TestGit $repository @('config', 'user.name', 'Generation Tests') | Out-Null
    Invoke-TestGit $repository @('remote', 'add', 'origin', $remote) | Out-Null
    Invoke-TestGit $repository @('checkout', '-b', 'integration/test') | Out-Null
    # Build the same linear history in one Git process. Thousands of per-tag
    # add/commit/rev-parse/tag launches exhaust the Windows CI job's time limit.
    $import = [Text.StringBuilder]::new()
    [void]$import.Append("feature done`n")
    $attributes = @(
        'db/migrations/030*.sql text eol=lf',
        'tools/release/vps/*.sh text eol=lf',
        'tools/release/vps/*.service text eol=lf',
        'tools/telemetry-home/*.sh text eol=lf'
    ) -join "`n"
    $attributes += "`n"
    $commitCount = [math]::Max(1, $TagCount)
    for ($index = 0; $index -lt $commitCount; $index++) {
        $mark = $index + 1
        $message = "fixture $index`n"
        $fixtureText = "t$($index.ToString('D3'))`n"
        [void]$import.Append("commit refs/heads/integration/test`nmark :$mark`n")
        [void]$import.Append("committer Generation Tests <generation-tests@example.invalid> $(1700000000 + $index) +0000`n")
        [void]$import.Append("data $($message.Length)`n$message")
        if ($index -eq 0) {
            [void]$import.Append("M 100644 inline .gitattributes`ndata $($attributes.Length)`n$attributes")
        }
        [void]$import.Append("M 100644 inline fixture.txt`ndata $($fixtureText.Length)`n$fixtureText`n")
        if ($index -lt $TagCount) {
            [void]$import.Append("reset refs/tags/test/t$($index.ToString('D3'))`nfrom :$mark`n`n")
        }
    }
    [void]$import.Append("done`n")
    $importProcess = [Diagnostics.Process]::new()
    $importProcess.StartInfo.FileName = (Get-Command git).Source
    $importProcess.StartInfo.Arguments = 'fast-import --quiet'
    $importProcess.StartInfo.WorkingDirectory = $repository
    $importProcess.StartInfo.UseShellExecute = $false
    $importProcess.StartInfo.CreateNoWindow = $true
    $importProcess.StartInfo.RedirectStandardInput = $true
    $importProcess.StartInfo.RedirectStandardError = $true
    $previousInputEncoding = [Console]::InputEncoding
    try {
        # Windows PowerShell's redirected stdin writer inherits this encoding;
        # avoid emitting a UTF-8 BOM before the fast-import protocol header.
        [Console]::InputEncoding = [Text.Encoding]::ASCII
        $null = $importProcess.Start()
        $importBytes = [Text.Encoding]::UTF8.GetBytes($import.ToString())
        $importProcess.StandardInput.BaseStream.Write($importBytes, 0, $importBytes.Length)
        $importProcess.StandardInput.BaseStream.Close()
        $importError = $importProcess.StandardError.ReadToEnd()
        $importProcess.WaitForExit()
        if ($importProcess.ExitCode -ne 0) { throw "fixture fast-import failed: $importError" }
    } finally {
        $importProcess.Dispose()
        [Console]::InputEncoding = $previousInputEncoding
    }
    Invoke-TestGit $repository @('checkout', '-f', 'integration/test') | Out-Null
    $commits = @((Invoke-TestGit $repository @('rev-list', '--reverse', 'HEAD')) -split "`n")
    Invoke-TestGit $repository @('branch', 'master', 'HEAD') | Out-Null
    Invoke-TestGit $repository @('push', '-u', 'origin', 'integration/test', 'master', '--tags') | Out-Null
    return [pscustomobject]@{ Root = $root; Remote = $remote; Repository = $repository; Commits = $commits }
}

function Add-Candidate($Fixture, [string]$Label = 'candidate') {
    Set-Content -LiteralPath (Join-Path $Fixture.Repository 'fixture.txt') -Value $Label
    Invoke-TestGit $Fixture.Repository @('add', 'fixture.txt') | Out-Null
    Invoke-TestGit $Fixture.Repository @('commit', '-m', $Label) | Out-Null
    return Invoke-TestGit $Fixture.Repository @('rev-parse', 'HEAD')
}

function Add-PathCandidate($Fixture, [string]$Path, [string]$Label) {
    $fullPath = Join-Path $Fixture.Repository $Path
    $parent = Split-Path -Parent $fullPath
    if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    Set-Content -LiteralPath $fullPath -Value $Label
    Invoke-TestGit $Fixture.Repository @('add', $Path) | Out-Null
    Invoke-TestGit $Fixture.Repository @('commit', '-m', $Label) | Out-Null
    return Invoke-TestGit $Fixture.Repository @('rev-parse', 'HEAD')
}

function Add-AttributesCandidate($Fixture, [string[]]$Lines, [string]$Label) {
    $Lines | Set-Content -LiteralPath (Join-Path $Fixture.Repository '.gitattributes')
    Invoke-TestGit $Fixture.Repository @('add', '.gitattributes') | Out-Null
    Invoke-TestGit $Fixture.Repository @('commit', '-m', $Label) | Out-Null
    return Invoke-TestGit $Fixture.Repository @('rev-parse', 'HEAD')
}

function Add-RepairIntervalCandidate($Fixture, [string[]]$Attributes) {
    $paths = @(
        'tools/release/accept-and-publish-test-server.ps1',
        'tools/release/deployment-transport.ps1',
        'tools/release/install-vps-updater.ps1',
        'tools/release/release-flow.tests.ps1'
    )
    foreach ($path in $paths) {
        $fullPath = Join-Path $Fixture.Repository $path
        New-Item -ItemType Directory -Path (Split-Path -Parent $fullPath) -Force | Out-Null
        Set-Content -LiteralPath $fullPath -Value $path
    }
    $Attributes | Set-Content -LiteralPath (Join-Path $Fixture.Repository '.gitattributes')
    Invoke-TestGit $Fixture.Repository @('add', '.gitattributes', 'tools/release') | Out-Null
    Invoke-TestGit $Fixture.Repository @('commit', '-m', 'exact SSH transport repair interval') | Out-Null
    return Invoke-TestGit $Fixture.Repository @('rev-parse', 'HEAD')
}

function Publish-BothProtected($Fixture, [string]$Sha) {
    Invoke-TestGit $Fixture.Repository @(
        'push', '--atomic', 'origin',
        "$Sha`:refs/heads/integration/test",
        "$Sha`:refs/heads/master"
    ) | Out-Null
}

New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
try {
    $helperSource = Get-Content -Raw -LiteralPath $helper
    Assert-True ($helperSource -match "'push', '--atomic'") 'protected generation publication uses atomic push'
    Assert-True ($helperSource -notmatch '(?m)^\s*[''"]?--force(?:-with-lease|-if-includes)?') 'protected generation publication contains no force-enabled push option'
    Assert-True ($helperSource -notmatch '["'']\+[^"'']*:refs/(?:heads/integration/test|tags/test/)') 'protected generation publication contains no plus-prefixed protected refspec'

    foreach ($count in @(2, 100, 250, 500)) {
        $fixture = New-Fixture "scale-$count" $count
        $status = Invoke-Helper $fixture.Repository @('status', '-Json')
        Assert-Equal $status.Json.remote_command_count 1 "status remote command count is constant at $count tags"
        Assert-Equal $status.Json.generation "t$(($count - 1).ToString('D3'))" "status generation at $count tags"
        $original = [string]$status.Json.integration_test_sha
        $candidate = Add-Candidate $fixture "candidate-$count"
        $advance = Invoke-Helper $fixture.Repository @(
            'advance', '-IntegrationTestSha', $candidate,
            '-ExpectedIntegrationTestSha', $original,
            '-ConfirmGenerationCheckpoint', '-Json'
        )
        Assert-Equal $advance.Json.remote_command_count 4 "advance remote command count is constant at $count tags"
        Assert-Equal (Invoke-TestGit $fixture.Repository @('ls-remote', '--heads', 'origin', 'refs/heads/integration/test')).Split("`t")[0] $candidate 'atomic push advances branch'
        Assert-Equal (Invoke-TestGit $fixture.Repository @('ls-remote', '--tags', 'origin', "refs/tags/test/t$($count.ToString('D3'))")).Split("`t")[0] $candidate 'atomic push creates exact next tag'
        $script:Benchmark += [pscustomobject]@{
            tags = $count
            status_remote_commands = $status.Json.remote_command_count
            advance_remote_commands = $advance.Json.remote_command_count
            status_ms = $status.DurationMs
            advance_ms = $advance.DurationMs
        }
    }
    $two = @($script:Benchmark | Where-Object tags -eq 2)[0]
    $fiveHundred = @($script:Benchmark | Where-Object tags -eq 500)[0]
    Assert-True ($fiveHundred.status_ms -lt (($two.status_ms * 10) + 1500)) 'status duration is dominated by one ref snapshot, not per-tag round trips'

    $fourDigitBoundary = New-Fixture 'four-digit-boundary' 1000
    $fourDigitStatus = Invoke-Helper $fourDigitBoundary.Repository @('status', '-Json')
    Assert-Equal $fourDigitStatus.Json.generation 't999' 'three-digit history remains canonical at the boundary'
    Assert-Equal $fourDigitStatus.Json.next_generation 't1000' 'status selects t1000 after t999'
    $fourDigitCandidate = Add-Candidate $fourDigitBoundary 'four-digit candidate'
    $fourDigitAdvance = Invoke-Helper $fourDigitBoundary.Repository @(
        'advance', '-IntegrationTestSha', $fourDigitCandidate,
        '-ExpectedIntegrationTestSha', $fourDigitBoundary.Commits[-1],
        '-ConfirmGenerationCheckpoint', '-Json'
    )
    Assert-Equal $fourDigitAdvance.Json.new_generation 't1000' 'advance creates the first four-digit generation'
    Assert-Equal (Invoke-TestGit $fourDigitBoundary.Repository @(
        'ls-remote', '--tags', 'origin', 'refs/tags/test/t1000'
    )).Split("`t")[0] $fourDigitCandidate 't1000 points to the exact advanced candidate'

    $initial = New-Fixture 'initialize' 0
    $initialStatus = Invoke-Helper $initial.Repository @('status', '-Json')
    Assert-Equal $initialStatus.Json.next_generation 't000' 'initial state selects t000'
    $initialized = Invoke-Helper $initial.Repository @('initialize', '-ConfirmGenerationCheckpoint', '-Json')
    Assert-Equal $initialized.Json.new_generation 't000' 'initialize creates t000'
    $initializedRetry = Invoke-Helper $initial.Repository @('initialize', '-ConfirmGenerationCheckpoint', '-Json')
    Assert-True ([bool]$initializedRetry.Json.already_completed) 'initialize retry reconciles completed state'

    $oneInfrastructure = New-Fixture 'one-infrastructure' 2
    $oneInfrastructureHead = Add-PathCandidate $oneInfrastructure `
        'tools/release/accept-and-publish-test-server.ps1' 'one infrastructure commit'
    Publish-BothProtected $oneInfrastructure $oneInfrastructureHead
    $oneInfrastructureStatus = Invoke-Helper $oneInfrastructure.Repository @('status', '-Json')
    Assert-True (-not $oneInfrastructureStatus.Json.generation -and
        $oneInfrastructureStatus.Json.latest_generation -eq 't001' -and
        $oneInfrastructureStatus.Json.infrastructure_head_accepted) `
        'one exact-path infrastructure commit is distinguished from the latest gameplay generation'

    $multipleInfrastructure = New-Fixture 'multiple-infrastructure' 2
    Add-PathCandidate $multipleInfrastructure 'tools/release/vps/deploy-test-update.sh' `
        'first infrastructure commit' | Out-Null
    $multipleInfrastructureHead = Add-PathCandidate $multipleInfrastructure `
        'tools/release/release-flow.tests.ps1' 'second infrastructure commit'
    Publish-BothProtected $multipleInfrastructure $multipleInfrastructureHead
    $multipleInfrastructureStatus = Invoke-Helper $multipleInfrastructure.Repository @('status', '-Json')
    Assert-True ($multipleInfrastructureStatus.Json.infrastructure_head_accepted -and
        $multipleInfrastructureStatus.Json.next_generation -eq 't002') `
        'multiple consecutive exact-path infrastructure commits preserve the next gameplay generation'

    $transportInfrastructure = New-Fixture 'transport-infrastructure' 2
    $transportInfrastructureHead = Add-PathCandidate $transportInfrastructure `
        'tools/release/deployment-transport.ps1' 'exact deployment transport path'
    Publish-BothProtected $transportInfrastructure $transportInfrastructureHead
    $transportInfrastructureStatus = Invoke-Helper $transportInfrastructure.Repository @('status', '-Json')
    Assert-True ($transportInfrastructureStatus.Json.infrastructure_head_accepted) `
        'deployment transport is one exact admitted infrastructure path'

    $releaseToolInfrastructure = New-Fixture 'release-tool-infrastructure' 2
    $releaseToolInfrastructureHead = $null
    foreach ($releaseToolPath in @(
            'tools/release/invoke-client-only-canary-rollback.ps1',
            'tools/release/release-path-lib.ps1',
            'tools/release/accept-and-publish-test-server.tests.ps1',
            'tools/release/promote-world-runtime.tests.ps1',
            'tools/release/vps/ash-atlas-deploy@.service',
            'tools/release/vps/ash-atlas-deployment-reconcile.service',
            'tools/release/vps/ash-atlas-deployment-reconcile.timer',
            'tools/release/vps/ash-atlas-deployment-request.service',
            'tools/release/vps/ash-atlas-deployment-request.timer',
            'tools/release/vps/deployment-status.caddy',
            'tools/release/vps/poll-deployment-request.sh',
            'tools/release/vps/promote-world-runtime.tests.sh')) {
        $releaseToolInfrastructureHead = Add-PathCandidate $releaseToolInfrastructure `
            $releaseToolPath "exact release tool path $releaseToolPath"
    }
    Publish-BothProtected $releaseToolInfrastructure $releaseToolInfrastructureHead
    $releaseToolInfrastructureStatus = Invoke-Helper $releaseToolInfrastructure.Repository @('status', '-Json')
    Assert-True ($releaseToolInfrastructureStatus.Json.infrastructure_head_accepted) `
        'canary rollback, release path library, installer-shipped controller units, and release tool tests are admitted infrastructure paths'

    $cachePolicyInfrastructure =New-Fixture 'cache-policy-infrastructure' 2
    $cachePolicyInfrastructureHead = Add-PathCandidate $cachePolicyInfrastructure `
        'tools/release/vps/game-cache-policy.caddy' 'exact installed cache policy path'
    Publish-BothProtected $cachePolicyInfrastructure $cachePolicyInfrastructureHead
    $cachePolicyInfrastructureStatus = Invoke-Helper $cachePolicyInfrastructure.Repository @('status', '-Json')
    Assert-True ($cachePolicyInfrastructureStatus.Json.infrastructure_head_accepted) `
        'the installer-owned game cache policy is one exact admitted infrastructure path'

    $releaseAttributes = @(
        'db/migrations/030*.sql text eol=lf',
        'tools/release/vps/*.sh text eol=lf',
        'tools/release/vps/*.service text eol=lf',
        'tools/release/vps/*.caddy text eol=lf',
        'tools/release/vps/deployment-controller.conf text eol=lf',
        'tools/telemetry-home/*.sh text eol=lf'
    )
    $safeAttributes = New-Fixture 'safe-release-attributes' 2
    $safeAttributesHead = Add-AttributesCandidate $safeAttributes $releaseAttributes 'narrow release LF rules'
    Publish-BothProtected $safeAttributes $safeAttributesHead
    $safeAttributesStatus = Invoke-Helper $safeAttributes.Repository @('status', '-Json')
    Assert-True ($safeAttributesStatus.Json.infrastructure_head_accepted) `
        'only the missing exact release LF rules are admitted'

    $exactRepairInterval = New-Fixture 'exact-repair-interval' 2
    $exactRepairBase = $exactRepairInterval.Commits[-1]
    $exactRepairHead = Add-RepairIntervalCandidate $exactRepairInterval $releaseAttributes
    $exactRepairResult = Invoke-Helper $exactRepairInterval.Repository @(
        'publish-infrastructure',
        '-IntegrationTestSha', $exactRepairHead,
        '-ExpectedIntegrationTestSha', $exactRepairBase,
        '-ConfirmGenerationCheckpoint',
        '-ConfirmInfrastructurePublication',
        '-DryRun',
        '-Json'
    )
    Assert-True ($exactRepairResult.Json.mutation_required -and
        $exactRepairResult.Json.latest_tag -eq 'test/t001' -and
        (Invoke-TestGit $exactRepairInterval.Repository @(
            'ls-remote', '--tags', 'origin', 'refs/tags/test/t001'
        )).Split("`t")[0] -eq $exactRepairBase -and
        (Invoke-TestGit $exactRepairInterval.Repository @(
            'ls-remote', '--tags', 'origin', 'refs/tags/test/t002'
        )) -eq '') 'exact five-path SSH repair interval is admitted without changing gameplay tags'

    $unsafeAttributeCases = @(
        @{
            Name = 'deleted-existing-rule'
            Lines = @($releaseAttributes | Where-Object { $_ -ne 'tools/release/vps/*.sh text eol=lf' })
        },
        @{
            Name = 'changed-unrelated-rule'
            Lines = @($releaseAttributes | ForEach-Object {
                    if ($_ -eq 'tools/telemetry-home/*.sh text eol=lf') {
                        'tools/telemetry-home/*.sh -text'
                    } else { $_ }
                })
        },
        @{
            Name = 'broad-tools-rule'
            Lines = @($releaseAttributes + 'tools/** text eol=lf')
        },
        @{
            Name = 'broad-powershell-rule'
            Lines = @($releaseAttributes + '*.ps1 text eol=lf')
        }
    )
    foreach ($case in $unsafeAttributeCases) {
        $unsafeAttributes = New-Fixture "unsafe-attributes-$($case.Name)" 2
        $unsafeAttributesHead = Add-AttributesCandidate $unsafeAttributes $case.Lines $case.Name
        Publish-BothProtected $unsafeAttributes $unsafeAttributesHead
        $unsafeAttributesStatus = Invoke-Helper $unsafeAttributes.Repository @('status', '-Json')
        Assert-True (-not $unsafeAttributesStatus.Json.infrastructure_head_accepted -and
            $unsafeAttributesStatus.Json.infrastructure_head_reason -match 'unsafe \.gitattributes') `
            "infrastructure admission rejects $($case.Name)"
    }

    foreach ($forbidden in @(
            @{ Name = 'client'; Path = 'apps/client/src/App.tsx' },
            @{ Name = 'server'; Path = 'apps/server/src/index.ts' },
            @{ Name = 'protocol'; Path = 'packages/shared/src/protocol.ts' },
            @{ Name = 'migration'; Path = 'apps/server/db/migrations/9999_bad.sql' },
            @{ Name = 'package'; Path = 'package.json' },
            @{ Name = 'dependency'; Path = 'pnpm-lock.yaml' },
            @{ Name = 'asset'; Path = 'apps/client/public/unsafe.png' },
            @{ Name = 'unknown-release'; Path = 'tools/release/unknown-new-file.ps1' },
            @{ Name = 'unknown'; Path = 'unexpected/release-note.txt' }
        )) {
        $mixed = New-Fixture "mixed-$($forbidden.Name)" 2
        $mixedHead = Add-PathCandidate $mixed $forbidden.Path "mixed $($forbidden.Name)"
        Publish-BothProtected $mixed $mixedHead
        $mixedStatus = Invoke-Helper $mixed.Repository @('status', '-Json')
        Assert-True (-not $mixedStatus.Json.infrastructure_head_accepted -and
            $mixedStatus.Json.infrastructure_head_reason -match [regex]::Escape($forbidden.Path)) `
            "infrastructure admission refuses $($forbidden.Name) path"
    }

    $divergentProtected = New-Fixture 'divergent-protected' 2
    $divergentHead = Add-PathCandidate $divergentProtected `
        'tools/release/release-flow.tests.ps1' 'divergent infrastructure'
    Invoke-TestGit $divergentProtected.Repository @(
        'push', 'origin', "$divergentHead`:refs/heads/integration/test"
    ) | Out-Null
    $divergentStatus = Invoke-Helper $divergentProtected.Repository @('status', '-Json')
    Assert-True (-not $divergentStatus.Json.infrastructure_head_accepted -and
        $divergentStatus.Json.infrastructure_head_reason -match 'diverge') `
        'untagged infrastructure admission refuses divergent protected refs'

    $nonDescendant = New-Fixture 'non-descendant-protected' 2
    Invoke-TestGit $nonDescendant.Repository @('checkout', '--orphan', 'unrelated-infrastructure') | Out-Null
    Invoke-TestGit $nonDescendant.Repository @('rm', '-rf', '.') | Out-Null
    $nonDescendantHead = Add-PathCandidate $nonDescendant `
        'tools/release/release-flow.tests.ps1' 'unrelated infrastructure'
    Invoke-TestGit $nonDescendant.Repository @(
        'push', '--force', '--atomic', 'origin',
        "$nonDescendantHead`:refs/heads/integration/test",
        "$nonDescendantHead`:refs/heads/master"
    ) | Out-Null
    $nonDescendantStatus = Invoke-Helper $nonDescendant.Repository @('status', '-Json')
    Assert-True (-not $nonDescendantStatus.Json.infrastructure_head_accepted -and
        $nonDescendantStatus.Json.infrastructure_head_reason -match 'does not descend') `
        'untagged infrastructure admission refuses a non-descendant protected head'

    $infrastructureFromTagged = New-Fixture 'infrastructure-from-tagged' 2
    Add-PathCandidate $infrastructureFromTagged `
        'tools/dev/test-generation.ps1' 'infrastructure after gameplay tag' | Out-Null
    $taggedInfrastructureCandidate = Add-PathCandidate $infrastructureFromTagged `
        'tools/dev/feature-runtime.ps1' 'receipt infrastructure after gameplay tag'
    $taggedInfrastructureResult = Invoke-Helper $infrastructureFromTagged.Repository @(
        'publish-infrastructure',
        '-IntegrationTestSha', $taggedInfrastructureCandidate,
        '-ExpectedIntegrationTestSha', $infrastructureFromTagged.Commits[-1],
        '-ConfirmGenerationCheckpoint',
        '-ConfirmInfrastructurePublication',
        '-Json'
    )
    Assert-True (-not $taggedInfrastructureResult.Json.new_generation -and
        (Invoke-TestGit $infrastructureFromTagged.Repository @(
            'ls-remote', '--heads', 'origin', 'refs/heads/integration/test'
        )).Split("`t")[0] -eq $taggedInfrastructureCandidate) `
        'infrastructure publication accepts the exact latest gameplay generation as its base'

    $infrastructurePublication = New-Fixture 'infrastructure-publication' 2
    $admittedHead = Add-PathCandidate $infrastructurePublication `
        'tools/release/accept-and-publish-test-server.ps1' 'existing admitted head'
    Publish-BothProtected $infrastructurePublication $admittedHead
    $publishedInfrastructure = Add-PathCandidate $infrastructurePublication `
        'tools/dev/test-generation.ps1' 'controller admission repair'
    $infrastructureResult = Invoke-Helper $infrastructurePublication.Repository @(
        'publish-infrastructure',
        '-IntegrationTestSha', $publishedInfrastructure,
        '-ExpectedIntegrationTestSha', $admittedHead,
        '-ConfirmGenerationCheckpoint',
        '-ConfirmInfrastructurePublication',
        '-Json'
    )
    Assert-True (-not $infrastructureResult.Json.new_generation -and
        (Invoke-TestGit $infrastructurePublication.Repository @(
            'ls-remote', '--heads', 'origin', 'refs/heads/integration/test'
        )).Split("`t")[0] -eq $publishedInfrastructure -and
        (Invoke-TestGit $infrastructurePublication.Repository @(
            'ls-remote', '--heads', 'origin', 'refs/heads/master'
        )).Split("`t")[0] -eq $publishedInfrastructure) `
        'infrastructure publication atomically advances both protected refs without a gameplay tag'
    $infrastructureRetry = Invoke-Helper $infrastructurePublication.Repository @(
        'publish-infrastructure',
        '-IntegrationTestSha', $publishedInfrastructure,
        '-ExpectedIntegrationTestSha', $admittedHead,
        '-ConfirmGenerationCheckpoint',
        '-ConfirmInfrastructurePublication',
        '-Json'
    )
    Assert-True ([bool]$infrastructureRetry.Json.already_completed) `
        'duplicate infrastructure publication reconciles without another mutation'

    $atomicInfrastructureFailure = New-Fixture 'atomic-infrastructure-failure' 2
    $atomicInfrastructureBase = Add-PathCandidate $atomicInfrastructureFailure `
        'tools/release/release-flow.tests.ps1' 'atomic infrastructure base'
    Publish-BothProtected $atomicInfrastructureFailure $atomicInfrastructureBase
    $atomicInfrastructureCandidate = Add-PathCandidate $atomicInfrastructureFailure `
        'tools/dev/test-generation.ps1' 'rejected infrastructure candidate'
    $infrastructureHook = Join-Path $atomicInfrastructureFailure.Remote 'hooks\pre-receive'
    @'
#!/bin/sh
exit 1
'@ | Set-Content -LiteralPath $infrastructureHook -Encoding ascii
    Invoke-Helper $atomicInfrastructureFailure.Repository @(
        'publish-infrastructure',
        '-IntegrationTestSha', $atomicInfrastructureCandidate,
        '-ExpectedIntegrationTestSha', $atomicInfrastructureBase,
        '-ConfirmGenerationCheckpoint',
        '-ConfirmInfrastructurePublication',
        '-Json'
    ) -ExpectFailure | Out-Null
    Assert-Equal (Invoke-TestGit $atomicInfrastructureFailure.Repository @(
        'ls-remote', '--heads', 'origin', 'refs/heads/integration/test'
    )).Split("`t")[0] $atomicInfrastructureBase 'failed infrastructure publication leaves integration/test unchanged'
    Assert-Equal (Invoke-TestGit $atomicInfrastructureFailure.Repository @(
        'ls-remote', '--heads', 'origin', 'refs/heads/master'
    )).Split("`t")[0] $atomicInfrastructureBase 'failed infrastructure publication leaves master unchanged'

    $gameplayAfterInfrastructure = New-Fixture 'gameplay-after-infrastructure' 2
    $gameplayInfrastructureHead = Add-PathCandidate $gameplayAfterInfrastructure `
        'tools/release/accept-and-publish-test-server.ps1' 'approved controller head'
    Publish-BothProtected $gameplayAfterInfrastructure $gameplayInfrastructureHead
    $gameplayCandidate = Add-Candidate $gameplayAfterInfrastructure 'gameplay candidate'
    $gameplayPublication = Invoke-Helper $gameplayAfterInfrastructure.Repository @(
        'advance',
        '-IntegrationTestSha', $gameplayCandidate,
        '-ExpectedIntegrationTestSha', $gameplayInfrastructureHead,
        '-PublishMaster',
        '-ConfirmGenerationCheckpoint',
        '-Json'
    )
    Assert-True ($gameplayPublication.Json.new_generation -eq 't002' -and
        (Invoke-TestGit $gameplayAfterInfrastructure.Repository @(
            'ls-remote', '--heads', 'origin', 'refs/heads/master'
        )).Split("`t")[0] -eq $gameplayCandidate) `
        'gameplay publication after an admitted infrastructure head creates the exact next tag and atomically advances master'

    $splitProtected = New-Fixture 'split-protected-leases' 2
    $splitMasterBase = $splitProtected.Commits[1]
    $integrationAhead = Add-Candidate $splitProtected 'integration generation ahead of master'
    Invoke-Helper $splitProtected.Repository @(
        'advance',
        '-IntegrationTestSha', $integrationAhead,
        '-ExpectedIntegrationTestSha', $splitMasterBase,
        '-ConfirmGenerationCheckpoint',
        '-Json'
    ) | Out-Null
    $splitCandidate = Add-Candidate $splitProtected 'candidate after split protected tips'
    $splitPublication = Invoke-Helper $splitProtected.Repository @(
        'advance',
        '-IntegrationTestSha', $splitCandidate,
        '-ExpectedIntegrationTestSha', $integrationAhead,
        '-ExpectedMasterSha', $splitMasterBase,
        '-PublishMaster',
        '-ConfirmGenerationCheckpoint',
        '-Json'
    )
    Assert-True ($splitPublication.Json.new_generation -eq 't003' -and
        (Invoke-TestGit $splitProtected.Repository @(
            'ls-remote', '--heads', 'origin', 'refs/heads/integration/test'
        )).Split("`t")[0] -eq $splitCandidate -and
        (Invoke-TestGit $splitProtected.Repository @(
            'ls-remote', '--heads', 'origin', 'refs/heads/master'
        )).Split("`t")[0] -eq $splitCandidate) `
        'separately leased ancestor master and one-generation-ahead integration publish atomically'

    $masterChanged = New-Fixture 'master-lease-changed' 2
    $masterChangedCandidate = Add-Candidate $masterChanged 'candidate after master drift'
    Invoke-Helper $masterChanged.Repository @(
        'advance',
        '-IntegrationTestSha', $masterChangedCandidate,
        '-ExpectedIntegrationTestSha', $masterChanged.Commits[1],
        '-ExpectedMasterSha', $masterChanged.Commits[0],
        '-PublishMaster',
        '-ConfirmGenerationCheckpoint',
        '-Json'
    ) -ExpectFailure | Out-Null

    $masterNotAncestor = New-Fixture 'master-not-ancestor' 2
    $masterNotAncestorCandidate = Add-Candidate $masterNotAncestor 'candidate with divergent master'
    Invoke-TestGit $masterNotAncestor.Repository @('checkout', '--orphan', 'divergent-master') | Out-Null
    Invoke-TestGit $masterNotAncestor.Repository @('rm', '-rf', '.') | Out-Null
    Set-Content -LiteralPath (Join-Path $masterNotAncestor.Repository 'divergent.txt') -Value 'divergent master'
    Invoke-TestGit $masterNotAncestor.Repository @('add', 'divergent.txt') | Out-Null
    Invoke-TestGit $masterNotAncestor.Repository @('commit', '-m', 'divergent master') | Out-Null
    $divergentMaster = Invoke-TestGit $masterNotAncestor.Repository @('rev-parse', 'HEAD')
    Invoke-TestGit $masterNotAncestor.Repository @(
        'push', 'origin', "$divergentMaster`:refs/heads/divergent-master") | Out-Null
    Invoke-TestGit $masterNotAncestor.Remote @('update-ref', 'refs/heads/master', $divergentMaster) | Out-Null
    Invoke-TestGit $masterNotAncestor.Repository @('checkout', 'integration/test') | Out-Null
    Invoke-Helper $masterNotAncestor.Repository @(
        'advance',
        '-IntegrationTestSha', $masterNotAncestorCandidate,
        '-ExpectedIntegrationTestSha', $masterNotAncestor.Commits[1],
        '-ExpectedMasterSha', $divergentMaster,
        '-PublishMaster',
        '-ConfirmGenerationCheckpoint',
        '-Json'
    ) -ExpectFailure | Out-Null

    $malformed = New-Fixture 'malformed' 2
    Invoke-TestGit $malformed.Repository @('tag', 'test/not-a-generation', 'HEAD') | Out-Null
    Invoke-TestGit $malformed.Repository @('push', 'origin', 'refs/tags/test/not-a-generation') | Out-Null
    Invoke-Helper $malformed.Repository @('status', '-Json') -ExpectFailure | Out-Null

    $noncanonicalWidth = New-Fixture 'noncanonical-width' 0
    Invoke-TestGit $noncanonicalWidth.Repository @('tag', 'test/t0000', 'HEAD') | Out-Null
    Invoke-TestGit $noncanonicalWidth.Repository @('push', 'origin', 'refs/tags/test/t0000') | Out-Null
    Invoke-Helper $noncanonicalWidth.Repository @('status', '-Json') -ExpectFailure | Out-Null

    $gap = New-Fixture 'gap' 3
    Invoke-TestGit $gap.Remote @('update-ref', '-d', 'refs/tags/test/t001') | Out-Null
    Invoke-Helper $gap.Repository @('status', '-Json') -ExpectFailure | Out-Null

    $duplicateCommit = New-Fixture 'duplicate-commit' 2
    Invoke-TestGit $duplicateCommit.Repository @('tag', 'test/t002', $duplicateCommit.Commits[1]) | Out-Null
    Invoke-TestGit $duplicateCommit.Repository @('push', 'origin', 'refs/tags/test/t002') | Out-Null
    Invoke-Helper $duplicateCommit.Repository @('status', '-Json') -ExpectFailure | Out-Null

    $stale = New-Fixture 'stale-supplied-sha' 2
    $staleCandidate = Add-Candidate $stale
    Invoke-Helper $stale.Repository @(
        'advance', '-IntegrationTestSha', $staleCandidate,
        '-ExpectedIntegrationTestSha', $stale.Commits[0],
        '-ConfirmGenerationCheckpoint', '-Json'
    ) -ExpectFailure | Out-Null

    $branchChanged = New-Fixture 'branch-changed' 2
    $approved = $branchChanged.Commits[1]
    $other = Add-Candidate $branchChanged 'other remote change'
    Invoke-TestGit $branchChanged.Repository @('push', 'origin', 'integration/test') | Out-Null
    $candidateAfterOther = Add-Candidate $branchChanged 'candidate after remote change'
    Invoke-Helper $branchChanged.Repository @(
        'advance', '-IntegrationTestSha', $candidateAfterOther,
        '-ExpectedIntegrationTestSha', $approved,
        '-ConfirmGenerationCheckpoint', '-Json'
    ) -ExpectFailure | Out-Null
    Assert-Equal (Invoke-TestGit $branchChanged.Repository @('ls-remote', '--tags', 'origin', 'refs/tags/test/t002')) '' 'changed remote branch refusal creates no generation tag'

    $namespaceChanged = New-Fixture 'namespace-changed' 2
    $approvedSnapshot = Invoke-Helper $namespaceChanged.Repository @('status', '-Json')
    $namespaceCandidate = Add-Candidate $namespaceChanged
    Invoke-TestGit $namespaceChanged.Repository @('tag', 'test/t002', $namespaceCandidate) | Out-Null
    Invoke-TestGit $namespaceChanged.Repository @('push', 'origin', 'refs/tags/test/t002') | Out-Null
    Invoke-Helper $namespaceChanged.Repository @(
        'advance', '-IntegrationTestSha', $namespaceCandidate,
        '-ExpectedIntegrationTestSha', $namespaceChanged.Commits[1],
        '-ExpectedSnapshotId', $approvedSnapshot.Json.snapshot_id,
        '-ConfirmGenerationCheckpoint', '-Json'
    ) -ExpectFailure | Out-Null

    $notAncestor = New-Fixture 'not-ancestor' 2
    Invoke-TestGit $notAncestor.Repository @('checkout', '--orphan', 'unrelated') | Out-Null
    Invoke-TestGit $notAncestor.Repository @('rm', '-rf', '.') | Out-Null
    Set-Content -LiteralPath (Join-Path $notAncestor.Repository 'unrelated.txt') -Value 'unrelated'
    Invoke-TestGit $notAncestor.Repository @('add', 'unrelated.txt') | Out-Null
    Invoke-TestGit $notAncestor.Repository @('commit', '-m', 'unrelated') | Out-Null
    $unrelated = Invoke-TestGit $notAncestor.Repository @('rev-parse', 'HEAD')
    Invoke-TestGit $notAncestor.Repository @('checkout', 'integration/test') | Out-Null
    Invoke-Helper $notAncestor.Repository @(
        'advance', '-IntegrationTestSha', $unrelated,
        '-ExpectedIntegrationTestSha', $notAncestor.Commits[1],
        '-ConfirmGenerationCheckpoint', '-Json'
    ) -ExpectFailure | Out-Null

    $retry = New-Fixture 'retry' 2
    $retryOriginal = $retry.Commits[1]
    $retryCandidate = Add-Candidate $retry
    Invoke-Helper $retry.Repository @(
        'advance', '-IntegrationTestSha', $retryCandidate,
        '-ExpectedIntegrationTestSha', $retryOriginal,
        '-ConfirmGenerationCheckpoint', '-Json'
    ) | Out-Null
    $retryResult = Invoke-Helper $retry.Repository @(
        'advance', '-IntegrationTestSha', $retryCandidate,
        '-ExpectedIntegrationTestSha', $retryOriginal,
        '-ConfirmGenerationCheckpoint', '-Json'
    )
    Assert-True ([bool]$retryResult.Json.already_completed) 'retry after interrupted publication reports completed exact state'
    Assert-Equal (Invoke-TestGit $retry.Repository @('ls-remote', '--tags', 'origin', 'refs/tags/test/t002')).Split("`t")[0] $retryCandidate 'retry never moves immutable tag'

    $wrongTag = New-Fixture 'wrong-tag' 2
    $wrongCandidate = Add-Candidate $wrongTag 'requested candidate'
    Invoke-TestGit $wrongTag.Repository @('tag', 'test/t002', $wrongTag.Commits[0]) | Out-Null
    Invoke-TestGit $wrongTag.Repository @('push', 'origin', 'refs/tags/test/t002') | Out-Null
    Invoke-Helper $wrongTag.Repository @(
        'advance', '-IntegrationTestSha', $wrongCandidate,
        '-ExpectedIntegrationTestSha', $wrongTag.Commits[1],
        '-ConfirmGenerationCheckpoint', '-Json'
    ) -ExpectFailure | Out-Null
    Assert-Equal (Invoke-TestGit $wrongTag.Repository @('ls-remote', '--heads', 'origin', 'refs/heads/integration/test')).Split("`t")[0] $wrongTag.Commits[1] 'existing destination generation tag leaves branch unchanged'

    $atomicFailure = New-Fixture 'atomic-failure' 2
    $atomicOriginal = $atomicFailure.Commits[1]
    $atomicCandidate = Add-Candidate $atomicFailure
    $hook = Join-Path $atomicFailure.Remote 'hooks\pre-receive'
    @'
#!/bin/sh
exit 1
'@ | Set-Content -LiteralPath $hook -Encoding ascii
    Invoke-Helper $atomicFailure.Repository @(
        'advance', '-IntegrationTestSha', $atomicCandidate,
        '-ExpectedIntegrationTestSha', $atomicOriginal,
        '-ConfirmGenerationCheckpoint', '-Json'
    ) -ExpectFailure | Out-Null
    Assert-Equal (Invoke-TestGit $atomicFailure.Repository @('ls-remote', '--heads', 'origin', 'refs/heads/integration/test')).Split("`t")[0] $atomicOriginal 'atomic failure leaves branch unchanged'
    Assert-Equal (Invoke-TestGit $atomicFailure.Repository @('ls-remote', '--tags', 'origin', 'refs/tags/test/t002')) '' 'atomic failure creates no tag'

    $localStale = New-Fixture 'local-stale' 2
    Invoke-TestGit $localStale.Repository @('tag', 'test/t999', 'HEAD') | Out-Null
    $localStatus = Invoke-Helper $localStale.Repository @('status', '-Json')
    Assert-Equal $localStatus.Json.generation 't001' 'local-only stale generation tag does not block remote truth'

    $featureRuntimeSource = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'feature-runtime.ps1')
    Assert-True ($featureRuntimeSource -match 'Get-TargetedMergedRemoteState' -and
        $featureRuntimeSource -notmatch "test-generation\.ps1'\),\s*'status'") 'mark-merged performs targeted validation without historical generation synchronization'

    $benchmarkRoot = Join-Path $env:LOCALAPPDATA ("AshAtlas\{0}" -f (Get-Date -Format 'yyyy-MM-dd'))
    New-Item -ItemType Directory -Path $benchmarkRoot -Force | Out-Null
    $benchmarkPath = Join-Path $benchmarkRoot ("generation-scaling-{0}.json" -f (Get-Date -Format 'yyyyMMddTHHmmss'))
    $script:Benchmark | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $benchmarkPath -Encoding utf8
    $script:Benchmark | Format-Table -AutoSize
    Write-Host "Generation benchmark: $benchmarkPath"
} finally {
    if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}

Write-Host "test-generation.tests.ps1: $script:Passed assertions passed." -ForegroundColor Green
