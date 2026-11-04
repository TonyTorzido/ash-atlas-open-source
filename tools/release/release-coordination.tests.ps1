$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$orchestratorPath = Join-Path $PSScriptRoot 'accept-and-publish-test-server.ps1'
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(
    $orchestratorPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw 'orchestrator does not parse' }

foreach ($functionName in @(
        'Set-StateValue', 'Get-StateValue', 'Get-ProcessStartUtc',
        'ConvertTo-CanonicalProcessStartUtc',
        'Test-ReleaseQueueOwnerAlive', 'Read-ReleaseCoordinationJson',
        'Write-ReleaseCoordinationJson', 'Remove-StaleReleaseQueueTickets',
        'Get-ReleaseQueueTickets', 'Test-ReleaseOperationActivelyCoordinated',
        'Acquire-ReleaseLease', 'Release-ReleaseLease'
    )) {
    $functionAst = @($ast.FindAll({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq $functionName
    }, $true))
    if ($functionAst.Count -ne 1) { throw "expected one $functionName helper" }
    Invoke-Expression $functionAst[0].Extent.Text
}

function Stop-Workflow([string]$Message) { throw $Message }
function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
    $script:Passed++
}

$script:Passed = 0
$ReleaseCoordinationRoot = Join-Path $env:TEMP ("ash-atlas-release-coordination-" +
    [guid]::NewGuid().ToString('n'))
$ReleaseLeaseTimeoutSeconds = 1
$ReleaseLeasePollSeconds = 1
$Json = $false
$script:ReleaseLeaseStream = $null
$script:ReleaseLeaseTicket = ''
$script:ReleaseLeaseOwner = ''
New-Item -ItemType Directory -Path $ReleaseCoordinationRoot -Force | Out-Null
try {
    $stalePath = Join-Path $ReleaseCoordinationRoot 'stale.queue.json'
    Write-ReleaseCoordinationJson $stalePath ([pscustomobject]@{
            schema_version = 1
            operation_id = 'stale'
            requested_mode = 'IntegrateAndPublish'
            process_id = 2147483647
            process_started_at_utc = '2000-01-01T00:00:00.0000000Z'
            requested_at_utc = '2000-01-01T00:00:00.0000000Z'
        })
    Remove-StaleReleaseQueueTickets
    Assert-True (-not (Test-Path -LiteralPath $stalePath)) 'dead queue owners are removed'
    Assert-True (-not (Test-ReleaseOperationActivelyCoordinated 'stale')) `
        'dead operations are not treated as active coordination owners'

    Acquire-ReleaseLease 'operation-a' 'IntegrateAndPublish'
    $owner = Read-ReleaseCoordinationJson (Join-Path $ReleaseCoordinationRoot 'owner.json')
    Assert-True ($null -ne $script:ReleaseLeaseStream -and
        [string]$owner.operation_id -eq 'operation-a' -and
        [int]$owner.process_id -eq $PID) 'lease records the exact live process owner'
    Assert-True (@(Get-ReleaseQueueTickets).Count -eq 1) 'lease owner retains one queue ticket'
    Release-ReleaseLease 'operation-a'
    Assert-True ($null -eq $script:ReleaseLeaseStream -and
        -not (Test-Path -LiteralPath (Join-Path $ReleaseCoordinationRoot 'owner.json')) -and
        @(Get-ReleaseQueueTickets).Count -eq 0) 'release removes only the exact owner and ticket'

    $earlier = [pscustomobject]@{
        schema_version = 1
        operation_id = 'operation-earlier'
        requested_mode = 'IntegrateAndPublish'
        process_id = $PID
        process_started_at_utc = (Get-ProcessStartUtc $PID)
        requested_at_utc = '2001-01-01T00:00:00.0000000Z'
    }
    Write-ReleaseCoordinationJson `
        (Join-Path $ReleaseCoordinationRoot 'operation-earlier.queue.json') $earlier
    Assert-True (Test-ReleaseOperationActivelyCoordinated 'operation-earlier') `
        'a live queued process is recognized before unrelated work joins the queue'
    $roundTrippedEarlier = ($earlier | ConvertTo-Json | ConvertFrom-Json)
    Assert-True (Test-ReleaseQueueOwnerAlive $roundTrippedEarlier) `
        'live ownership survives ISO timestamp deserialization across PowerShell runtimes'
    $timedOut = $false
    try { Acquire-ReleaseLease 'operation-later' 'IntegrateAndPublish' }
    catch { $timedOut = $_.Exception.Message -match 'release lease wait exceeded' }
    Assert-True $timedOut 'a later ticket cannot bypass the earlier live ticket'
    Assert-True (Test-Path -LiteralPath (
            Join-Path $ReleaseCoordinationRoot 'operation-earlier.queue.json')) `
        'timed-out waiter does not remove another operation ticket'
} finally {
    Release-ReleaseLease 'operation-a'
    Remove-Item -LiteralPath $ReleaseCoordinationRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Release coordination checks passed: $script:Passed"
