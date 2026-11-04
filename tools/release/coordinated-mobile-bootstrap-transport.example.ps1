[CmdletBinding()]
param(
    [ValidateSet('Start', 'Resume', 'PostHealth')][string]$Action = 'Start',
    [Parameter(Mandatory = $true)][string]$OperationId,
    [Parameter(Mandatory = $true)][ValidatePattern('^t\d{3,4}$')][string]$Generation,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$ServerSha,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$AcceptedMasterSha,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$CurrentServerSha,
    [Parameter(Mandatory = $true)][string]$OutputSeedPath,
    [Parameter(Mandatory = $true)][string]$OutputReceiptPath,
    [Parameter(Mandatory = $true)][string]$DispatchRecordPath,
    [string]$ServerEvidencePath,
    [string]$AuthenticatedEvidencePath,
    [Parameter(Mandatory = $true)][string]$ControlRepository,
    [Parameter(Mandatory = $true)][string]$ControlWorkflow,
    [Parameter(Mandatory = $true)][string]$ControlRef,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$ControlSha,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$ToolingSha,
    [string]$SourceRepository = 'example-org/game',
    [string]$ServerEvidenceFile,
    [int]$PollSeconds = 15,
    [int]$PollLimit = 240
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'coordinated-release.ps1')

function Stop-MobileTransport([string]$Message) { throw "ACTION_REQUIRED: $Message" }
function Invoke-GhJson {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    $output = @(& gh @Arguments 2>&1)
    if ($LASTEXITCODE -ne 0) { Stop-MobileTransport "gh request failed: $($output -join ' ')" }
    try { return (($output -join "`n") | ConvertFrom-Json) }
    catch { Stop-MobileTransport 'gh returned unreadable JSON' }
}
function Assert-Hash([string]$Value, [string]$Label) {
    if ($Value -notmatch '^[0-9a-f]{40}$') { Stop-MobileTransport "$Label is not canonical" }
}
function Write-AtomicJson([string]$Path, $Value) {
    $directory = Split-Path -Parent $Path
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $temporary = "$Path.$PID.tmp"
    try {
        $json = $Value | ConvertTo-Json -Depth 24
        $utf8NoBom = [Text.UTF8Encoding]::new($false)
        [IO.File]::WriteAllText($temporary, $json + [Environment]::NewLine, $utf8NoBom)
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
    }
}
function Get-FileSha256Text([string]$Path) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($algorithm.ComputeHash([IO.File]::ReadAllBytes($Path)))).Replace('-', '').ToLowerInvariant()
    } finally { $algorithm.Dispose() }
}
function New-DispatchNonce {
    $bytes = New-Object byte[] 16
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($bytes) }
    finally { $generator.Dispose() }
    return ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
}
function Get-DispatchName([string]$Nonce) {
    if ($Nonce -notmatch '^[0-9a-f]{32}$') {
        Stop-MobileTransport 'durable mobile dispatch nonce is not canonical'
    }
    return "ash-atlas-mobile-$OperationId-$Nonce"
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { Stop-MobileTransport 'GitHub CLI is not installed on the trusted controller' }
& gh auth status 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Stop-MobileTransport 'trusted controller GitHub CLI is not authenticated' }
if ($OperationId -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$') {
    Stop-MobileTransport 'coordinated operation ID is unsafe'
}
if ($ControlRepository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or
    $SourceRepository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or
    [String]::Equals($ControlRepository, $SourceRepository, [StringComparison]::OrdinalIgnoreCase)) {
    Stop-MobileTransport 'private control and game source repositories must be distinct canonical owner/repository names'
}
if ($ControlWorkflow -notmatch '^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}[.]ya?ml$' -or
    $ControlWorkflow -match '(^|/)\.\.?(/|$)') {
    Stop-MobileTransport 'private control workflow path is unsafe'
}
if ($ControlRef -notmatch '^(?:(?:refs/)?(?:heads|tags)/)?[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$' -or
    $ControlRef -match '(^|/)\.\.?(/|$)') {
    Stop-MobileTransport 'private control workflow ref is unsafe'
}
$ControlSha = $ControlSha.ToLowerInvariant()
$ToolingSha = $ToolingSha.ToLowerInvariant()
if ($PollSeconds -lt 5 -or $PollSeconds -gt 60 -or $PollLimit -lt 1 -or $PollLimit -gt 480) {
    Stop-MobileTransport 'mobile transport polling bounds are unsafe'
}
if ($Action -eq 'PostHealth' -and -not $ServerEvidenceFile) {
    Stop-MobileTransport 'post-health release requires a trusted Mac-visible server evidence path'
}

