$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Import-Module (Join-Path $PSScriptRoot 'update-installed-lib.psm1') -Force
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

function Assert-Throws([scriptblock]$Action, [string]$Pattern, [string]$Message) {
    $threw = $false
    try {
        & $Action | Out-Null
    } catch {
        $threw = $true
        if ($_.Exception.Message -notmatch $Pattern) {
            throw "ASSERTION FAILED: $Message threw '$($_.Exception.Message)'."
        }
    }
    if (-not $threw) { throw "ASSERTION FAILED: $Message did not throw." }
    $script:Passed++
}

$testRoot = Join-Path ([IO.Path]::GetTempPath()) "ash-atlas-studio-update-$([Guid]::NewGuid().ToString('N'))"
$localAppData = Join-Path $testRoot 'LocalAppData'
$paths = Get-AshAtlasAppearanceStudioInstallPaths -LocalAppData $localAppData
$oldApp = Join-Path $paths.InstallRoot 'app-1.39.0'
$baselineApp = Join-Path $paths.InstallRoot 'app-1.40.0'
$currentApp = Join-Path $paths.InstallRoot 'app-1.40.3'
$nonVersionDirectory = Join-Path $paths.InstallRoot 'app-1.40.3-backup'
$oldFull = Join-Path $paths.PackagesDirectory 'ashatlasappearancestudio-1.40.0-full.nupkg'
$currentFull = Join-Path $paths.PackagesDirectory 'AshAtlasAppearanceStudio-1.40.3-full.nupkg'
$currentReconstructed = Join-Path $paths.PackagesDirectory 'AshAtlasAppearanceStudio-1.40.3.nupkg'
$oldDelta = Join-Path $paths.PackagesDirectory 'ashatlasappearancestudio-1.40.0-delta.nupkg'
$currentDelta = Join-Path $paths.PackagesDirectory 'AshAtlasAppearanceStudio-1.40.3-delta.nupkg'
$unrelatedPackage = Join-Path $paths.PackagesDirectory 'notes.txt'

