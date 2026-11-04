Set-StrictMode -Version Latest

function Get-AshAtlasCanonicalPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$BasePath = [string](Get-Location).Path
    )

    if ([string]::IsNullOrWhiteSpace($Path)) { throw 'Path must not be empty.' }
    if ([string]::IsNullOrWhiteSpace($BasePath)) { throw 'BasePath must not be empty.' }
    try {
        $separator = [IO.Path]::DirectorySeparatorChar
        $normalized = $Path.Replace([char]'/', $separator).Replace([char]'\', $separator)
        if (-not [IO.Path]::IsPathRooted($normalized)) {
            $normalizedBase = $BasePath.Replace([char]'/', $separator).Replace([char]'\', $separator)
            $normalized = Join-Path ([IO.Path]::GetFullPath($normalizedBase)) $normalized
        }
        $fullPath = [IO.Path]::GetFullPath($normalized)
        $root = [IO.Path]::GetPathRoot($fullPath)
        if ($fullPath.Length -gt $root.Length) {
            $fullPath = $fullPath.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
        }
        return $fullPath
    } catch {
        throw "Invalid path '$Path': $($_.Exception.Message)"
    }
}

function Test-AshAtlasSamePath {
    param(
        [Parameter(Mandatory = $true)][string]$Left,
        [Parameter(Mandatory = $true)][string]$Right,
        [string]$BasePath = [string](Get-Location).Path
    )

    $comparison = if ([Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
            [Runtime.InteropServices.OSPlatform]::Windows)) {
        [StringComparison]::OrdinalIgnoreCase
    } else {
        [StringComparison]::Ordinal
    }
    $canonicalLeft = Get-AshAtlasCanonicalPath $Left $BasePath
    $canonicalRight = Get-AshAtlasCanonicalPath $Right $BasePath
    return [string]::Equals($canonicalLeft, $canonicalRight, $comparison)
}
