$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$script:ConfiguredReleaseMode = 'paused'

$source = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'accept-and-publish-test-server.ps1')
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw $errors[0] }
foreach ($name in @('Get-StateValue', 'Set-StateValue', 'ConvertTo-ReleaseTimestampUtc',
        'Get-ReleaseElapsedMilliseconds', 'Get-ReleasePhaseTiming', 'Test-ReleaseTimingBudget', 'Invoke-Phase',
        'Initialize-DeploymentState', 'Write-TimingReports', 'Get-StatePath', 'Read-State')) {
    $definition = @($ast.FindAll({ param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }, $true))
    if ($definition.Count -ne 1) { throw "Expected one $name definition" }
    Invoke-Expression $definition[0].Extent.Text
}
function Stop-Workflow([string]$Message) { throw $Message }
function Write-State($State) { }
. (Join-Path $PSScriptRoot 'release-path-lib.ps1')
$RepositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
function Get-GameRepositoryRoot { return $RepositoryRoot }
function Get-GameIntegrationWorktree { return (Join-Path $RepositoryRoot 'integration-fixture') }
function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
    $script:Passed++
}
function Assert-Refused([scriptblock]$Action, [string]$Pattern) {
    $refused = $false
    try { & $Action | Out-Null } catch { $refused = $_.Exception.Message -match $Pattern }
    Assert-True $refused "refuses $Pattern"
}
function Copy-Json($Value) { return $Value | ConvertTo-Json -Depth 14 | ConvertFrom-Json }
function New-TestPhase($Start, $Finish, [long]$Duration) {
    return [pscustomobject]@{ status = 'completed'; started_at_utc = $Start; finished_at_utc = $Finish; duration_ms = $Duration }
}
$script:Passed = 0
$Mode = 'Resume'
$Json = $true
$SshHardDeadlineSeconds = 20
$DeploymentPollIntervalSeconds = 2
$StateRoot = Join-Path ([IO.Path]::GetTempPath()) ('ash-atlas-release-timing-' + [guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Path $StateRoot | Out-Null
try {
    $start = '2026-09-06T02:31:31.2463557Z'
    $finish = '2026-09-06T02:32:19.6385158Z'
    $roundTrip = Copy-Json ([pscustomobject]@{ start = $start; finish = $finish })
    Assert-True ((ConvertTo-ReleaseTimestampUtc $roundTrip.start) -ceq $start) 'JSON roundtrip retains UTC and all fractional digits'
    Assert-True ((Get-ReleaseElapsedMilliseconds $roundTrip.start $roundTrip.finish) -eq 48392) 'actual wolf recovery interval remains positive and precise'
    Assert-True ((ConvertTo-ReleaseTimestampUtc ([DateTimeOffset]'2026-09-05T20:31:31.2463557-06:00')) -ceq $start) 'offset timestamp preserves the same instant'
    Assert-True ((ConvertTo-ReleaseTimestampUtc ([DateTimeOffset]$start).LocalDateTime) -ceq $start) 'local DateTime retains UTC instant without string conversion'
    foreach ($invalid in @('broken', '09/06/2026 02:31:31', '2026-09-06T02:31:31', [DateTime]::SpecifyKind([DateTime]$start, 'Unspecified'))) {
        Assert-Refused { ConvertTo-ReleaseTimestampUtc $invalid } 'invalid release timing timestamp'
    }
    Assert-Refused { Get-ReleaseElapsedMilliseconds $finish $start } 'interval is negative'
    Assert-Refused { Test-ReleaseTimingBudget -1 90000 $true } 'duration is negative'

    # A fixed clock proves Resume after JSON materialization, including interruption/recovery gaps.
    $script:TimingNow = ([DateTimeOffset]$finish).UtcDateTime
    function Get-Date { return $script:TimingNow }
    $state = [pscustomobject]@{
        schema_version = 9; operation_id = 'timing-fixture'; candidate_integration_sha = ('a' * 40)
        status = 'running:merged_receipt'; failure_phase = ''; deployment_phase_timings = $null
        created_at_utc = '2026-09-06T02:24:30.1000000Z'; updated_at_utc = '2026-09-06T02:31:34.2463557Z'
        phases = [pscustomobject]@{
            merged_receipt = [pscustomobject]@{
                status = 'running'; started_at_utc = $start; first_started_at_utc = $start
                finished_at_utc = ''; duration_ms = 0; active_duration_ms = 0; wall_clock_duration_ms = 0
                attempt_count = 1; result = ''
                attempts = @([pscustomobject]@{ attempt = 1; mode = 'IntegrateAndPublish'; status = 'running'; started_at_utc = $start; finished_at_utc = ''; duration_ms = 0; result = '' })
            }
        }
    }
    Initialize-DeploymentState $state
    $state = Copy-Json $state
    $null = Invoke-Phase $state merged_receipt { 'resumed' }
    Assert-True ($state.phases.merged_receipt.duration_ms -eq 48392 -and $state.phases.merged_receipt.active_duration_ms -eq 3000) 'resumed phase measures wall clock and active attempts separately'
    Assert-True ($state.phases.merged_receipt.attempts[0].status -eq 'interrupted') 'resumed interrupted attempt remains recorded'

    $failed = Copy-Json $state
    $failed.phases.merged_receipt.status = 'failed'
    Assert-Refused { Invoke-Phase $failed merged_receipt { throw 'fixture action failed' } } 'fixture action failed'
    Assert-True ($failed.phases.merged_receipt.duration_ms -eq 48392) 'failed resumed attempt also preserves original wall clock'
    $invalidTiming = Copy-Json $state
    $invalidTiming.phases.merged_receipt.status = 'failed'
    $invalidTiming.phases.merged_receipt.first_started_at_utc = 'invalid'
    $actionResult = Invoke-Phase $invalidTiming merged_receipt { 'side effect completed' }
    Assert-True ($actionResult -eq 'side effect completed' -and $invalidTiming.phases.merged_receipt.status -eq 'completed' -and $null -eq $invalidTiming.phases.merged_receipt.duration_ms) 'malformed timing does not relabel a completed action or fabricate zero duration'
    $skippedResult = Invoke-Phase $invalidTiming merged_receipt { throw 'completed side effect must not replay' }
    Assert-True ($skippedResult -eq 'side effect completed') 'Resume still skips completed action with invalid timing'
    $invalidTiming.phases.merged_receipt.status = 'failed'
    Assert-Refused { Invoke-Phase $invalidTiming merged_receipt { throw 'original action failure' } } '^original action failure$'
    Assert-True ($invalidTiming.phases.merged_receipt.status -eq 'failed' -and $invalidTiming.phases.merged_receipt.result -eq 'original action failure') 'timing diagnostic preserves original failed action evidence'

    Add-Member -InputObject $state.phases -NotePropertyName master_fast_forward_and_push -NotePropertyValue (New-TestPhase $finish '2026-09-06T02:32:22.6385158Z' 3000)
    Add-Member -InputObject $state.phases -NotePropertyName deployment -NotePropertyValue (New-TestPhase '2026-09-06T02:32:22.6385158Z' '2026-09-06T02:33:22.5970000Z' 59958)
    $state.completed_at_utc = '2026-09-06T02:33:23.5970000Z'
    $state.remote_deployment_receipt = [pscustomobject]@{ cache_results = [pscustomobject]@{ dependencies = 'cache_hit'; client = 'cache_hit'; server = 'cache_hit' } }
    $state.deployment_lane = 'client'
    $state.deployment_phase_timings = [pscustomobject]@{ total_duration_ms = 10000; phases = @() }
    $state = Copy-Json $state
    $report = Write-TimingReports $state
    Assert-True ($report.total_duration_ms -eq 533497) 'workflow total includes preparation and final confirmation'
    Assert-True ($report.operation_start_to_live_duration_ms -eq 532497) 'operation start-to-live includes preparation and recovery'
    Assert-True ($report.publication_to_live_duration_ms -eq 62958) 'publication-to-live remains separately measured'
    Assert-True ($report.approval_to_live_duration_ms -eq $report.publication_to_live_duration_ms -and $report.approval_to_live_measurement -match 'legacy alias') 'legacy timing consumers retain an explicitly labeled publication alias'
    Assert-True ($report.budgets.warm_total_pass -eq $false -and $report.budgets.lane_pass -eq $true) 'short warm deployment cannot falsely pass full operation budget'
    Assert-True ($report.budgets.integration_pass -eq $false) 'positive recovered integration duration correctly exceeds budget'
    Assert-True ($null -eq $report.budgets.final_verification_pass -and $null -eq $report.budgets.acceptance_pass -and $null -eq $report.budgets.https_status_read_pass) 'unmeasured budgets are N/A'
    Assert-True ($report.phases[0].started_at_utc -ceq $start -and $report.workflow_started_at_utc -ceq '2026-09-06T02:24:30.1000000Z') 'report timestamp strings retain exact UTC precision'
    $cold = Copy-Json $state
    $cold.remote_deployment_receipt.cache_results.dependencies = 'build'
    $coldReport = Write-TimingReports $cold
    Assert-True ($null -eq $coldReport.budgets.lane_pass -and $null -eq $coldReport.budgets.warm_total_pass) 'cold-path warm budgets are N/A instead of true'
    $saved = Get-Content -Raw -LiteralPath (Join-Path $StateRoot 'timing-fixture.timings.json') | ConvertFrom-Json
    Assert-True ($null -eq $saved.budgets.warm_total_pass) 'N/A budget survives JSON as null'
    $text = Get-Content -Raw -LiteralPath (Join-Path $StateRoot 'timing-fixture.timings.txt')
    Assert-True ($text -match 'budget warm_total_pass: N/A' -and $text -match 'operation start-to-live: 532497 ms') 'text report renders N/A and complete operation speed'
    $missing = Copy-Json $state
    $missing.phases = [pscustomobject]@{}
    $missingReport = Write-TimingReports $missing
    Assert-True ($null -eq $missingReport.operation_start_to_live_duration_ms -and $null -eq $missingReport.budgets.warm_total_pass -and $null -eq $missingReport.budgets.integration_pass) 'no deployment or integration yields no fabricated duration or budget pass'
    $bad = Copy-Json $state
    $bad.phases.merged_receipt.duration_ms = -21551361
    $bad.phases.merged_receipt.wall_clock_duration_ms = -21551361
    $bad.phases.merged_receipt.active_duration_ms = -21551361
    $bad.phases.merged_receipt.attempts[0].duration_ms = -21551361
    $bad | ConvertTo-Json -Depth 14 | Set-Content -LiteralPath (Get-StatePath $bad.operation_id) -Encoding utf8
    $historical = Read-State $bad.operation_id
    $recovered = Write-TimingReports $historical
    $recoveredPhase = @($recovered.phases | Where-Object phase -eq 'merged_receipt')[0]
    Assert-True ($recovered.timing_status -eq 'valid' -and $recoveredPhase.duration_ms -eq 48392 -and $recoveredPhase.active_duration_ms -eq 3000) 'Inspect read/report reconstructs historical negative wolf durations from exact phase and attempt timestamps'
    Assert-True ($historical.phases.merged_receipt.duration_ms -eq -21551361 -and $recoveredPhase.attempts[0].duration_ms -eq 3000) 'report corrects derived attempt metrics without rewriting historical evidence'
    $bad = Copy-Json $state
    $bad.phases.merged_receipt.finished_at_utc = '2026-09-06T00:00:00Z'
    $diagnostic = Write-TimingReports $bad
    Assert-True ($diagnostic.timing_status -eq 'invalid' -and $null -eq $diagnostic.budgets.integration_pass -and $diagnostic.timing_error -match 'interval is negative') 'reversed timing interval produces invalid/N/A diagnostic without failing workflow'
    $bad = Copy-Json $state
    $bad.created_at_utc = 'invalid'
    $diagnostic = Write-TimingReports $bad
    Assert-True ($diagnostic.timing_status -eq 'invalid' -and $diagnostic.timing_error -match 'invalid release timing timestamp') 'malformed operation timestamp is diagnostic only'
    $bad = Copy-Json $state
    $bad.completed_at_utc = '2026-09-05T00:00:00Z'
    $bad.status = 'completed'
    $diagnostic = Write-TimingReports $bad
    Assert-True ($diagnostic.timing_status -eq 'invalid' -and $bad.status -eq 'completed' -and $null -eq $diagnostic.total_duration_ms) 'invalid workflow duration cannot relabel completed publication'
} finally {
    Remove-Item -LiteralPath $StateRoot -Recurse -Force
}
Write-Host "release-timing.tests.ps1: $script:Passed assertions passed."
