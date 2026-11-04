function Get-StabilityExcludedTcpRanges {
    if (-not (Get-Command netsh.exe -ErrorAction SilentlyContinue)) { return @() }
    $lines = @(& netsh.exe interface ipv4 show excludedportrange protocol=tcp 2>$null)
    $ranges = foreach ($line in $lines) {
        if ($line -match '^\s*(\d+)\s+(\d+)\s*$') {
            [pscustomobject]@{ Start = [int]$Matches[1]; End = [int]$Matches[2] }
        }
    }
    return @($ranges)
}

function Resolve-StabilityDatabasePort {
    param(
        [AllowNull()][AllowEmptyString()][string]$Override,
        [int]$DefaultPort = 55439,
        [int[]]$ForbiddenPorts = @(5270, 3000, 8765, 35432),
        [AllowNull()][object[]]$ExcludedRanges
    )

    $raw = if ([string]::IsNullOrWhiteSpace($Override)) { [string]$DefaultPort } else { $Override.Trim() }
    $port = 0
    if (-not [int]::TryParse($raw, [ref]$port)) {
        throw "REFUSED: ASH_ATLAS_STABILITY_DATABASE_PORT must be an integer; found '$raw'."
    }
    if ($port -lt 1 -or $port -gt 65535) {
        throw "REFUSED: ASH_ATLAS_STABILITY_DATABASE_PORT must be between 1 and 65535; found $port."
    }
    if ($ForbiddenPorts -contains $port) {
        throw "REFUSED: stability PostgreSQL port $port is protected."
    }

    $ranges = if ($PSBoundParameters.ContainsKey('ExcludedRanges')) { @($ExcludedRanges) } else { @(Get-StabilityExcludedTcpRanges) }
    foreach ($range in $ranges) {
        if ($port -ge [int]$range.Start -and $port -le [int]$range.End) {
            throw "REFUSED: stability PostgreSQL port $port is inside the Windows excluded TCP range $($range.Start)-$($range.End). Set ASH_ATLAS_STABILITY_DATABASE_PORT to an available port such as 55839."
        }
    }
    return $port
}

function Assert-StabilityPortUnoccupied {
    param([int]$Port)
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
    if ($listeners.Count -eq 0) { return }
    $owners = @($listeners | ForEach-Object { "PID $($_.OwningProcess)" }) | Select-Object -Unique
    throw "REFUSED: stability PostgreSQL port $Port is already occupied ($($owners -join ', ')). The lab will not stop or reuse that owner."
}
