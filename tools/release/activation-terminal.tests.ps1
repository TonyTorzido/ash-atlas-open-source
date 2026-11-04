$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$script:RepositoryRoot = $root
$script:ReleaseControllerPath = Join-Path $PSScriptRoot 'accept-and-publish-test-server.ps1'
. (Join-Path $PSScriptRoot 'deployment-transport.ps1')
$source = Get-Content -Raw -LiteralPath $script:ReleaseControllerPath
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw 'release controller has parse errors' }
$names = @('Stop-Workflow', 'Get-StateValue', 'Get-TextSha256', 'Get-FileSha256',
    'Get-GitText', 'Get-GitFields', 'Get-GitCommitId', 'Assert-CanonicalSha',
    'Get-MobileRegistryRemote', 'Get-TrustedMobileReleaseToolPath', 'Set-MobileActivationIntent',
    'Test-MobileActivationIntentIdentity', 'Get-MobileActivationRegistryStatus',
    'Resolve-MobileActivationIntentRemote', 'Test-ReceiptMutationEvidence',
    'Test-ReceiptNoMutation', 'Resolve-MobileActivationIntent')
$definitions = @($ast.FindAll({ param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in $names
}, $true))
if ($definitions.Count -ne $names.Count) { throw 'terminal reconciliation functions were not found uniquely' }
foreach ($definition in $definitions) { Invoke-Expression $definition.Extent.Text }
# Use the real controller and disposable registry CAS, with no durable operation state writes.
function Write-State { param($State) }
$script:Passed = 0
function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
    $script:Passed++
}
# Keep the same fixture in the broader release suite and this bounded regression runner.
$tests = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'release-flow.tests.ps1')
$start = $tests.IndexOf('$activationRegistryFixtureRoot =')
$end = $tests.IndexOf('Assert-True ($orchestrator -match', $start)
if ($start -lt 0 -or $end -le $start) { throw 'activation registry fixture boundaries were not found' }
Invoke-Expression $tests.Substring($start, $end - $start)
Write-Output "Activation terminal tests passed: $script:Passed"
