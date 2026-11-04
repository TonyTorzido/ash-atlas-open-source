param(
    [Parameter(Mandatory = $true)][string]$WorktreePath,
    [Parameter(Mandatory = $true)][string]$Identity,
    [Parameter(Mandatory = $true)][string]$OutputPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Import-Module (Join-Path $PSScriptRoot 'launcher-lib.psm1') -Force

$resolvedWorktree = [IO.Path]::GetFullPath($WorktreePath).TrimEnd('\')
if (-not (Test-Path -LiteralPath (Join-Path $resolvedWorktree 'package.json') -PathType Leaf)) {
    throw "Appearance Studio worktree is unavailable: $resolvedWorktree"
}
$content = New-AshAtlasAppearanceStudioLauncherContent `
    -WorktreePath $resolvedWorktree `
    -Identity $Identity
$resolvedOutput = [IO.Path]::GetFullPath($OutputPath)
$outputDirectory = Split-Path -Parent $resolvedOutput
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$temporary = "$resolvedOutput.$PID.tmp"
try {
    Set-Content -LiteralPath $temporary -Value $content -Encoding ascii -NoNewline
    Move-Item -LiteralPath $temporary -Destination $resolvedOutput -Force
} finally {
    if (Test-Path -LiteralPath $temporary) {
        Remove-Item -LiteralPath $temporary -Force
    }
}
Write-Host "Appearance Studio launcher: $resolvedOutput"