function Read-JsonFile([string]$Path, [string]$Label) {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try { return Get-Content -Raw -LiteralPath $Path -Encoding utf8 | ConvertFrom-Json }
    catch { Stop-MobileTransport "$Label is unreadable" }
}

function Get-RunList {
    return @(Invoke-GhJson @(
            'run', 'list', '--repo', $ControlRepository, '--workflow', $ControlWorkflow, '--event', 'workflow_dispatch',
            '--limit', '50', '--json', 'databaseId,status,conclusion,headSha,headBranch,displayTitle,name,url'
        ))
}

function Get-RunById([string]$RunId) {
    if (-not $RunId) { return $null }
    try {
        return Invoke-GhJson @('run', 'view', $RunId, '--repo', $ControlRepository,
            '--json', 'databaseId,status,conclusion,headSha,headBranch,displayTitle,name,url')
    } catch { return $null }
}

function Get-RunDisplayTitle($Run) {
    $displayTitle = [string](Get-CoordinatedProperty $Run 'displayTitle' '')
    if (-not $displayTitle) { $displayTitle = [string](Get-CoordinatedProperty $Run 'name' '') }
    return $displayTitle
}

function Assert-RunIdentity($Run, [string]$ExpectedDispatchName) {
    if ($null -eq $Run -or [string]$Run.headSha -cne $ControlSha) {
        Stop-MobileTransport 'private control workflow run did not resolve to the pinned control SHA'
    }
    if (-not $ExpectedDispatchName -or (Get-RunDisplayTitle $Run) -cne $ExpectedDispatchName) {
        Stop-MobileTransport 'private control workflow run did not resolve to the immutable dispatch name'
    }
    return $Run
}

function Get-MobileArtifactName {
    return "ash-atlas-private-mobile-$OperationId"
}

function Test-RunArtifactBinding([string]$RunId) {
    if (-not $RunId) { return $false }
    $payload = Invoke-GhJson @('api', "repos/$ControlRepository/actions/runs/$RunId/artifacts")
    $matches = @($payload.artifacts | Where-Object { [string]$_.name -ceq (Get-MobileArtifactName) })
    return $matches.Count -eq 1
}

function Write-DispatchRecord($Record) {
    Write-AtomicJson $DispatchRecordPath $Record
}

function New-DispatchRecord([string[]]$KnownRunIds) {
    $dispatchNonce = New-DispatchNonce
    return [pscustomobject][ordered]@{
        schema_version = 2
        kind = 'ash-atlas-coordinated-mobile-dispatch'
        operation_id = $OperationId
        requested_mode = if ($Action -eq 'PostHealth') { '' } else { 'CoordinatedRelease' }
        action = $Action.ToLowerInvariant()
        source_repository = $SourceRepository
        source_ref = "refs/tags/test/$Generation"
        source_sha = $ServerSha
        control_repository = $ControlRepository
        control_workflow = $ControlWorkflow
        control_ref = $ControlRef
        control_sha = $ControlSha
        tooling_sha = $ToolingSha
        artifact_name = Get-MobileArtifactName
        generation = $Generation
        server_sha = $ServerSha
        accepted_master_sha = $AcceptedMasterSha
        current_server_sha = $CurrentServerSha
        evidence_receipt_sha256 = ''
        evidence_transport_sha256 = ''
        evidence_nonce = ''
        dispatch_nonce = $dispatchNonce
        dispatch_name = Get-DispatchName $dispatchNonce
        status = 'dispatching'
        dispatch_attempt_count = 0
        dispatch_requested_at_utc = ''
        run_id = ''
        last_run_id = ''
        run_url = ''
        conclusion = ''
        known_run_ids = @($KnownRunIds)
        updated_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    }
}

