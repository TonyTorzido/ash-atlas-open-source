$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Import-Module (Join-Path $PSScriptRoot 'launcher-lib.psm1') -Force
$script:Passed = 0

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
    $script:Passed++
}

function Assert-Equal($Actual, $Expected, [string]$Message) {
    if ($Actual -ne $Expected) {
        throw "ASSERTION FAILED: $Message. Expected '$Expected', got '$Actual'."
    }
    $script:Passed++
}

$identity = 'appearance-t333-runtime'
$port = Get-AshAtlasAppearanceStudioPort -Identity $identity
Assert-Equal (Get-AshAtlasAppearanceStudioPort -Identity 'official' -OfficialCheckout) 5285 `
    'official checkout keeps port 5285'
Assert-Equal (Get-AshAtlasAppearanceStudioPort -Identity $identity) $port `
    'feature port is deterministic'
Assert-True ($port -ge 25285 -and $port -le 45284) `
    'feature port stays in the dedicated loopback range'
Assert-True ((Get-AshAtlasAppearanceStudioPort -Identity 'other-runtime') -ne $port) `
    'different registered identity receives another stable port'

$content = New-AshAtlasAppearanceStudioLauncherContent `
    -WorktreePath 'C:\worktrees\appearance__t333' `
    -Identity $identity
Assert-True ($content.Contains('APPEARANCE_STUDIO_EXPECTED_WORKTREE=%STUDIO_ROOT%')) `
    'generated launcher passes expected worktree'
Assert-True ($content.Contains('APPEARANCE_STUDIO_EXPECTED_BRANCH')) `
    'generated launcher passes expected branch'
Assert-True ($content.Contains('APPEARANCE_STUDIO_EXPECTED_COMMIT')) `
    'generated launcher passes expected commit'
Assert-True ($content.Contains("APPEARANCE_STUDIO_EXPECTED_PORT=$port")) `
    'generated launcher passes selected port'

Write-Host "Appearance Studio launcher policy tests passed: $script:Passed"
