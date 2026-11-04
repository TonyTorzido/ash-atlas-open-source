[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'run-main.ps1') -RuntimeMode Main -Stop
exit $LASTEXITCODE
