param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$ReleaseUrl
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Import-Module (Join-Path $PSScriptRoot 'update-installed-lib.psm1') -Force

if ($env:OS -ne 'Windows_NT') {
    throw 'Appearance Studio installed updates are supported only on Windows.'
}

$paths = Get-AshAtlasAppearanceStudioInstallPaths
if (-not (Test-Path -LiteralPath $paths.InstallRoot -PathType Container)) {
    throw "Appearance Studio install root does not exist: $($paths.InstallRoot)"
}
if (-not (Test-Path -LiteralPath $paths.UpdateExecutable -PathType Leaf)) {
    throw "Appearance Studio Update.exe is missing from the exact per-user install root: $($paths.UpdateExecutable)"
}
if (-not (Test-Path -LiteralPath $paths.PackagesDirectory -PathType Container)) {
    throw "Appearance Studio package directory is missing: $($paths.PackagesDirectory)"
}
$rootStub = Get-AshAtlasAppearanceStudioRootStub -InstallRoot $paths.InstallRoot
if ($null -eq $rootStub) {
    throw "Appearance Studio root stub is missing: $($paths.RootStub)"
}

function Get-InstalledAppearanceStudioProcesses {
    $allProcesses = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
    return @(Get-AshAtlasAppearanceStudioProcesses -Processes $allProcesses -InstallRoot $paths.InstallRoot)
}

$runningStudios = @(Get-InstalledAppearanceStudioProcesses)
foreach ($process in $runningStudios) {
    try {
        Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction Stop
    } catch {
        if ($_.FullyQualifiedErrorId -notmatch 'NoProcessFoundForGivenId') {
            throw
        }
    }
}

$stopDeadline = (Get-Date).AddSeconds(30)
while ($true) {
    $remainingStudios = @(Get-InstalledAppearanceStudioProcesses)
    if ($remainingStudios.Count -eq 0) { break }
    if ((Get-Date) -ge $stopDeadline) {
        $remainingIds = @($remainingStudios | ForEach-Object { [int]$_.ProcessId }) -join ', '
        throw "Appearance Studio processes did not stop before update cleanup (PIDs: $remainingIds)."
    }
    Start-Sleep -Milliseconds 100
}

$updateProcess = Start-Process `
    -FilePath $paths.UpdateExecutable `
    -ArgumentList @('--update', $ReleaseUrl) `
    -Wait `
    -PassThru `
    -WindowStyle Hidden
if ($null -eq $updateProcess -or [int]$updateProcess.ExitCode -ne 0) {
    $exitCode = if ($null -eq $updateProcess) { 'unknown' } else { [int]$updateProcess.ExitCode }
    throw "Appearance Studio Update.exe failed for '$ReleaseUrl' (exit code $exitCode)."
}

$newestApp = Get-AshAtlasNewestInstalledApp -InstallRoot $paths.InstallRoot
if ($null -eq $newestApp) {
    throw "Appearance Studio update completed, but no semantic app-* directory exists under $($paths.InstallRoot)."
}

$cleanupPlan = Get-AshAtlasAppearanceStudioUpdateCleanupPlan `
    -InstallRoot $paths.InstallRoot `
    -PackagesDirectory $paths.PackagesDirectory `
    -CurrentAppDirectory $newestApp.Directory `
    -CurrentVersion $newestApp.Version

$rootStub = Get-AshAtlasAppearanceStudioRootStub -InstallRoot $paths.InstallRoot
if ($null -eq $rootStub) {
    throw "Appearance Studio root stub is missing after update: $($paths.RootStub)"
}

$remainingStudios = @(Get-InstalledAppearanceStudioProcesses)
if ($remainingStudios.Count -ne 0) {
    $remainingIds = @($remainingStudios | ForEach-Object { [int]$_.ProcessId }) -join ', '
    throw "Appearance Studio is still running after Update.exe; refusing version cleanup (PIDs: $remainingIds)."
}

foreach ($directory in @($cleanupPlan.StaleAppDirectories)) {
    Remove-Item -LiteralPath $directory -Recurse -Force -ErrorAction Stop
}
foreach ($package in @($cleanupPlan.ConsumedDeltaPackages)) {
    Remove-Item -LiteralPath $package -Force -ErrorAction Stop
}

Start-Process `
    -FilePath $rootStub `
    -WorkingDirectory $paths.InstallRoot | Out-Null
Write-Host "Appearance Studio updated to $($cleanupPlan.CurrentVersion)."