function Assert-DispatchRecordIdentity($Record) {
    if ($null -eq $Record) { return }
    if ([int](Get-CoordinatedProperty $Record 'schema_version' 0) -ne 2) {
        Stop-MobileTransport 'durable mobile dispatch record uses an obsolete schema; inspect before replay'
    }
    foreach ($property in @(
            'operation_id', 'generation', 'server_sha', 'accepted_master_sha', 'current_server_sha',
            'source_repository', 'source_ref', 'source_sha', 'control_repository', 'control_workflow',
            'control_ref', 'control_sha', 'tooling_sha', 'artifact_name', 'dispatch_nonce', 'dispatch_name')) {
        if ($null -eq $Record.PSObject.Properties[$property]) {
            Stop-MobileTransport "durable mobile dispatch record is missing immutable $property"
        }
        $expected = switch ($property) {
            'operation_id' { $OperationId }
            'generation' { $Generation }
            'server_sha' { $ServerSha }
            'accepted_master_sha' { $AcceptedMasterSha }
            'current_server_sha' { $CurrentServerSha }
            'source_repository' { $SourceRepository }
            'source_ref' { "refs/tags/test/$Generation" }
            'source_sha' { $ServerSha }
            'control_repository' { $ControlRepository }
            'control_workflow' { $ControlWorkflow }
            'control_ref' { $ControlRef }
            'control_sha' { $ControlSha }
            'tooling_sha' { $ToolingSha }
            'artifact_name' { Get-MobileArtifactName }
            'dispatch_nonce' { [string](Get-CoordinatedProperty $Record 'dispatch_nonce' '') }
            'dispatch_name' { Get-DispatchName ([string](Get-CoordinatedProperty $Record 'dispatch_nonce' '')) }
        }
        if ([string]$Record.$property -cne [string]$expected) {
            Stop-MobileTransport "durable mobile dispatch record $property changed"
        }
    }
    if ([string]$Record.dispatch_nonce -notmatch '^[0-9a-f]{32}$') {
        Stop-MobileTransport 'durable mobile dispatch record nonce is not canonical'
    }
    $recordAction = [string]$Record.action
    $expectedAction = $Action.ToLowerInvariant()
    if (($Action -eq 'PostHealth' -and $recordAction -cne 'posthealth') -or
        ($Action -ne 'PostHealth' -and $recordAction -notin @('start', 'resume'))) {
        Stop-MobileTransport 'durable mobile dispatch action differs from the requested action'
    }
}

function Ensure-DispatchRecordShape($Record) {
    if ($null -eq $Record) { return $null }
    if ([int](Get-CoordinatedProperty $Record 'schema_version' 0) -ne 2 -or
        -not [string](Get-CoordinatedProperty $Record 'dispatch_nonce' '') -or
        -not [string](Get-CoordinatedProperty $Record 'dispatch_name' '')) {
        Stop-MobileTransport 'durable mobile dispatch record lacks the immutable dispatch nonce; manual recovery is required'
    }
    $defaults = [ordered]@{
        known_run_ids = @()
        evidence_receipt_sha256 = ''
        evidence_transport_sha256 = ''
        evidence_nonce = ''
        status = 'dispatching'
        dispatch_attempt_count = 0
        dispatch_requested_at_utc = ''
        run_id = ''
        last_run_id = ''
        run_url = ''
        conclusion = ''
        updated_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    }
    foreach ($property in $defaults.Keys) {
        if ($null -eq $Record.PSObject.Properties[$property]) {
            $Record | Add-Member -NotePropertyName $property -NotePropertyValue $defaults[$property]
        }
    }
    return $Record
}

function Find-DispatchRun {
    param(
        [Parameter(Mandatory = $true)]$Record,
        [switch]$ExcludeKnownRunIds,
        [object[]]$Runs = $null
    )
    $knownRunIds = @((Get-CoordinatedProperty $Record 'known_run_ids' @()) |
        ForEach-Object { [string]$_ } | Where-Object { $_ })
    $searchRuns = if ($null -eq $Runs) { @(Get-RunList) } else { @($Runs) }
    $matches = @($searchRuns | Where-Object {
            ((-not $ExcludeKnownRunIds) -or [string]$_.databaseId -notin $knownRunIds) -and
            [string]$_.headSha -ceq $ControlSha -and
            (Get-RunDisplayTitle $_) -ceq [string]$Record.dispatch_name
        })
    if ($matches.Count -gt 1) {
        Stop-MobileTransport 'multiple private control runs match the immutable dispatch name'
    }
    if ($matches.Count -eq 1) { return Assert-RunIdentity $matches[0] ([string]$Record.dispatch_name) }
    return $null
}

function Bind-DispatchRun($Record, $Run) {
    $bound = Assert-RunIdentity $Run ([string]$Record.dispatch_name)
    $Record.run_id = [string]$bound.databaseId
    $Record.run_url = [string]$bound.url
    $Record.status = 'running'
    $Record.updated_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    Write-DispatchRecord $Record
    return $bound
}

function Get-EvidenceKey {
    $encoded = [string]$env:COORDINATED_SERVER_EVIDENCE_HMAC_KEY
    if (-not $encoded) { Stop-MobileTransport 'post-health release requires the coordinated evidence HMAC secret' }
    try { $bytes = [Convert]::FromBase64String($encoded) }
    catch { Stop-MobileTransport 'coordinated evidence HMAC secret must be base64 encoded' }
    if ($bytes.Length -lt 32) { Stop-MobileTransport 'coordinated evidence HMAC secret is shorter than 256 bits' }
    return $bytes
}

