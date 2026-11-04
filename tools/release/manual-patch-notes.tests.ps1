$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$orchestrator = Get-Content -Raw (Join-Path $PSScriptRoot 'accept-and-publish-test-server.ps1')
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($orchestrator, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw "orchestrator parser errors: $errors" }
foreach ($parameter in $ast.ParamBlock.Parameters) {
    Set-Variable -Scope Script -Name $parameter.Name.VariablePath.UserPath -Value $null
}
foreach ($functionName in @('Get-StateValue', 'New-WorkflowState', 'ConvertTo-PlayerPatchNote', 'Get-IntegrationMergeMessage')) {
    $definition = $ast.Find({ param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $functionName
    }, $true)
    Invoke-Expression $definition.Extent.Text
}
function Stop-Workflow([string]$Message) { throw $Message }
function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
    Write-Host "PASS: $Message"
}
function Get-GameRepositoryRoot { return $root }
function Get-GameIntegrationWorktree { return $root }
$script:ConfiguredReleaseMode = 'paused'
$script:RepositoryRoot = $root
$script:Mode = 'Publish'
$script:PublishPatchNotes = $false
$script:ReleasePatchNotes = @()
$script:FeatureWorktrees = @()
$script:PlayerPatchNotes = @()
$script:DeploymentPollIntervalSeconds = 2
$publicationGuardStart = $orchestrator.LastIndexOf('if ($PublishPatchNotes -or $PSBoundParameters.ContainsKey(')
$publicationGuardEnd = $orchestrator.IndexOf("if (`$Mode -in @('Integrate', 'IntegrateAndPublish', 'IntegrateBatchAdmission')) {", $publicationGuardStart)
$publicationGuard = [scriptblock]::Create($orchestrator.Substring($publicationGuardStart,
    $publicationGuardEnd - $publicationGuardStart).Replace('$PSBoundParameters', '$testBoundParameters'))
foreach ($fixture in @(
    @{ mode = 'Publish'; consent = $false; notes = @(); bound = @{}; allowed = $true },
    @{ mode = 'Publish'; consent = $true; notes = @(); bound = @{}; allowed = $false },
    @{ mode = 'Publish'; consent = $false; notes = @('User supplied wording.'); bound = @{ ReleasePatchNotes = $true }; allowed = $false },
    @{ mode = 'Publish'; consent = $true; notes = @('User supplied wording.'); bound = @{ ReleasePatchNotes = $true }; allowed = $true },
    @{ mode = 'Resume'; consent = $true; notes = @('User supplied wording.'); bound = @{ ReleasePatchNotes = $true }; allowed = $false }
)) {
    $accepted = $true
    try {
        & {
            $Mode = $fixture.mode
            $PublishPatchNotes = $fixture.consent
            $ReleasePatchNotes = $fixture.notes
            $testBoundParameters = $fixture.bound
            . $publicationGuard
        }
    } catch { $accepted = $false }
    Assert-True ($accepted -eq $fixture.allowed) "publication wording and consent gate: $($fixture.mode), $($fixture.consent), $($fixture.notes.Count)"
}
Assert-True ((Get-IntegrationMergeMessage 'Merge optional notes' '') -ceq 'Merge optional notes') `
    'note-free integration has no player-note trailer'

$constructedWorkflowState = New-WorkflowState
Assert-True ($constructedWorkflowState.release_patch_notes_hex -ceq 'none') 'new operations default to no patch-note publication'
$script:PublishPatchNotes = $true
$script:ReleasePatchNotes = @('User supplied wording.')
$explicitNotesState = New-WorkflowState
$frozenNoteBytes = for ($i = 0; $i -lt $explicitNotesState.release_patch_notes_hex.Length; $i += 2) {
    [Convert]::ToByte($explicitNotesState.release_patch_notes_hex.Substring($i, 2), 16)
}
$decodedFrozenNotes = [Text.Encoding]::UTF8.GetString([byte[]]$frozenNoteBytes) | ConvertFrom-Json
Assert-True ([string]$decodedFrozenNotes[0] -ceq 'User supplied wording.') 'operation state freezes supplied wording'
$script:PublishPatchNotes = $false
$script:ReleasePatchNotes = @()

# Exercise the actual integration input guards without executing release side effects.
$start = $orchestrator.LastIndexOf("if (`$Mode -in @('Integrate', 'IntegrateAndPublish', 'IntegrateBatchAdmission')) {")
$end = $orchestrator.IndexOf("if (`$Mode -eq 'RecoverIntegrationWorktree' -and -not `$OperationId)", $start)
$integrationGuard = [scriptblock]::Create($orchestrator.Substring($start, $end - $start).Replace('$PSBoundParameters', '$testBoundParameters'))
foreach ($batch in @($false, $true)) {
    & {
        $Mode = 'Integrate'
        $FeatureWorktree = if ($batch) { '' } else { 'fixture' }
        $FeatureWorktrees = if ($batch) { @('one', 'two') } else { @() }
        $PlayerPatchNote = ''
        $PlayerPatchNotes = @()
        $testBoundParameters = @{}
        . $integrationGuard
        Assert-True (-not $PlayerPatchNote -and (!$batch -or $PlayerPatchNotes.Count -eq 2)) 'single or batch integration accepts omitted notes'
    }
}
$start = $orchestrator.IndexOf("    if ([string](Get-StateValue `$existing 'release_patch_notes_hex' 'none') -cne")
$end = $orchestrator.IndexOf('    if ($sameSingleFeature', $start)
$resumeGuard = [scriptblock]::Create($orchestrator.Substring($start, $end - $start))
$existing = $explicitNotesState
$PublishPatchNotes = $true
$ReleasePatchNotes = @('User supplied wording.')
. $resumeGuard
$ReleasePatchNotes = @('Different supplied wording.')
$refused = $false
try { . $resumeGuard } catch { $refused = $true }
Assert-True $refused 'automatic resume rejects replacement wording'
$PublishPatchNotes = $false
$ReleasePatchNotes = @()
$refused = $false
try { . $resumeGuard } catch { $refused = $true }
Assert-True $refused 'automatic resume rejects changed consent'