try {
    New-Item -ItemType Directory -Path $currentApp, $baselineApp, $oldApp, $nonVersionDirectory, $paths.PackagesDirectory -Force | Out-Null
    New-Item -ItemType File -Path $paths.UpdateExecutable, $paths.RootStub, $oldFull, $currentFull, $oldDelta, $currentDelta, $unrelatedPackage -Force | Out-Null

    Assert-Equal (Get-AshAtlasAppearanceStudioRootStub -InstallRoot $paths.InstallRoot) $paths.RootStub `
        'new root stub is preferred when present'
    Remove-Item -LiteralPath $paths.RootStub -Force
    $legacyRootStub = Join-Path $paths.InstallRoot 'Ash Atlas Appearance Studio.exe'
    New-Item -ItemType File -Path $legacyRootStub -Force | Out-Null
    Assert-Equal (Get-AshAtlasAppearanceStudioRootStub -InstallRoot $paths.InstallRoot) $legacyRootStub `
        'legacy spaced root stub is accepted when the new stub is absent'
    Remove-Item -LiteralPath $legacyRootStub -Force
    Assert-Equal (Get-AshAtlasAppearanceStudioRootStub -InstallRoot $paths.InstallRoot) $null `
        'missing root stubs are rejected'
    New-Item -ItemType File -Path $paths.RootStub -Force | Out-Null

    Assert-True ($paths.InstallRoot -eq [IO.Path]::GetFullPath((Join-Path $localAppData 'AshAtlasAppearanceStudio'))) `
        'install root is exactly LOCALAPPDATA\AshAtlasAppearanceStudio'
    Assert-True (Test-AshAtlasPathUnderRoot -Path (Join-Path $currentApp 'resources\app.asar') -Root $paths.InstallRoot) `
        'a versioned application file is under the install root'
    Assert-True (-not (Test-AshAtlasPathUnderRoot -Path (Join-Path $testRoot 'AshAtlasAppearanceStudio-old\x.exe') -Root $paths.InstallRoot)) `
        'a similarly named sibling is outside the install root'
    Assert-True (-not (Test-AshAtlasPathUnderRoot -Path $paths.InstallRoot -Root $paths.InstallRoot)) `
        'the install root itself is not treated as a process executable path'

    $newest = Get-AshAtlasNewestInstalledApp -InstallRoot $paths.InstallRoot
    Assert-Equal $newest.Version '1.40.3' 'newest app directory is selected by semantic version'
    Assert-Equal $newest.Directory $currentApp 'newest app directory path is retained'
    Assert-Equal (Get-AshAtlasAppearanceStudioFullPackage -PackagesDirectory $paths.PackagesDirectory -Version '1.40.3') $currentFull `
        'matching full package is found case-insensitively'

    $plan = Get-AshAtlasAppearanceStudioUpdateCleanupPlan `
        -InstallRoot $paths.InstallRoot `
        -PackagesDirectory $paths.PackagesDirectory `
        -CurrentAppDirectory $newest.Directory `
        -CurrentVersion $newest.Version
    Assert-Equal (@($plan.StaleAppDirectories | Sort-Object) -join ';') (@($oldApp, $baselineApp | Sort-Object) -join ';') `
        'cleanup plan contains only other semantic app directories'
    Assert-Equal (@($plan.ConsumedDeltaPackages | Sort-Object) -join ';') (@($oldDelta, $currentDelta | Sort-Object) -join ';') `
        'cleanup plan contains only consumed delta packages'
    Assert-Equal $plan.FullPackage $currentFull 'cleanup plan requires and retains the newest full package'

    Remove-Item -LiteralPath $currentFull -Force
    New-Item -ItemType File -Path $currentReconstructed -Force | Out-Null
    Assert-Equal (Get-AshAtlasAppearanceStudioFullPackage -PackagesDirectory $paths.PackagesDirectory -Version '1.40.3') $currentReconstructed `
        'Squirrel reconstructed package is accepted as the current package'
    $reconstructedPlan = Get-AshAtlasAppearanceStudioUpdateCleanupPlan `
        -InstallRoot $paths.InstallRoot `
        -PackagesDirectory $paths.PackagesDirectory `
        -CurrentAppDirectory $currentApp `
        -CurrentVersion '1.40.3'
    Assert-Equal $reconstructedPlan.FullPackage $currentReconstructed `
        'cleanup plan accepts the Squirrel reconstructed current package'

    $processes = @(
        [pscustomobject]@{ ProcessId = 101; ExecutablePath = Join-Path $currentApp 'AshAtlasAppearanceStudio.exe' }
        [pscustomobject]@{ ProcessId = 102; ExecutablePath = $paths.RootStub }
        [pscustomobject]@{ ProcessId = 103; ExecutablePath = Join-Path $paths.InstallRoot 'Update.exe' }
        [pscustomobject]@{ ProcessId = 104; ExecutablePath = Join-Path $testRoot 'AshAtlasAppearanceStudio-old\Ash Atlas Appearance Studio.exe' }
        [pscustomobject]@{ ProcessId = 105; ExecutablePath = Join-Path $testRoot 'other\Ash Atlas Appearance Studio.exe' }
        [pscustomobject]@{ ProcessId = 106; ExecutablePath = $null }
        [pscustomobject]@{ ProcessId = 107; ExecutablePath = Join-Path $currentApp 'Ash Atlas Appearance Studio.exe' }
    )
    $managed = @(Get-AshAtlasAppearanceStudioProcesses -Processes $processes -InstallRoot $paths.InstallRoot)
    Assert-Equal $managed.Count 3 'only Studio executables under the exact root are selected'
    Assert-True (@($managed.ProcessId) -contains 101 -and @($managed.ProcessId) -contains 102 -and
        @($managed.ProcessId) -contains 107) `
        'versioned, root-stub, and legacy Studio processes are selected'
    Assert-True (@($managed.ProcessId) -notcontains 103 -and @($managed.ProcessId) -notcontains 104 -and @($managed.ProcessId) -notcontains 105) `
        'Update.exe and outside-root processes are never selected'

    Remove-Item -LiteralPath $plan.StaleAppDirectories -Recurse -Force
    Remove-Item -LiteralPath $plan.ConsumedDeltaPackages -Force
    Assert-True (Test-Path -LiteralPath $currentApp -PathType Container) 'current app directory remains'
    Assert-True (Test-Path -LiteralPath $nonVersionDirectory -PathType Container) 'non-version directory remains'
    Assert-True (Test-Path -LiteralPath $oldFull -PathType Leaf) 'old full package remains outside the cleanup scope'
    Assert-True (Test-Path -LiteralPath $currentReconstructed -PathType Leaf) 'newest reconstructed package remains'
    Assert-True (-not (Test-Path -LiteralPath $oldApp)) 'old app directory is removed'
    Assert-True (-not (Test-Path -LiteralPath $currentDelta)) 'consumed current delta is removed'
    Assert-True (Test-Path -LiteralPath $unrelatedPackage -PathType Leaf) 'unrelated package file remains'

    Remove-Item -LiteralPath $currentReconstructed -Force
    Assert-Throws {
        Get-AshAtlasAppearanceStudioUpdateCleanupPlan `
            -InstallRoot $paths.InstallRoot `
            -PackagesDirectory $paths.PackagesDirectory `
            -CurrentAppDirectory $currentApp `
            -CurrentVersion '1.40.3'
    } 'no matching full nupkg' 'cleanup refuses to run without the newest full package'

    $workflow = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'update-installed.ps1')
    Assert-True ($workflow -match '--update' -and $workflow -match 'WindowStyle Hidden' -and
        $workflow -match 'Update\.exe' -and $workflow -match 'Stop-Process' -and
        $workflow -match 'FullyQualifiedErrorId' -and $workflow -match 'NoProcessFoundForGivenId' -and
        $workflow -match '(?s)-FilePath \$rootStub .*?-WorkingDirectory \$paths\.InstallRoot\s*\| Out-Null' -and
        $workflow -notmatch '(?s)-FilePath \$rootStub .*?-WindowStyle Hidden') `
        'canonical wrapper hides the updater, relaunches Studio visibly, and stops owned Studio processes'
} finally {
    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}

Write-Host "Appearance Studio installed update tests passed: $script:Passed"
