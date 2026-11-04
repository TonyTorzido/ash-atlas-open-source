Set-StrictMode -Version Latest

$script:AppearanceStudioInstallDirectoryName = 'AshAtlasAppearanceStudio'
$script:AppearanceStudioExecutableName = 'AshAtlasAppearanceStudio.exe'
$script:LegacyAppearanceStudioExecutableNames = @('Ash Atlas Appearance Studio.exe')
$script:AppDirectoryPattern = '^app-(?<version>\d+\.\d+\.\d+)$'
$script:FullPackagePattern = '^ashatlasappearancestudio-(?<version>\d+\.\d+\.\d+)-full\.nupkg$'
$script:ReconstructedPackagePattern = '^ashatlasappearancestudio-(?<version>\d+\.\d+\.\d+)\.nupkg$'
$script:DeltaPackagePattern = '^ashatlasappearancestudio-(?<version>\d+\.\d+\.\d+)-delta\.nupkg$'

function Get-AshAtlasAppearanceStudioInstallPaths {
    param(
        [string]$LocalAppData = $env:LOCALAPPDATA
    )

    if ([string]::IsNullOrWhiteSpace($LocalAppData)) {
        throw 'LOCALAPPDATA is not set; cannot resolve the per-user Appearance Studio install root.'
    }
    $resolvedLocalAppData = [IO.Path]::GetFullPath($LocalAppData).TrimEnd('\', '/')
    $installRoot = [IO.Path]::GetFullPath((Join-Path $resolvedLocalAppData $script:AppearanceStudioInstallDirectoryName)).TrimEnd('\', '/')
    return [pscustomobject]@{
        InstallRoot = $installRoot
        UpdateExecutable = Join-Path $installRoot 'Update.exe'
        PackagesDirectory = Join-Path $installRoot 'packages'
        RootStub = Join-Path $installRoot $script:AppearanceStudioExecutableName
    }
}

function Get-AshAtlasAppearanceStudioRootStub {
    param(
        [Parameter(Mandatory = $true)][string]$InstallRoot
    )

    $candidates = @(
        (Join-Path $InstallRoot $script:AppearanceStudioExecutableName)
        foreach ($legacyName in $script:LegacyAppearanceStudioExecutableNames) {
            Join-Path $InstallRoot $legacyName
        }
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return $candidate
        }
    }
    return $null
}

function Test-AshAtlasPathUnderRoot {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root
    )

    try {
        $resolvedPath = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
        $resolvedRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    } catch {
        return $false
    }
    if ($resolvedPath.Length -le $resolvedRoot.Length) { return $false }
    $rootPrefix = $resolvedRoot + [IO.Path]::DirectorySeparatorChar
    return $resolvedPath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)
}

function Get-AshAtlasAppearanceStudioProcesses {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Processes,
        [Parameter(Mandatory = $true)][string]$InstallRoot
    )

    foreach ($process in $Processes) {
        $executablePath = [string]$process.ExecutablePath
        if ([string]::IsNullOrWhiteSpace($executablePath)) { continue }
        $executableName = [IO.Path]::GetFileName($executablePath)
        if ($executableName -ine $script:AppearanceStudioExecutableName -and
            $script:LegacyAppearanceStudioExecutableNames -notcontains $executableName) {
            continue
        }
        if (Test-AshAtlasPathUnderRoot -Path $executablePath -Root $InstallRoot) {
            $process
        }
    }
}

function Get-AshAtlasNewestInstalledApp {
    param(
        [Parameter(Mandatory = $true)][string]$InstallRoot
    )

    $candidates = @(
        foreach ($entry in @(Get-ChildItem -LiteralPath $InstallRoot -Directory -Force -ErrorAction Stop)) {
            $match = [regex]::Match($entry.Name, $script:AppDirectoryPattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)
            if (-not $match.Success) { continue }
            $versionText = $match.Groups['version'].Value
            try {
                $version = [Version]::Parse($versionText)
            } catch {
                continue
            }
            [pscustomobject]@{
                Directory = $entry.FullName
                Name = $entry.Name
                Version = $versionText
                VersionObject = $version
            }
        }
    )
    if ($candidates.Count -eq 0) { return $null }
    return ($candidates | Sort-Object -Property VersionObject -Descending | Select-Object -First 1)
}

