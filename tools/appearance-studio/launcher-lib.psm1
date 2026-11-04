Set-StrictMode -Version Latest

$script:OfficialPort = 5285
$script:FeaturePortBase = 25285
$script:FeaturePortCount = 20000

function Get-AshAtlasAppearanceStudioPort {
    param(
        [Parameter(Mandatory = $true)][string]$Identity,
        [switch]$OfficialCheckout
    )

    if ($OfficialCheckout) { return $script:OfficialPort }
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = $sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($Identity))
    } finally {
        $sha256.Dispose()
    }
    $value = ([uint64]$bytes[0] * 16777216) +
        ([uint64]$bytes[1] * 65536) +
        ([uint64]$bytes[2] * 256) +
        [uint64]$bytes[3]
    return $script:FeaturePortBase + [int]($value % $script:FeaturePortCount)
}

function New-AshAtlasAppearanceStudioLauncherContent {
    param(
        [Parameter(Mandatory = $true)][string]$WorktreePath,
        [Parameter(Mandatory = $true)][string]$Identity
    )

    $resolvedWorktree = [IO.Path]::GetFullPath($WorktreePath).TrimEnd('\')
    $port = Get-AshAtlasAppearanceStudioPort -Identity $Identity
    return (@(
        '@echo off',
        'setlocal EnableExtensions',
        'rem Ash Atlas generated Appearance Studio launcher',
        "rem Studio identity: $Identity",
        "set `"STUDIO_ROOT=$resolvedWorktree`"",
        "set `"APPEARANCE_STUDIO_IDENTITY=$Identity`"",
        "set `"APPEARANCE_STUDIO_EXPECTED_PORT=$port`"",
        'for /f "usebackq delims=" %%V in (`git -C "%STUDIO_ROOT%" rev-parse --abbrev-ref HEAD`) do set "APPEARANCE_STUDIO_EXPECTED_BRANCH=%%V"',
        'for /f "usebackq delims=" %%V in (`git -C "%STUDIO_ROOT%" rev-parse HEAD`) do set "APPEARANCE_STUDIO_EXPECTED_COMMIT=%%V"',
        'set "APPEARANCE_STUDIO_EXPECTED_WORKTREE=%STUDIO_ROOT%"',
        'call "%STUDIO_ROOT%\tools\appearance-studio\Run Appearance Studio.cmd"',
        'exit /b %ERRORLEVEL%'
    ) -join "`r`n") + "`r`n"
}

Export-ModuleMember -Function @(
    'Get-AshAtlasAppearanceStudioPort',
    'New-AshAtlasAppearanceStudioLauncherContent'
)