function New-AuthenticatedServerEvidence {
    param([Parameter(Mandatory = $true)]$Evidence)
    if (-not $ServerEvidencePath -or -not (Test-Path -LiteralPath $ServerEvidencePath -PathType Leaf)) {
        Stop-MobileTransport 'post-health release requires the canonical server evidence payload'
    }
    if ([int]$Evidence.schemaVersion -ne 1 -or
        [string]$Evidence.kind -cne 'ash-atlas-coordinated-server-evidence' -or
        [string]$Evidence.coordinated_operation_id -cne $OperationId -or
        [string]$Evidence.phase -notin @('server_healthy', 'apps_release_requested', 'completed') -or
        [string]$Evidence.source_sha -cne $ServerSha -or
        [string]$Evidence.server_sha -cne $ServerSha -or
        [string]$Evidence.accepted_master_sha -cne $AcceptedMasterSha -or
        [string]$Evidence.generation -cne $Generation -or
        -not [bool]$Evidence.published -or -not [bool]$Evidence.activated -or
        -not [bool]$Evidence.healthy -or [bool]$Evidence.authenticated -or
        [string]$Evidence.nonce -notmatch '^[0-9a-f]{32}$') {
        Stop-MobileTransport 'canonical server evidence is not the exact healthy pinned payload'
    }
    foreach ($platform in @('ios', 'android')) {
        $property = $Evidence.candidates.PSObject.Properties[$platform]
        $entry = if ($null -eq $property) { $null } else { $property.Value }
        $candidate = if ($null -eq $entry) { $null } else { $entry.candidate }
        if ($null -eq $entry -or $null -eq $candidate -or
            [string]$entry.child_operation_id -cne "$OperationId`:$platform" -or
            [string]$candidate.source_sha -cne $ServerSha -or
            [string]$candidate.generation -cne $Generation -or
            [string]$entry.approval_fingerprint -cne
                (Get-CoordinatedReleaseExpectedApprovalFingerprint $candidate $platform)) {
            Stop-MobileTransport "$platform canonical server evidence candidate is not exact"
        }
    }
    $key = Get-EvidenceKey
    $keyId = [string]$env:COORDINATED_SERVER_EVIDENCE_HMAC_KEY_ID
    if (-not $keyId) { $keyId = 'coordinated-server-evidence-v1' }
    if ($keyId -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$') {
        Stop-MobileTransport 'coordinated evidence HMAC key ID is unsafe'
    }
    $envelope = [ordered]@{}
    foreach ($property in @($Evidence.PSObject.Properties)) {
        if ($property.Name -notin @('receipt_sha256', 'hmac_sha256')) {
            $envelope[$property.Name] = $property.Value
        }
    }
    $envelope.authenticated = $true
    $envelope.authoritative = $true
    $envelope.hmac_algorithm = 'HMAC-SHA256'
    $envelope.hmac_key_id = $keyId
    $macInput = ConvertTo-CoordinatedCanonicalJson ([pscustomobject]$envelope)
    $envelope.hmac_sha256 = Get-CoordinatedHmacSha256Text $macInput $key
    $receiptInput = ConvertTo-CoordinatedCanonicalJson ([pscustomobject]$envelope)
    $envelope.receipt_sha256 = Get-CoordinatedSha256Text $receiptInput
    $result = [pscustomobject]$envelope
    if ($AuthenticatedEvidencePath) { Write-AtomicJson $AuthenticatedEvidencePath $result }
    return $result
}

$dispatchRecord = Ensure-DispatchRecordShape (Read-JsonFile $DispatchRecordPath 'durable mobile dispatch record')
$dispatchRecordWasPresent = $null -ne $dispatchRecord
Assert-DispatchRecordIdentity $dispatchRecord
if ($null -ne $dispatchRecord -and [string]$dispatchRecord.status -eq 'action_required') {
    if ($null -eq $dispatchRecord.PSObject.Properties['last_run_id']) {
        $dispatchRecord | Add-Member -NotePropertyName last_run_id -NotePropertyValue ''
    }
    $actionRequiredChanged = $false
    if ([string]$dispatchRecord.run_id) {
        $dispatchRecord.last_run_id = [string]$dispatchRecord.run_id
        $dispatchRecord.run_id = ''
        $actionRequiredChanged = $true
    }
    $lastRunId = [string]$dispatchRecord.last_run_id
    $knownRunIds = @((Get-CoordinatedProperty $dispatchRecord 'known_run_ids' @()) |
        ForEach-Object { [string]$_ } | Where-Object { $_ })
    if ($lastRunId -and $lastRunId -notin $knownRunIds) {
        $knownRunIds += $lastRunId
        $dispatchRecord.known_run_ids = @($knownRunIds | Select-Object -Unique)
        $actionRequiredChanged = $true
    }
    if ($actionRequiredChanged) {
        $dispatchRecord.updated_at_utc = (Get-Date).ToUniversalTime().ToString('o')
        Write-DispatchRecord $dispatchRecord
    }
}
if ($Action -eq 'PostHealth') {
    $serverEvidence = Read-JsonFile $ServerEvidencePath 'canonical server evidence'
    $authenticatedEvidence = New-AuthenticatedServerEvidence $serverEvidence
    $evidenceReceiptSha = [string]$authenticatedEvidence.receipt_sha256
    $evidenceNonce = [string]$authenticatedEvidence.nonce
    Write-AtomicJson $ServerEvidenceFile $authenticatedEvidence
    $evidenceTransportSha = Get-FileSha256Text $ServerEvidenceFile
} else {
    $authenticatedEvidence = $null
    $evidenceReceiptSha = ''
    $evidenceTransportSha = ''
    $evidenceNonce = ''
}

