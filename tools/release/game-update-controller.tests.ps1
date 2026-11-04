$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$controllerPath = Join-Path $PSScriptRoot 'game-update-controller.ps1'
$controllerText = Get-Content -Raw -LiteralPath $controllerPath
$tokens = $null
$errors = $null
[void][Management.Automation.Language.Parser]::ParseInput(
    $controllerText, [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) {
    throw "game update controller parse failed: $($errors -join '; ')"
}

function Assert-GameUpdateController([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
}

Assert-GameUpdateController ($controllerText -match [regex]::Escape(
        'C:\ProgramData\AshAtlas\CoordinatedRelease\control.json')) `
    'controller reads the fixed ACL-protected control configuration'
Assert-GameUpdateController ($controllerText -match "runner_account" -and
    $controllerText -match '\[Environment\]::UserName -cne \$expectedAccount') `
    'controller binds execution to the configured trusted runner account'
Assert-GameUpdateController ($controllerText -match 'allowed_tooling_sha' -and
    $controllerText.Contains("rev-parse', '--verify', 'HEAD^{commit}") -and
    $controllerText.Contains("status', '--porcelain")) `
    'controller validates the exact clean tooling checkout'
Assert-GameUpdateController ($controllerText.Contains('$canonicalMode = switch ($Action)') -and
    $controllerText.Contains("'start' { 'Publish' }") -and
    $controllerText.Contains("'inspect' { 'Inspect' }") -and
    $controllerText.Contains("'resume' { 'Resume' }")) `
    'controller maps the three request actions to canonical modes'
Assert-GameUpdateController ($controllerText.Contains("'-ApprovedIntegrationTest', '-ConfirmPublish', '-ConfirmDeploy'") -and
    $controllerText.Contains("'-ExpectedGeneration', `$canonicalGeneration") -and
    $controllerText.Contains("'-ExpectedCandidateSha', `$ExpectedCandidateSha")) `
    'start forwards the confirmed exact candidate and existing publish authorization to the canonical coordinator'

Write-Output 'game-update-controller.tests.ps1: focused checks passed'
