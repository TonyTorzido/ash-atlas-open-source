[CmdletBinding()]
param(
    [switch]$ApprovedIntegrationTest,
    [switch]$ConfirmPublish,
    [switch]$ConfirmDeploy,
    [string]$OperationId
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$orchestrator = Join-Path $PSScriptRoot 'accept-and-publish-test-server.ps1'
Write-Warning 'publish-test-server.ps1 is a compatibility entry point; the canonical workflow is accept-and-publish-test-server.ps1.'
& powershell -NoProfile -ExecutionPolicy Bypass -File $orchestrator Publish `
    -ApprovedIntegrationTest:$ApprovedIntegrationTest `
    -ConfirmPublish:$ConfirmPublish `
    -ConfirmDeploy:$ConfirmDeploy `
    -OperationId $OperationId
exit $LASTEXITCODE