$knownRuns = if ($null -ne $dispatchRecord) {
    @((Get-CoordinatedProperty $dispatchRecord 'known_run_ids' @()) |
        ForEach-Object { [string]$_ } | Where-Object { $_ })
} else { @() }
if ($null -eq $dispatchRecord) { $dispatchRecord = New-DispatchRecord $knownRuns }
Assert-DispatchRecordIdentity $dispatchRecord
if ($evidenceReceiptSha) {
    if ([string]$dispatchRecord.evidence_receipt_sha256 -and
        [string]$dispatchRecord.evidence_receipt_sha256 -cne $evidenceReceiptSha) {
        Stop-MobileTransport 'durable post-health evidence changed during retry'
    }
    $dispatchRecord.evidence_receipt_sha256 = $evidenceReceiptSha
    if ([string]$dispatchRecord.evidence_transport_sha256 -and
        [string]$dispatchRecord.evidence_transport_sha256 -cne $evidenceTransportSha) {
        Stop-MobileTransport 'durable post-health evidence transport bytes changed during retry'
    }
    $dispatchRecord.evidence_transport_sha256 = $evidenceTransportSha
    $dispatchRecord.evidence_nonce = $evidenceNonce
}

$reuseCompleted = [string]$dispatchRecord.status -eq 'completed' -and
    $Action -eq 'Start' -and (Test-Path -LiteralPath $OutputSeedPath -PathType Leaf) -and
    (Test-Path -LiteralPath $OutputReceiptPath -PathType Leaf)

$refreshCompleted = -not $reuseCompleted -and
    [string]$dispatchRecord.status -eq 'completed'
if ($refreshCompleted) {
    $completedRunId = [string]$dispatchRecord.run_id
    if ($completedRunId) {
        if ($completedRunId -notin $knownRuns) { $knownRuns += $completedRunId }
        $dispatchRecord.known_run_ids = @($knownRuns | Select-Object -Unique)
        $dispatchRecord.last_run_id = $completedRunId
    }
    $dispatchRecord.run_id = ''
    $dispatchRecord.run_url = ''
    $dispatchRecord.conclusion = ''
    $dispatchRecord.status = 'requested'
    $dispatchRecord.updated_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    Write-DispatchRecord $dispatchRecord
}

