$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'port-policy.ps1')

function Assert-Equal($Actual, $Expected, [string]$Label) {
    if ($Actual -ne $Expected) { throw "$Label failed: expected $Expected, found $Actual" }
}

function Assert-Throws([scriptblock]$Action, [string]$Pattern, [string]$Label) {
    try { & $Action; throw "$Label failed: expected an exception" }
    catch {
        if ($_.Exception.Message -notlike "*$Pattern*") {
            throw "$Label failed: '$($_.Exception.Message)' did not contain '$Pattern'"
        }
    }
}

Assert-Equal (Resolve-StabilityDatabasePort -Override $null -ExcludedRanges @()) 55439 'default port'
Assert-Equal (Resolve-StabilityDatabasePort -Override '55839' -ExcludedRanges @()) 55839 'environment override'
Assert-Throws { Resolve-StabilityDatabasePort -Override 'not-a-port' -ExcludedRanges @() } 'must be an integer' 'invalid override'
Assert-Throws { Resolve-StabilityDatabasePort -Override '35432' -ExcludedRanges @() } 'protected' 'forbidden port'
Assert-Throws {
    Resolve-StabilityDatabasePort -Override '55839' -ExcludedRanges @([pscustomobject]@{ Start = 55800; End = 55900 })
} 'excluded TCP range' 'reserved range'

$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
try {
    $occupiedPort = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
    Assert-Throws { Assert-StabilityPortUnoccupied $occupiedPort } 'already occupied' 'occupied port'
} finally {
    $listener.Stop()
}

$lab = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'stability-lab.ps1')
if ($lab -notmatch "ASH_ATLAS_STABILITY_DATABASE_PORT" -or $lab -notmatch "stability-lab.local.psd1") {
    throw 'configuration precedence failed: environment and ignored local configuration must be supported'
}
if ($lab.IndexOf('Resolve-StabilityDatabasePort') -gt $lab.IndexOf('function Start-Database')) {
    throw 'preflight ordering failed: port resolution must precede Start-Database'
}
$databaseFunction = $lab.Substring($lab.IndexOf('function Start-Database'), $lab.IndexOf('function Remove-Database') - $lab.IndexOf('function Start-Database'))
if ($databaseFunction.IndexOf('Assert-StabilityPortUnoccupied') -gt $databaseFunction.IndexOf('& docker run')) {
    throw 'preflight ordering failed: occupancy check must precede docker run'
}

Write-Output 'Stability database port policy: 7/7 checks passed.'
