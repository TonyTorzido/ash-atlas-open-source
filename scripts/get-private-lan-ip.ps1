[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$excludedAdapters = 'Loopback|Docker|WSL|Hyper-V|vEthernet|VPN|Tailscale|ZeroTier|Virtual|VMware|VirtualBox|Bluetooth|Npcap|TAP|Tunnel'

function Test-PrivateLanIPv4 {
    param([string]$Address)
    $parts = $Address -split '\.'
    if ($parts.Count -ne 4 -or @($parts | Where-Object { $_ -notmatch '^\d{1,3}$' }).Count -gt 0) {
        return $false
    }
    $octets = @($parts | ForEach-Object { [int]$_ })
    if (@($octets | Where-Object { $_ -gt 255 }).Count -gt 0) { return $false }
    return ($octets[0] -eq 10) -or
        ($octets[0] -eq 172 -and $octets[1] -ge 16 -and $octets[1] -le 31) -or
        ($octets[0] -eq 192 -and $octets[1] -eq 168)
}

$candidates = foreach ($configuration in @(Get-NetIPConfiguration -ErrorAction SilentlyContinue)) {
    if (-not $configuration.NetAdapter -or $configuration.NetAdapter.Status -ne 'Up') { continue }
    $adapterLabel = "$($configuration.InterfaceAlias) $($configuration.InterfaceDescription)"
    if ($adapterLabel -match $excludedAdapters) { continue }
    $interfaceMetric = [int](
        Get-NetIPInterface -InterfaceIndex $configuration.InterfaceIndex -AddressFamily IPv4 `
            -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty InterfaceMetric
    )
    foreach ($address in @($configuration.IPv4Address)) {
        if (-not (Test-PrivateLanIPv4 $address.IPAddress)) { continue }
        [pscustomobject]@{
            IPAddress = $address.IPAddress
            InterfaceAlias = $configuration.InterfaceAlias
            InterfaceMetric = $interfaceMetric
            HasDefaultGateway = @($configuration.IPv4DefaultGateway).Count -gt 0
        }
    }
}

$candidates | Sort-Object `
    @{ Expression = { if ($_.HasDefaultGateway) { 0 } else { 1 } } }, `
    InterfaceMetric, InterfaceAlias, IPAddress | Select-Object -ExpandProperty IPAddress -Unique