$run = $null
if (-not $reuseCompleted -and [string]$dispatchRecord.run_id) {
    $run = Get-RunById ([string]$dispatchRecord.run_id)
    if ($null -eq $run) { Stop-MobileTransport 'durable mobile dispatch run cannot be reconciled' }
    Assert-RunIdentity $run ([string]$dispatchRecord.dispatch_name) | Out-Null
}
if (-not $reuseCompleted -and $null -eq $run -and -not $refreshCompleted) {
    # The run name is the immutable idempotency fence.  It is available as
    # soon as GitHub accepts the dispatch, before the artifact is uploaded.
    $run = Find-DispatchRun $dispatchRecord -ExcludeKnownRunIds
    if ($null -ne $run) {
        $run = Bind-DispatchRun $dispatchRecord $run
    }
}
if (-not $reuseCompleted -and $null -eq $run) {
    $canDispatch = -not $dispatchRecordWasPresent -or
        ([string]$dispatchRecord.status -eq 'requested' -and
            [int]$dispatchRecord.dispatch_attempt_count -eq 0 -and
            -not [string]$dispatchRecord.run_id) -or
        $refreshCompleted -or
        ([string]$dispatchRecord.status -eq 'action_required' -and
            -not [string]$dispatchRecord.run_id) -or
        ([string]$dispatchRecord.status -eq 'dispatching' -and
            -not [string]$dispatchRecord.run_id)
    if ($canDispatch) {
        # Keep the previous known set separate while inspecting this fresh
        # snapshot. A run can become visible between the first reconciliation
        # list and this pre-dispatch list; classify that exact run before adding
        # its ID to the exclusion fence.
        $preDispatchRuns = @(Get-RunList)
        if (-not $refreshCompleted) {
            $run = Find-DispatchRun $dispatchRecord -ExcludeKnownRunIds -Runs $preDispatchRuns
            if ($null -ne $run) {
                $run = Bind-DispatchRun $dispatchRecord $run
            }
            if ($null -ne $run) { $canDispatch = $false }
        }
        $knownRunIds = @((Get-CoordinatedProperty $dispatchRecord 'known_run_ids' @()) |
            ForEach-Object { [string]$_ } | Where-Object { $_ })
        $knownRunIds += @($preDispatchRuns | ForEach-Object { [string]$_.databaseId } |
            Where-Object { $_ })
        $dispatchRecord.known_run_ids = @($knownRunIds | Select-Object -Unique)
        if ($null -ne $run) {
            Write-DispatchRecord $dispatchRecord
        }
    }
    if ($canDispatch) {
        $dispatchRecord.status = 'dispatching'
        $dispatchRecord.dispatch_attempt_count = [int]$dispatchRecord.dispatch_attempt_count + 1
        $dispatchRecord.dispatch_requested_at_utc = (Get-Date).ToUniversalTime().ToString('o')
        $dispatchRecord.updated_at_utc = (Get-Date).ToUniversalTime().ToString('o')
        Write-DispatchRecord $dispatchRecord
        $dispatchAction = if ($Action -eq 'PostHealth') { 'post-health' } else { $Action.ToLowerInvariant() }
        $dispatch = @('workflow', 'run', $ControlWorkflow, '--repo', $ControlRepository, '--ref', $ControlRef, '--json')
        $dispatchInputs = [ordered]@{
            action = $dispatchAction
            operation_id = $OperationId
            generation = $Generation
            server_sha = $ServerSha
            accepted_master_sha = $AcceptedMasterSha
            current_server_sha = $CurrentServerSha
            tooling_sha = $ToolingSha
            dispatch_nonce = [string]$dispatchRecord.dispatch_nonce
        }
        if ($Action -eq 'PostHealth') {
            $evidenceBytes = [IO.File]::ReadAllBytes($ServerEvidenceFile)
            $algorithm = [Security.Cryptography.SHA256]::Create()
            try {
                $transportHash = ([BitConverter]::ToString($algorithm.ComputeHash($evidenceBytes))).Replace('-', '').ToLowerInvariant()
            } finally { $algorithm.Dispose() }
            if ($evidenceBytes.Length -eq 0 -or $evidenceBytes.Length -gt 32768 -or
                $transportHash -cne [string]$dispatchRecord.evidence_transport_sha256) {
                Stop-MobileTransport 'post-health evidence bytes are changed or exceed the dispatch size limit'
            }
            $dispatchInputs.server_evidence_base64 = [Convert]::ToBase64String($evidenceBytes)
            $dispatchInputs.server_evidence_sha256 = [string]$dispatchRecord.evidence_transport_sha256
        }
        $dispatchJson = $dispatchInputs | ConvertTo-Json -Compress
        if ($dispatchJson.Length -gt 65535) { Stop-MobileTransport 'mobile workflow inputs exceed the dispatch size limit' }
        $previousInputEncoding = [Console]::InputEncoding
        try {
            # All dispatch fields are validated ASCII identities or base64. PS5
            # otherwise prefixes native stdin with a BOM that gh's JSON rejects.
            [Console]::InputEncoding = [Text.Encoding]::ASCII
            $dispatchJson | & gh @dispatch 2>&1 | Out-Null
        } finally { [Console]::InputEncoding = $previousInputEncoding }
        if ($LASTEXITCODE -ne 0) {
            $dispatchRecord.updated_at_utc = (Get-Date).ToUniversalTime().ToString('o')
            Write-DispatchRecord $dispatchRecord
            Stop-MobileTransport 'mobile workflow dispatch was not accepted; durable request remains for reconciliation'
        }
    } elseif ([string]$dispatchRecord.status -notin @('dispatching', 'running')) {
        Stop-MobileTransport 'durable mobile dispatch is not eligible for reconciliation or a new dispatch'
    }
}

