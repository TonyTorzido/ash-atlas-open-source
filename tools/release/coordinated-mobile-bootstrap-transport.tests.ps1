Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:Passed = 0
function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
    $script:Passed++
}

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$transport = Join-Path $PSScriptRoot 'coordinated-mobile-bootstrap-transport.example.ps1'
$workflowTemplatePath = Join-Path $root 'docs\release\mobile-private-control-mac-workflow.example.yml'
$workflowText = Get-Content -Raw -LiteralPath $workflowTemplatePath -Encoding utf8
$runNameMatch = [regex]::Match($workflowText, '(?m)^run-name:\s*(?<value>.+?)\s*$')
Assert-True $runNameMatch.Success 'private Mac workflow declares an explicit run-name contract'
$workflowRunNameTemplate = $runNameMatch.Groups['value'].Value.Trim().Trim('"').Trim("'")
$sampleOperationId = 'transport-run-name-contract'
$sampleDispatchNonce = '0123456789abcdef0123456789abcdef'
$resolvedWorkflowRunName = $workflowRunNameTemplate -replace '\$\{\{\s*inputs\.operation_id\s*\}\}', $sampleOperationId
$resolvedWorkflowRunName = $resolvedWorkflowRunName -replace '\$\{\{\s*inputs\.dispatch_nonce\s*\}\}', $sampleDispatchNonce
Assert-True ($resolvedWorkflowRunName -ceq "ash-atlas-mobile-$sampleOperationId-$sampleDispatchNonce") `
    'private Mac workflow run-name resolves to the transport immutable dispatch-name formula'
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('ash-atlas-coordinated-transport-' + [guid]::NewGuid().ToString('n'))
$fakeBin = Join-Path $fixtureRoot 'bin'
$stateRoot = Join-Path $fixtureRoot 'state'
New-Item -ItemType Directory -Path $fakeBin, $stateRoot -Force | Out-Null

$operationId = 'transport-fixture-1'
$generation = 't1250'
$serverSha = 'a' * 40
$masterSha = 'b' * 40
$currentServerSha = 'c' * 40
$controlSha = 'd' * 40
$toolingSha = 'e' * 40
$dispatchNonce = 'f' * 32
$controlRepository = 'fixture/control'
$sourceRepository = 'fixture/game'
$controlWorkflow = 'fixture.yml'
$controlRef = 'refs/tags/private-control'
$dispatchPath = Join-Path $stateRoot "$operationId.dispatch.json"
$seedPath = Join-Path $stateRoot "$operationId.seed.json"
$receiptPath = Join-Path $stateRoot "$operationId.receipt.json"
$logPath = Join-Path $fixtureRoot 'gh.log'
$fakeGhScript = Join-Path $fakeBin 'gh-fake.ps1'
$fakeGhCommand = Join-Path $fakeBin 'gh.cmd'

@'
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
$log = $env:FAKE_GH_LOG
Add-Content -LiteralPath $log -Value ($Arguments -join ' ')
if ($Arguments.Count -ge 2 -and $Arguments[0] -eq 'auth' -and $Arguments[1] -eq 'status') { exit 0 }
if ($Arguments.Count -ge 2 -and $Arguments[0] -eq 'run' -and $Arguments[1] -eq 'list') {
    $listCallCount = 1
    if ($env:FAKE_GH_LIST_CALLS_FILE -and (Test-Path -LiteralPath $env:FAKE_GH_LIST_CALLS_FILE)) {
        $listCallCount = [int](Get-Content -Raw -LiteralPath $env:FAKE_GH_LIST_CALLS_FILE) + 1
    }
    if ($env:FAKE_GH_LIST_CALLS_FILE) {
        Set-Content -LiteralPath $env:FAKE_GH_LIST_CALLS_FILE -Value $listCallCount -NoNewline
    }
    if ($env:FAKE_GH_DELAYED_RUN -eq '1' -and $listCallCount -eq 1) {
        '[]'
        exit 0
    }
    $runId = if (Test-Path -LiteralPath $env:FAKE_GH_RUN_STATE) { $env:FAKE_GH_RUN_ID } else { '42' }
    $runName = if ($env:FAKE_GH_RUN_NAME_FILE -and (Test-Path -LiteralPath $env:FAKE_GH_RUN_NAME_FILE)) {
        Get-Content -Raw -LiteralPath $env:FAKE_GH_RUN_NAME_FILE
    } else { $env:FAKE_GH_RUN_NAME }
    '[{"databaseId":"' + $runId + '","status":"in_progress","conclusion":null,"headSha":"' +
        $env:FAKE_GH_CONTROL_SHA + '","headBranch":"private-control","url":"https://example.invalid/run/' +
        $runId + '","displayTitle":"' + $runName + '","name":"Private control — coordinated mobile Mac"}]'
    exit 0
}
if ($Arguments.Count -ge 2 -and $Arguments[0] -eq 'run' -and $Arguments[1] -eq 'view') {
    $runName = if ($env:FAKE_GH_RUN_NAME_FILE -and (Test-Path -LiteralPath $env:FAKE_GH_RUN_NAME_FILE)) {
        Get-Content -Raw -LiteralPath $env:FAKE_GH_RUN_NAME_FILE
    } else { $env:FAKE_GH_RUN_NAME }
    '{"databaseId":"' + $env:FAKE_GH_RUN_ID + '","status":"completed","conclusion":"failure","headSha":"' +
        $env:FAKE_GH_CONTROL_SHA + '","headBranch":"private-control","url":"https://example.invalid/run/' +
        $env:FAKE_GH_RUN_ID + '","displayTitle":"' + $runName + '","name":"Private control — coordinated mobile Mac"}'
    exit 0
}
if ($Arguments.Count -ge 2 -and $Arguments[0] -eq 'api' -and $Arguments[1] -match '/actions/runs/[0-9]+/artifacts$') {
    '{"artifacts":[{"name":"ash-atlas-private-mobile-' + $env:FAKE_GH_OPERATION_ID + '"}]}'
    exit 0
}
if ($Arguments.Count -ge 2 -and $Arguments[0] -eq 'run' -and $Arguments[1] -eq 'download') {
    $dirIndex = [array]::IndexOf($Arguments, '--dir')
    $directory = $Arguments[$dirIndex + 1]
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    [ordered]@{
        schemaVersion = 1
        kind = 'ash-atlas-coordinated-mobile-result'
        status = 'ACTION_REQUIRED'
        coordinated_operation_id = $env:FAKE_GH_OPERATION_ID
        action_required = [ordered]@{ reason = 'fixture external console action' }
    } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $directory 'coordinated-result.json') -Encoding utf8
    exit 0
}
if ($Arguments.Count -ge 2 -and $Arguments[0] -eq 'workflow' -and $Arguments[1] -eq 'run') {
    if ('--json' -notin $Arguments) { exit 1 }
    $stdinBuffer = [IO.MemoryStream]::new()
    [Console]::OpenStandardInput().CopyTo($stdinBuffer)
    $stdinBytes = $stdinBuffer.ToArray()
    $stdinBuffer.Dispose()
    if ($stdinBytes.Length -ge 3 -and $stdinBytes[0] -eq 239 -and $stdinBytes[1] -eq 187 -and $stdinBytes[2] -eq 191) {
        throw 'workflow JSON stdin must not contain a UTF-8 BOM'
    }
    $dispatchInput = [Text.Encoding]::UTF8.GetString($stdinBytes) | ConvertFrom-Json
    $dispatchInput | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath ($log + '.inputs.json') -Encoding utf8
    if ($env:FAKE_GH_FAIL_BEFORE_DISPATCH -eq '1') { exit 1 }
    if ($dispatchInput.dispatch_nonce -and $env:FAKE_GH_RUN_NAME_FILE) {
        $nonce = [string]$dispatchInput.dispatch_nonce
        Set-Content -LiteralPath $env:FAKE_GH_RUN_NAME_FILE -Value ("ash-atlas-mobile-{0}-{1}" -f $env:FAKE_GH_OPERATION_ID, $nonce) -NoNewline
    }
    New-Item -ItemType File -Path $env:FAKE_GH_RUN_STATE -Force | Out-Null
    if ($env:FAKE_GH_CRASH_AFTER_DISPATCH -eq '1') { exit 1 }
    exit 0
}
exit 1
'@ | Set-Content -LiteralPath $fakeGhScript -Encoding utf8
('@echo off' + "`r`n" + 'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0gh-fake.ps1" %*' + "`r`n") |
    Set-Content -LiteralPath $fakeGhCommand -Encoding ascii

$dispatch = [ordered]@{
    schema_version = 2
    kind = 'ash-atlas-coordinated-mobile-dispatch'
    operation_id = $operationId
    action = 'start'
    generation = $generation
    server_sha = $serverSha
    accepted_master_sha = $masterSha
    current_server_sha = $currentServerSha
    source_repository = $sourceRepository
    source_ref = "refs/tags/test/$generation"
    source_sha = $serverSha
    control_repository = $controlRepository
    control_workflow = $controlWorkflow
    control_ref = $controlRef
    control_sha = $controlSha
    tooling_sha = $toolingSha
    artifact_name = "ash-atlas-private-mobile-$operationId"
    evidence_receipt_sha256 = ''
    evidence_nonce = ''
    dispatch_nonce = $dispatchNonce
    dispatch_name = "ash-atlas-mobile-$operationId-$dispatchNonce"
    status = 'dispatching'
    dispatch_attempt_count = 1
    dispatch_requested_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    run_id = ''
    run_url = ''
    conclusion = ''
    known_run_ids = @('41')
    updated_at_utc = (Get-Date).ToUniversalTime().ToString('o')
}
$dispatch | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $dispatchPath -Encoding utf8

$oldPath = $env:PATH
$oldLog = $env:FAKE_GH_LOG
$oldOperation = $env:FAKE_GH_OPERATION_ID
$oldServer = $env:FAKE_GH_SERVER_SHA
$oldMaster = $env:FAKE_GH_MASTER_SHA
$oldCurrent = $env:FAKE_GH_CURRENT_SERVER_SHA
$oldControl = $env:FAKE_GH_CONTROL_SHA
$oldRunId = $env:FAKE_GH_RUN_ID
$oldRunState = $env:FAKE_GH_RUN_STATE
$oldRunName = $env:FAKE_GH_RUN_NAME
$oldRunNameFile = $env:FAKE_GH_RUN_NAME_FILE
$oldCrashAfterDispatch = $env:FAKE_GH_CRASH_AFTER_DISPATCH
$oldFailBeforeDispatch = $env:FAKE_GH_FAIL_BEFORE_DISPATCH
$oldDelayedRun = $env:FAKE_GH_DELAYED_RUN
$oldListCallsFile = $env:FAKE_GH_LIST_CALLS_FILE
$oldEvidenceKey = $env:COORDINATED_SERVER_EVIDENCE_HMAC_KEY
try {
    $env:PATH = "$fakeBin;$oldPath"
    $env:FAKE_GH_LOG = $logPath
    $env:FAKE_GH_OPERATION_ID = $operationId
    $env:FAKE_GH_SERVER_SHA = $serverSha
    $env:FAKE_GH_MASTER_SHA = $masterSha
    $env:FAKE_GH_CURRENT_SERVER_SHA = $currentServerSha
    $env:FAKE_GH_CONTROL_SHA = $controlSha
    $env:FAKE_GH_RUN_ID = '42'
    $env:FAKE_GH_RUN_STATE = Join-Path $fixtureRoot 'run-dispatched.marker'
    $env:FAKE_GH_RUN_NAME = "ash-atlas-mobile-$operationId-$dispatchNonce"
    $env:FAKE_GH_RUN_NAME_FILE = ''
    $env:FAKE_GH_CRASH_AFTER_DISPATCH = '0'
    $env:FAKE_GH_FAIL_BEFORE_DISPATCH = '0'
    $env:FAKE_GH_DELAYED_RUN = '0'
    $env:FAKE_GH_LIST_CALLS_FILE = ''
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = @(& powershell -NoProfile -ExecutionPolicy Bypass -File $transport `
            -Action Resume -OperationId $operationId -Generation $generation -ServerSha $serverSha `
            -AcceptedMasterSha $masterSha -CurrentServerSha $currentServerSha `
            -OutputSeedPath $seedPath -OutputReceiptPath $receiptPath -DispatchRecordPath $dispatchPath `
            -ControlRepository $controlRepository -ControlWorkflow $controlWorkflow -ControlRef $controlRef `
            -ControlSha $controlSha -ToolingSha $toolingSha -SourceRepository $sourceRepository `
            -PollSeconds 5 -PollLimit 2 2>&1)
    } finally { $ErrorActionPreference = $previousPreference }
    Assert-True ($LASTEXITCODE -ne 0 -and ($output -join "`n") -match 'ACTION_REQUIRED') `
        'interrupted mobile dispatch leaves an action-required reconciliation result'
    $record = Get-Content -Raw -LiteralPath $dispatchPath -Encoding utf8 | ConvertFrom-Json
    $log = Get-Content -Raw -LiteralPath $logPath -Encoding utf8
    Assert-True ([string]$record.run_id -eq '' -and [string]$record.last_run_id -eq '42' -and
        [string]$record.status -eq 'action_required') `
        'interrupted mobile dispatch records the reconciled run and clears terminal run identity for a fresh Resume'
    Assert-True ($log -match 'run list' -and $log -match 'run view' -and $log -match 'api' -and
        $log -match 'run download' -and
        $log -notmatch 'workflow run' -and $log -match 'fixture/control') 'resume refreshes the private control run and avoids a duplicate workflow run'

    Remove-Item -LiteralPath $env:FAKE_GH_RUN_STATE -Force -ErrorAction SilentlyContinue
    $env:FAKE_GH_RUN_ID = '43'
    $ErrorActionPreference = 'Continue'
    $secondResumeOutput = @(& powershell -NoProfile -ExecutionPolicy Bypass -File $transport `
        -Action Resume -OperationId $operationId -Generation $generation -ServerSha $serverSha `
        -AcceptedMasterSha $masterSha -CurrentServerSha $currentServerSha `
        -OutputSeedPath $seedPath -OutputReceiptPath $receiptPath -DispatchRecordPath $dispatchPath `
        -ControlRepository $controlRepository -ControlWorkflow $controlWorkflow -ControlRef $controlRef `
        -ControlSha $controlSha -ToolingSha $toolingSha -SourceRepository $sourceRepository `
        -PollSeconds 5 -PollLimit 2 2>&1)
    $ErrorActionPreference = 'Stop'
    $secondRecord = Get-Content -Raw -LiteralPath $dispatchPath -Encoding utf8 | ConvertFrom-Json
    $secondLog = Get-Content -Raw -LiteralPath $logPath -Encoding utf8
    Assert-True ($LASTEXITCODE -ne 0 -and ($secondResumeOutput -join "`n") -match 'ACTION_REQUIRED' -and
        [string]$secondRecord.last_run_id -eq '43' -and
        (@($secondRecord.known_run_ids) -contains '42') -and
        [regex]::Matches($secondLog, 'workflow run').Count -eq 1 -and
        [regex]::Matches($secondLog, 'run download').Count -eq 2) `
        'a second Resume excludes the terminal run and dispatches one fresh fenced observation'

    Remove-Item -LiteralPath $env:FAKE_GH_RUN_STATE -Force -ErrorAction SilentlyContinue
    $delayedOperationId = 'transport-delayed-run'
    $delayedNonce = '0' * 32
    $delayedDispatchPath = Join-Path $stateRoot "$delayedOperationId.dispatch.json"
    $delayedSeedPath = Join-Path $stateRoot "$delayedOperationId.seed.json"
    $delayedReceiptPath = Join-Path $stateRoot "$delayedOperationId.receipt.json"
    $delayedLogPath = Join-Path $fixtureRoot 'delayed-gh.log'
    $delayedRunState = Join-Path $fixtureRoot 'delayed-run.marker'
    $delayedListCalls = Join-Path $fixtureRoot 'delayed-list.calls'
    $delayedDispatch = [ordered]@{
        schema_version = 2; kind = 'ash-atlas-coordinated-mobile-dispatch'; operation_id = $delayedOperationId
        action = 'resume'; generation = $generation; server_sha = $serverSha
        accepted_master_sha = $masterSha; current_server_sha = $currentServerSha
        source_repository = $sourceRepository; source_ref = "refs/tags/test/$generation"; source_sha = $serverSha
        control_repository = $controlRepository; control_workflow = $controlWorkflow; control_ref = $controlRef
        control_sha = $controlSha; tooling_sha = $toolingSha; artifact_name = "ash-atlas-private-mobile-$delayedOperationId"
        dispatch_nonce = $delayedNonce; dispatch_name = "ash-atlas-mobile-$delayedOperationId-$delayedNonce"
        status = 'dispatching'; dispatch_attempt_count = 1; dispatch_requested_at_utc = ''
        run_id = ''; last_run_id = ''; run_url = ''; conclusion = ''
        known_run_ids = @('59'); updated_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    }
    $delayedDispatch | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $delayedDispatchPath -Encoding utf8
    Remove-Item -LiteralPath $delayedRunState, $delayedListCalls -Force -ErrorAction SilentlyContinue
    $env:FAKE_GH_OPERATION_ID = $delayedOperationId
    $env:FAKE_GH_LOG = $delayedLogPath
    $env:FAKE_GH_RUN_ID = '60'
    $env:FAKE_GH_RUN_STATE = $delayedRunState
    $env:FAKE_GH_RUN_NAME = "ash-atlas-mobile-$delayedOperationId-$delayedNonce"
    $env:FAKE_GH_RUN_NAME_FILE = ''
    $env:FAKE_GH_DELAYED_RUN = '1'
    $env:FAKE_GH_LIST_CALLS_FILE = $delayedListCalls
    $ErrorActionPreference = 'Continue'
    $delayedOutput = @(& powershell -NoProfile -ExecutionPolicy Bypass -File $transport `
        -Action Resume -OperationId $delayedOperationId -Generation $generation -ServerSha $serverSha `
        -AcceptedMasterSha $masterSha -CurrentServerSha $currentServerSha `
        -OutputSeedPath $delayedSeedPath -OutputReceiptPath $delayedReceiptPath -DispatchRecordPath $delayedDispatchPath `
        -ControlRepository $controlRepository -ControlWorkflow $controlWorkflow -ControlRef $controlRef `
        -ControlSha $controlSha -ToolingSha $toolingSha -SourceRepository $sourceRepository `
        -PollSeconds 5 -PollLimit 2 2>&1)
    $ErrorActionPreference = 'Stop'
    $delayedRecord = Get-Content -Raw -LiteralPath $delayedDispatchPath -Encoding utf8 | ConvertFrom-Json
    $delayedLog = Get-Content -Raw -LiteralPath $delayedLogPath -Encoding utf8
    Assert-True ($LASTEXITCODE -ne 0 -and ($delayedOutput -join "`n") -match 'ACTION_REQUIRED' -and
        [string]$delayedRecord.last_run_id -eq '60' -and
        [regex]::Matches($delayedLog, 'workflow run').Count -eq 0 -and
        [regex]::Matches($delayedLog, 'run download').Count -eq 1) `
        'a run appearing in the pre-dispatch snapshot is bound instead of duplicated'

    $env:FAKE_GH_OPERATION_ID = $operationId
    $env:FAKE_GH_LOG = $logPath
    $env:FAKE_GH_RUN_ID = '43'
    $env:FAKE_GH_RUN_STATE = Join-Path $fixtureRoot 'run-dispatched.marker'
    $env:FAKE_GH_RUN_NAME = "ash-atlas-mobile-$operationId-$dispatchNonce"
    $env:FAKE_GH_RUN_NAME_FILE = ''
    $env:FAKE_GH_DELAYED_RUN = '0'
    $env:FAKE_GH_LIST_CALLS_FILE = ''
    Remove-Item -LiteralPath $env:FAKE_GH_RUN_STATE -Force -ErrorAction SilentlyContinue

    $refreshDispatchPath = Join-Path $stateRoot "$operationId.refresh.dispatch.json"
    $refreshSeedPath = Join-Path $stateRoot "$operationId.refresh.seed.json"
    $refreshReceiptPath = Join-Path $stateRoot "$operationId.refresh.receipt.json"
    [ordered]@{ stale = $true } | ConvertTo-Json | Set-Content -LiteralPath $refreshSeedPath -Encoding utf8
    [ordered]@{ stale = $true } | ConvertTo-Json | Set-Content -LiteralPath $refreshReceiptPath -Encoding utf8
    [ordered]@{
        schema_version = 2; kind = 'ash-atlas-coordinated-mobile-dispatch'; operation_id = $operationId
        action = 'resume'; generation = $generation; server_sha = $serverSha
        accepted_master_sha = $masterSha; current_server_sha = $currentServerSha
        source_repository = $sourceRepository; source_ref = "refs/tags/test/$generation"; source_sha = $serverSha
        control_repository = $controlRepository; control_workflow = $controlWorkflow; control_ref = $controlRef
        control_sha = $controlSha; tooling_sha = $toolingSha; artifact_name = "ash-atlas-private-mobile-$operationId"
        dispatch_nonce = $dispatchNonce; dispatch_name = "ash-atlas-mobile-$operationId-$dispatchNonce"
        status = 'completed'; dispatch_attempt_count = 1; dispatch_requested_at_utc = ''
        run_id = '42'; last_run_id = ''; run_url = ''; conclusion = 'failure'
        known_run_ids = @('41', '42'); updated_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    } | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $refreshDispatchPath -Encoding utf8
    $env:FAKE_GH_RUN_ID = '43'
    $ErrorActionPreference = 'Continue'
    $refreshOutput = @(& powershell -NoProfile -ExecutionPolicy Bypass -File $transport `
        -Action Resume -OperationId $operationId -Generation $generation -ServerSha $serverSha `
        -AcceptedMasterSha $masterSha -CurrentServerSha $currentServerSha `
        -OutputSeedPath $refreshSeedPath -OutputReceiptPath $refreshReceiptPath -DispatchRecordPath $refreshDispatchPath `
        -ControlRepository $controlRepository -ControlWorkflow $controlWorkflow -ControlRef $controlRef `
        -ControlSha $controlSha -ToolingSha $toolingSha -SourceRepository $sourceRepository `
        -PollSeconds 5 -PollLimit 2 2>&1)
    $ErrorActionPreference = 'Stop'
    Assert-True ($LASTEXITCODE -ne 0 -and ($refreshOutput -join "`n") -match 'ACTION_REQUIRED') `
        'completed pre-health dispatch starts a fresh observation run on Resume'
    $refreshRecord = Get-Content -Raw -LiteralPath $refreshDispatchPath -Encoding utf8 | ConvertFrom-Json
    $refreshLog = Get-Content -Raw -LiteralPath $logPath -Encoding utf8
    $refreshInputs = Get-Content -Raw -LiteralPath ($logPath + '.inputs.json') | ConvertFrom-Json
    Assert-True ([string]$refreshRecord.run_id -eq '' -and [string]$refreshRecord.last_run_id -eq '43' -and
        [string]$refreshRecord.status -eq 'action_required' -and
        (@($refreshRecord.known_run_ids) -contains '42') -and $refreshLog -match 'workflow run' -and
        $refreshLog -match 'fixture/control' -and $refreshLog -match 'refs/tags/private-control' -and
        $refreshInputs.tooling_sha -ceq $toolingSha -and $refreshInputs.server_sha -ceq $serverSha -and
        $refreshInputs.dispatch_nonce -ceq $dispatchNonce -and
        $refreshLog -notmatch 'coordinated_operation_id=') 'fresh private control observation run is uniquely tracked instead of reusing stale artifacts'

    $earlyOperationId = 'transport-early-failure'
    $earlyDispatchPath = Join-Path $stateRoot "$earlyOperationId.dispatch.json"
    $earlySeedPath = Join-Path $stateRoot "$earlyOperationId.seed.json"
    $earlyReceiptPath = Join-Path $stateRoot "$earlyOperationId.receipt.json"
    $earlyLogPath = Join-Path $fixtureRoot 'early-gh.log'
    $earlyRunState = Join-Path $fixtureRoot 'early-run.marker'
    $earlyRunNameFile = Join-Path $fixtureRoot 'early-run-name.txt'
    Remove-Item -LiteralPath $earlyRunState, $earlyRunNameFile -Force -ErrorAction SilentlyContinue
    $env:FAKE_GH_OPERATION_ID = $earlyOperationId
    $env:FAKE_GH_LOG = $earlyLogPath
    $env:FAKE_GH_RUN_ID = '51'
    $env:FAKE_GH_RUN_STATE = $earlyRunState
    $env:FAKE_GH_RUN_NAME = ''
    $env:FAKE_GH_RUN_NAME_FILE = $earlyRunNameFile
    $env:FAKE_GH_FAIL_BEFORE_DISPATCH = '1'
    $env:FAKE_GH_CRASH_AFTER_DISPATCH = '0'
    $ErrorActionPreference = 'Continue'
    $earlyFirstOutput = @(& powershell -NoProfile -ExecutionPolicy Bypass -File $transport `
        -Action Start -OperationId $earlyOperationId -Generation $generation -ServerSha $serverSha `
        -AcceptedMasterSha $masterSha -CurrentServerSha $currentServerSha `
        -OutputSeedPath $earlySeedPath -OutputReceiptPath $earlyReceiptPath -DispatchRecordPath $earlyDispatchPath `
        -ControlRepository $controlRepository -ControlWorkflow $controlWorkflow -ControlRef $controlRef `
        -ControlSha $controlSha -ToolingSha $toolingSha -SourceRepository $sourceRepository `
        -PollSeconds 5 -PollLimit 2 2>&1)
    $ErrorActionPreference = 'Stop'
    $earlyFirstRecord = Get-Content -Raw -LiteralPath $earlyDispatchPath -Encoding utf8 | ConvertFrom-Json
    Assert-True ($LASTEXITCODE -ne 0 -and ($earlyFirstOutput -join "`n") -match 'dispatch was not accepted' -and
        [string]$earlyFirstRecord.status -eq 'dispatching' -and
        [int]$earlyFirstRecord.dispatch_attempt_count -eq 1 -and
        [string]$earlyFirstRecord.dispatch_nonce -match '^[0-9a-f]{32}$' -and
        [string]$earlyFirstRecord.dispatch_name -eq "ash-atlas-mobile-$earlyOperationId-$($earlyFirstRecord.dispatch_nonce)" -and
        -not (Test-Path -LiteralPath $earlyRunState)) `
        'early dispatch failure leaves one immutable nonce and a replayable dispatching record'

    $env:FAKE_GH_FAIL_BEFORE_DISPATCH = '0'
    $ErrorActionPreference = 'Continue'
    $earlyResumeOutput = @(& powershell -NoProfile -ExecutionPolicy Bypass -File $transport `
        -Action Resume -OperationId $earlyOperationId -Generation $generation -ServerSha $serverSha `
        -AcceptedMasterSha $masterSha -CurrentServerSha $currentServerSha `
        -OutputSeedPath $earlySeedPath -OutputReceiptPath $earlyReceiptPath -DispatchRecordPath $earlyDispatchPath `
        -ControlRepository $controlRepository -ControlWorkflow $controlWorkflow -ControlRef $controlRef `
        -ControlSha $controlSha -ToolingSha $toolingSha -SourceRepository $sourceRepository `
        -PollSeconds 5 -PollLimit 2 2>&1)
    $ErrorActionPreference = 'Stop'
    $earlyResumeRecord = Get-Content -Raw -LiteralPath $earlyDispatchPath -Encoding utf8 | ConvertFrom-Json
    $earlyLog = Get-Content -Raw -LiteralPath $earlyLogPath -Encoding utf8
    Assert-True ($LASTEXITCODE -ne 0 -and ($earlyResumeOutput -join "`n") -match 'ACTION_REQUIRED' -and
        [int]$earlyResumeRecord.dispatch_attempt_count -eq 2 -and
        [string]$earlyResumeRecord.status -eq 'action_required' -and
        [string]$earlyResumeRecord.last_run_id -eq '51' -and
        [regex]::Matches($earlyLog, 'workflow run').Count -eq 2 -and
        (Get-Content -Raw -LiteralPath ($earlyLogPath + '.inputs.json') | ConvertFrom-Json).dispatch_nonce -ceq $earlyResumeRecord.dispatch_nonce) `
        'Resume safely replays an early dispatch failure with the same nonce and fences the run identity'

    $crashOperationId = 'transport-crash-window'
    $crashDispatchPath = Join-Path $stateRoot "$crashOperationId.dispatch.json"
    $crashSeedPath = Join-Path $stateRoot "$crashOperationId.seed.json"
    $crashReceiptPath = Join-Path $stateRoot "$crashOperationId.receipt.json"
    $crashLogPath = Join-Path $fixtureRoot 'crash-gh.log'
    $crashRunState = Join-Path $fixtureRoot 'crash-run.marker'
    $crashRunNameFile = Join-Path $fixtureRoot 'crash-run-name.txt'
    Remove-Item -LiteralPath $crashRunState, $crashRunNameFile -Force -ErrorAction SilentlyContinue
    $env:FAKE_GH_OPERATION_ID = $crashOperationId
    $env:FAKE_GH_LOG = $crashLogPath
    $env:FAKE_GH_RUN_ID = '52'
    $env:FAKE_GH_RUN_STATE = $crashRunState
    $env:FAKE_GH_RUN_NAME = ''
    $env:FAKE_GH_RUN_NAME_FILE = $crashRunNameFile
    $env:FAKE_GH_FAIL_BEFORE_DISPATCH = '0'
    $env:FAKE_GH_CRASH_AFTER_DISPATCH = '1'
    $ErrorActionPreference = 'Continue'
    $crashFirstOutput = @(& powershell -NoProfile -ExecutionPolicy Bypass -File $transport `
        -Action Start -OperationId $crashOperationId -Generation $generation -ServerSha $serverSha `
        -AcceptedMasterSha $masterSha -CurrentServerSha $currentServerSha `
        -OutputSeedPath $crashSeedPath -OutputReceiptPath $crashReceiptPath -DispatchRecordPath $crashDispatchPath `
        -ControlRepository $controlRepository -ControlWorkflow $controlWorkflow -ControlRef $controlRef `
        -ControlSha $controlSha -ToolingSha $toolingSha -SourceRepository $sourceRepository `
        -PollSeconds 5 -PollLimit 2 2>&1)
    $ErrorActionPreference = 'Stop'
    Assert-True ($LASTEXITCODE -ne 0 -and (Test-Path -LiteralPath $crashRunState) -and
        (Test-Path -LiteralPath $crashRunNameFile)) `
        'dispatch crash fixture leaves a visible run and durable dispatch record before transport exit'
    $ErrorActionPreference = 'Continue'
    $crashResumeOutput = @(& powershell -NoProfile -ExecutionPolicy Bypass -File $transport `
        -Action Resume -OperationId $crashOperationId -Generation $generation -ServerSha $serverSha `
        -AcceptedMasterSha $masterSha -CurrentServerSha $currentServerSha `
        -OutputSeedPath $crashSeedPath -OutputReceiptPath $crashReceiptPath -DispatchRecordPath $crashDispatchPath `
        -ControlRepository $controlRepository -ControlWorkflow $controlWorkflow -ControlRef $controlRef `
        -ControlSha $controlSha -ToolingSha $toolingSha -SourceRepository $sourceRepository `
        -PollSeconds 5 -PollLimit 2 2>&1)
    $ErrorActionPreference = 'Stop'
    $crashRecord = Get-Content -Raw -LiteralPath $crashDispatchPath -Encoding utf8 | ConvertFrom-Json
    $crashLog = Get-Content -Raw -LiteralPath $crashLogPath -Encoding utf8
    Assert-True ($LASTEXITCODE -ne 0 -and ($crashResumeOutput -join "`n") -match 'ACTION_REQUIRED' -and
        [int]$crashRecord.dispatch_attempt_count -eq 1 -and
        [string]$crashRecord.status -eq 'action_required' -and
        [string]$crashRecord.last_run_id -eq '52' -and
        [regex]::Matches($crashLog, 'workflow run').Count -eq 1 -and
        $crashLog -match 'api') `
        'Resume correlates a run after a dispatch crash before artifact upload without duplicating the workflow'
    # The Windows evidence file is deliberately local: only its exact signed bytes
    # may cross the workflow boundary, and retry must retain those bytes and nonce.
    . (Join-Path $PSScriptRoot 'coordinated-release.ps1')
    $postHealthDispatchPath = Join-Path $stateRoot 'post-health.dispatch.json'
    $localEvidencePath = Join-Path $stateRoot 'windows-only-evidence.json'
    $signedEvidencePath = Join-Path $stateRoot 'windows-only-signed.json'
    $candidates = [ordered]@{}
    foreach ($platform in @('ios', 'android')) {
        $candidate = [pscustomobject]@{
            source_sha = $serverSha; generation = $generation; release_id = "release-$platform"
            marketing_version = '1.2.3'; build = 17; store_build_id = "store-$platform"
            artifact_sha256 = ('a' * 64); tooling_sha = $toolingSha; metadata_sha256 = ('b' * 64)
            countries = @('US'); rollout = [pscustomobject]@{ kind = 'update'; mode = 'full' }
        }
        $candidates[$platform] = [ordered]@{
            child_operation_id = "$operationId`:$platform"; candidate = $candidate
            approval_fingerprint = Get-CoordinatedReleaseExpectedApprovalFingerprint $candidate $platform
        }
    }
    [ordered]@{
        schemaVersion = 1; kind = 'ash-atlas-coordinated-server-evidence'
        coordinated_operation_id = $operationId; phase = 'server_healthy'
        source_sha = $serverSha; server_sha = $serverSha; accepted_master_sha = $masterSha
        generation = $generation; published = $true; activated = $true; healthy = $true
        authenticated = $false; nonce = ('1' * 32); candidates = $candidates
    } | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $localEvidencePath -Encoding utf8
    $env:COORDINATED_SERVER_EVIDENCE_HMAC_KEY = [Convert]::ToBase64String([byte[]](1..32))
    $env:FAKE_GH_LOG = $logPath
    $env:FAKE_GH_OPERATION_ID = $operationId
    $env:FAKE_GH_RUN_ID = '53'
    $env:FAKE_GH_RUN_STATE = Join-Path $fixtureRoot 'post-health-run.marker'
    $env:FAKE_GH_RUN_NAME_FILE = Join-Path $fixtureRoot 'post-health-run-name.txt'
    $env:FAKE_GH_FAIL_BEFORE_DISPATCH = '0'
    $env:FAKE_GH_DELAYED_RUN = '0'
    $env:FAKE_GH_LIST_CALLS_FILE = ''
    $env:FAKE_GH_CRASH_AFTER_DISPATCH = '0'
    $postHealthArguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $transport,
        '-Action', 'PostHealth', '-OperationId', $operationId, '-Generation', $generation,
        '-ServerSha', $serverSha, '-AcceptedMasterSha', $masterSha, '-CurrentServerSha', $currentServerSha,
        '-OutputSeedPath', $seedPath, '-OutputReceiptPath', $receiptPath, '-DispatchRecordPath', $postHealthDispatchPath,
        '-ControlRepository', $controlRepository, '-ControlWorkflow', $controlWorkflow, '-ControlRef', $controlRef,
        '-ControlSha', $controlSha, '-ToolingSha', $toolingSha, '-SourceRepository', $sourceRepository,
        '-ServerEvidencePath', $localEvidencePath, '-ServerEvidenceFile', $signedEvidencePath,
        '-PollSeconds', '5', '-PollLimit', '2')
    $ErrorActionPreference = 'Continue'
    $postHealthOutput = @(& powershell @postHealthArguments 2>&1)
    $ErrorActionPreference = 'Stop'
    Assert-True (($postHealthOutput -join "`n") -match 'fixture external console action') 'post-health signed evidence reaches the reconciled Mac workflow result'
    $sent = Get-Content -Raw -LiteralPath ($logPath + '.inputs.json') | ConvertFrom-Json
    $signedBytes = [IO.File]::ReadAllBytes($signedEvidencePath)
    $firstPostHealthRecord = Get-Content -Raw -LiteralPath $postHealthDispatchPath | ConvertFrom-Json
    Assert-True ($sent.action -ceq 'post-health' -and $sent.server_evidence_base64 -ceq [Convert]::ToBase64String($signedBytes) -and
        $sent.server_evidence_sha256 -ceq $firstPostHealthRecord.evidence_transport_sha256 -and
        $null -eq $sent.PSObject.Properties['server_evidence_file']) 'post-health dispatch carries exact signed bytes and hash without a Windows path'
    $env:FAKE_GH_RUN_ID = '54'
    $env:FAKE_GH_RUN_STATE = Join-Path $fixtureRoot 'post-health-retry-run.marker'
    $ErrorActionPreference = 'Continue'
    $postHealthRetryOutput = @(& powershell @postHealthArguments 2>&1)
    $ErrorActionPreference = 'Stop'
    Assert-True (($postHealthRetryOutput -join "`n") -match 'fixture external console action') 'post-health retry reaches the reconciled workflow result'
    $resent = Get-Content -Raw -LiteralPath ($logPath + '.inputs.json') | ConvertFrom-Json
    Assert-True ($resent.server_evidence_base64 -ceq $sent.server_evidence_base64 -and
        $resent.server_evidence_sha256 -ceq $sent.server_evidence_sha256 -and
        $resent.dispatch_nonce -ceq $sent.dispatch_nonce) 'post-health retry preserves the original signed bytes, transport hash, and dispatch nonce'
} finally {
    $env:PATH = $oldPath
    $env:FAKE_GH_LOG = $oldLog
    $env:FAKE_GH_OPERATION_ID = $oldOperation
    $env:FAKE_GH_SERVER_SHA = $oldServer
    $env:FAKE_GH_MASTER_SHA = $oldMaster
    $env:FAKE_GH_CURRENT_SERVER_SHA = $oldCurrent
    $env:FAKE_GH_CONTROL_SHA = $oldControl
    $env:FAKE_GH_RUN_ID = $oldRunId
    $env:FAKE_GH_RUN_STATE = $oldRunState
    $env:FAKE_GH_RUN_NAME = $oldRunName
    $env:FAKE_GH_RUN_NAME_FILE = $oldRunNameFile
    $env:FAKE_GH_CRASH_AFTER_DISPATCH = $oldCrashAfterDispatch
    $env:FAKE_GH_FAIL_BEFORE_DISPATCH = $oldFailBeforeDispatch
    $env:FAKE_GH_DELAYED_RUN = $oldDelayedRun
    $env:FAKE_GH_LIST_CALLS_FILE = $oldListCallsFile
    $env:COORDINATED_SERVER_EVIDENCE_HMAC_KEY = $oldEvidenceKey
    Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "coordinated mobile transport fixtures passed: $script:Passed"