function Get-AshAtlasAppearanceStudioFullPackage {
    param(
        [Parameter(Mandatory = $true)][string]$PackagesDirectory,
        [Parameter(Mandatory = $true)][string]$Version
    )

    $expectedNames = @(
        "ashatlasappearancestudio-$Version-full.nupkg"
        "ashatlasappearancestudio-$Version.nupkg"
    )
    foreach ($entry in @(Get-ChildItem -LiteralPath $PackagesDirectory -File -Force -ErrorAction Stop)) {
        $match = [regex]::Match($entry.Name, $script:FullPackagePattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)
        if (-not $match.Success) {
            $match = [regex]::Match($entry.Name, $script:ReconstructedPackagePattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)
        }
        if ($match.Success -and [string]::Equals($match.Groups['version'].Value, $Version, [StringComparison]::OrdinalIgnoreCase) -and
            $expectedNames -contains $entry.Name.ToLowerInvariant()) {
            return $entry.FullName
        }
    }
    return $null
}

function Get-AshAtlasAppearanceStudioUpdateCleanupPlan {
    param(
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [Parameter(Mandatory = $true)][string]$PackagesDirectory,
        [Parameter(Mandatory = $true)][string]$CurrentAppDirectory,
        [Parameter(Mandatory = $true)][string]$CurrentVersion
    )

    $fullPackage = Get-AshAtlasAppearanceStudioFullPackage `
        -PackagesDirectory $PackagesDirectory `
        -Version $CurrentVersion
    if ($null -eq $fullPackage) {
        throw "Installed Appearance Studio version $CurrentVersion has no matching full nupkg in $PackagesDirectory."
    }

    $resolvedCurrentAppDirectory = [IO.Path]::GetFullPath($CurrentAppDirectory).TrimEnd('\', '/')
    $staleAppDirectories = @(
        foreach ($entry in @(Get-ChildItem -LiteralPath $InstallRoot -Directory -Force -ErrorAction Stop)) {
            $match = [regex]::Match($entry.Name, $script:AppDirectoryPattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)
            if ($match.Success -and
                -not [string]::Equals(
                    ([IO.Path]::GetFullPath($entry.FullName).TrimEnd('\', '/')),
                    $resolvedCurrentAppDirectory,
                    [StringComparison]::OrdinalIgnoreCase
                )) {
                $entry.FullName
            }
        }
    )
    $consumedDeltaPackages = @(
        foreach ($entry in @(Get-ChildItem -LiteralPath $PackagesDirectory -File -Force -ErrorAction Stop)) {
            $match = [regex]::Match($entry.Name, $script:DeltaPackagePattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)
            if ($match.Success) { $entry.FullName }
        }
    )
    return [pscustomobject]@{
        CurrentAppDirectory = $resolvedCurrentAppDirectory
        CurrentVersion = $CurrentVersion
        FullPackage = $fullPackage
        StaleAppDirectories = $staleAppDirectories
        ConsumedDeltaPackages = $consumedDeltaPackages
    }
}

Export-ModuleMember -Function @(
    'Get-AshAtlasAppearanceStudioInstallPaths',
    'Get-AshAtlasAppearanceStudioRootStub',
    'Test-AshAtlasPathUnderRoot',
    'Get-AshAtlasAppearanceStudioProcesses',
    'Get-AshAtlasNewestInstalledApp',
    'Get-AshAtlasAppearanceStudioFullPackage',
    'Get-AshAtlasAppearanceStudioUpdateCleanupPlan'
)