if (-not $reuseCompleted) {
    for ($attempt = 0; $attempt -lt $PollLimit; $attempt++) {
        if ([string]$dispatchRecord.run_id) {
            $run = Get-RunById ([string]$dispatchRecord.run_id)
            if ($null -ne $run) { Assert-RunIdentity $run ([string]$dispatchRecord.dispatch_name) | Out-Null }
        }
        if ($null -eq $run -and -not [string]$dispatchRecord.run_id) {
            $run = Find-DispatchRun $dispatchRecord -ExcludeKnownRunIds
            if ($null -ne $run) { $run = Bind-DispatchRun $dispatchRecord $run }
        }
        if ($null -ne $run -and [string]$run.status -eq 'completed') { break }
        if ($attempt + 1 -lt $PollLimit) { Start-Sleep -Seconds $PollSeconds }
    }
    if ($null -eq $run -or -not [string]$run.databaseId) {
        Stop-MobileTransport 'mobile Mac dispatch remains unreconciled; Resume will inspect the durable request'
    }
    Assert-RunIdentity $run ([string]$dispatchRecord.dispatch_name) | Out-Null
    if ([string]$run.status -ne 'completed') {
        $dispatchRecord.status = 'running'
        $dispatchRecord.run_id = [string]$run.databaseId
        $dispatchRecord.run_url = [string]$run.url
        $dispatchRecord.updated_at_utc = (Get-Date).ToUniversalTime().ToString('o')
        Write-DispatchRecord $dispatchRecord
        Stop-MobileTransport 'mobile Mac workflow exceeded its bounded poll window; durable run remains resumable'
    }
    $dispatchRecord.status = 'completed'
    $dispatchRecord.run_id = [string]$run.databaseId
    $dispatchRecord.run_url = [string]$run.url
    $dispatchRecord.conclusion = [string]$run.conclusion
    $dispatchRecord.updated_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    Write-DispatchRecord $dispatchRecord
}

if (-not $reuseCompleted) {
    if (-not (Test-RunArtifactBinding ([string]$run.databaseId))) {
        Stop-MobileTransport 'mobile control run does not expose the exact operation artifact'
    }
    $temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) "ash-atlas-mobile-bootstrap-$OperationId-$PID"
    New-Item -ItemType Directory -Path $temporaryDirectory -Force | Out-Null
    try {
    & gh run download ([string]$run.databaseId) '--repo' $ControlRepository '--name' (Get-MobileArtifactName) '--dir' $temporaryDirectory 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Stop-MobileTransport 'mobile workflow artifact download failed' }
    $resultFiles = @(Get-ChildItem -LiteralPath $temporaryDirectory -Filter 'coordinated-result.json' -File -Recurse)
    if ($resultFiles.Count -ne 1) {
        Stop-MobileTransport 'mobile workflow artifact must contain exactly one coordinated-result.json'
    }
    try { $result = Get-Content -Raw -LiteralPath $resultFiles[0].FullName -Encoding utf8 | ConvertFrom-Json }
    catch { Stop-MobileTransport 'mobile coordinated result is unreadable' }
    $resultOperation = [string](Get-CoordinatedProperty $result 'coordinated_operation_id' '')
    $resultStatus = [string](Get-CoordinatedProperty $result 'status' '')
    $resultSchemaValid = [int](Get-CoordinatedProperty $result 'schemaVersion' 0) -eq 1 -and
        [string](Get-CoordinatedProperty $result 'kind' '') -ceq 'ash-atlas-coordinated-mobile-result' -and
        $resultOperation -ceq $OperationId
    $fallbackActionRequired = $resultStatus -ceq 'ACTION_REQUIRED' -and
        [string]$run.conclusion -cne 'success'
    if (-not $resultSchemaValid -and -not $fallbackActionRequired) {
        Stop-MobileTransport 'mobile coordinated result is not bound to the pinned operation'
    }
    if ([string]$run.conclusion -cne 'success' -or $resultStatus -ceq 'ACTION_REQUIRED') {
        $actionRequired = Get-CoordinatedProperty $result 'action_required' $null
        $reason = [string](Get-CoordinatedProperty $actionRequired 'reason' '')
        if (-not $reason) { $reason = [string](Get-CoordinatedProperty $result 'reason' '') }
        if (-not $reason) { $reason = [string](Get-CoordinatedProperty $result 'code' '') }
        if (-not $reason) { $reason = "mobile Mac workflow ended $($run.conclusion)" }
        $knownRunIds = @((Get-CoordinatedProperty $dispatchRecord 'known_run_ids' @()) |
            ForEach-Object { [string]$_ } | Where-Object { $_ })
        if ([string]$run.databaseId -and [string]$run.databaseId -notin $knownRunIds) {
            $knownRunIds += [string]$run.databaseId
        }
        $dispatchRecord.known_run_ids = @($knownRunIds | Select-Object -Unique)
        $dispatchRecord.status = 'action_required'
        $dispatchRecord.last_run_id = [string]$run.databaseId
        $dispatchRecord.run_id = ''
        $dispatchRecord.run_url = ''
        $dispatchRecord.conclusion = [string]$run.conclusion
        $dispatchRecord.updated_at_utc = (Get-Date).ToUniversalTime().ToString('o')
        Write-DispatchRecord $dispatchRecord
        Stop-MobileTransport "mobile Mac bootstrap requires operator action: $reason"
    }
    $seedFile = Join-Path $temporaryDirectory 'coordinated-seed.json'
    $receiptFile = Join-Path $temporaryDirectory 'coordinated-mobile-receipt.json'
    $seed = $null
    $receipt = $result
    if ($Action -ne 'PostHealth') {
        $bootstrapScript = Join-Path $PSScriptRoot '..\mobile-release\coordinated-bootstrap.mjs'
        if (-not (Test-Path -LiteralPath $bootstrapScript -PathType Leaf)) {
            Stop-MobileTransport 'canonical mobile bootstrap materializer is missing'
        }
        & node $bootstrapScript --operation-id $OperationId --generation $Generation --server-sha $ServerSha `
            --accepted-master-sha $AcceptedMasterSha --current-server-sha $CurrentServerSha `
            --result-file $resultFiles[0].FullName --seed-path $seedFile --receipt-path $receiptFile 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $seedFile -PathType Leaf) -or
            -not (Test-Path -LiteralPath $receiptFile -PathType Leaf)) {
            Stop-MobileTransport 'canonical mobile bootstrap materializer rejected the exact result'
        }
        try {
            $seed = Get-Content -Raw -LiteralPath $seedFile -Encoding utf8 | ConvertFrom-Json
            $receipt = Get-Content -Raw -LiteralPath $receiptFile -Encoding utf8 | ConvertFrom-Json
        } catch { Stop-MobileTransport 'materialized mobile seed or receipt is unreadable' }
    }
    if ($null -ne $seed -and ([int]$seed.schema_version -ne 1 -or [string]$seed.kind -cne 'ash-atlas-coordinated-release-seed' -or
        [string]$seed.operation_id -cne $OperationId -or [string]$seed.pinned.generation -cne $Generation -or
        [string]$seed.pinned.server_sha -cne $ServerSha -or
        [string]$seed.pinned.accepted_master_sha -cne $AcceptedMasterSha -or
        [string]$seed.pinned.current_server_sha -cne $CurrentServerSha)) {
        Stop-MobileTransport 'mobile seed does not match the pinned server request'
    }
    if ([int]$receipt.schemaVersion -ne 1 -or [string]$receipt.kind -cne 'ash-atlas-coordinated-mobile-result' -or
        [string]$receipt.coordinated_operation_id -cne $OperationId) {
        Stop-MobileTransport 'mobile receipt result does not match the pinned operation'
    }
    $children = @($receipt.receipts)
    $childPlatforms = @($children | ForEach-Object { [string]$_.platform } | Sort-Object -Unique)
    if ($children.Count -ne 2 -or $childPlatforms.Count -ne 2 -or
        @($children | Where-Object { $_.platform -notin @('ios', 'android') }).Count -ne 0) {
        Stop-MobileTransport 'mobile receipt result must contain exactly one iOS and Android child'
    }
    foreach ($child in $children) {
        $expectedApprovalFingerprint = Get-CoordinatedReleaseExpectedApprovalFingerprint $child.candidate $child.platform
        if ([string]$child.operation_id -cne "$OperationId`:$($child.platform)" -or
            [string]$child.candidate.source_sha -cne $ServerSha -or
            [string]$child.candidate.generation -cne $Generation -or
            [string]$child.candidate.artifact_sha256 -notmatch '^[0-9a-f]{64}$' -or
            [string]$child.candidate.tooling_sha -notmatch '^[0-9a-f]{40}$' -or
            [string]$child.candidate.metadata_sha256 -notmatch '^[0-9a-f]{64}$' -or
            [string]$child.approval.fingerprint -cne $expectedApprovalFingerprint -or
            [string]$child.receipt_sha256 -notmatch '^[0-9a-f]{64}$') {
            Stop-MobileTransport "$($child.platform) child receipt is not bound to the pinned request"
        }
    }
    if ($null -ne $seed) { Write-AtomicJson $OutputSeedPath $seed }
    Write-AtomicJson $OutputReceiptPath $receipt
    } finally {
        Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
}
