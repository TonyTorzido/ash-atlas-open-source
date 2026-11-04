[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$WorldSha,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedCurrentWorldSha,
    [Parameter(Mandatory = $true)][ValidatePattern('^(origin/master|refs/remotes/origin/master)$')][string]$ExpectedCurrentWorldLockRef,
    [switch]$ConfirmPromotion,
    [string]$WorldRepository,
    [string]$SshHost,
    [string]$SshKey,
    [string]$KnownHostsFile,
    [ValidateRange(45, 1800)][int]$CandidateReadinessSeconds = 45,
    [string]$WaterNameIndexRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'deployment-transport.ps1')
if (-not $SshHost) { $SshHost = $script:AshAtlasProductionSshHost }
$worldSupplementalStagingRoot = '/home/debian/ash-atlas-world-promotion-staging'

function Assert-WorldLockExactValue {
    param(
        [Parameter(Mandatory = $true)]$Object,
        [Parameter(Mandatory = $true)][string]$Property,
        [Parameter(Mandatory = $true)][string]$Expected,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $entry = $Object.PSObject.Properties[$Property]
    if ($null -eq $entry -or [string]$entry.Value -cne $Expected) {
        $actual = if ($null -eq $entry) { '<missing>' } else { [string]$entry.Value }
        throw "World runtime lock $Label is '$actual', expected '$Expected'."
    }
}

function Assert-WorldLocalImmutableRoot {
    param([Parameter(Mandatory = $true)][string]$Root, [Parameter(Mandatory = $true)][string]$Label)

    $item = Get-Item -LiteralPath $Root -Force -ErrorAction Stop
    if (-not $item.PSIsContainer -or ([IO.FileAttributes]$item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Local $Label root is absent, not a directory, or is a reparse point: $Root"
    }
    $links = @(Get-ChildItem -LiteralPath $Root -Recurse -Force -ErrorAction Stop | Where-Object {
        ([IO.FileAttributes]$_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
    })
    if ($links.Count -gt 0) { throw "Local $Label root contains a symlink or reparse point: $($links[0].FullName)" }
}

function Assert-WorldLocalFiles {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)]$ExpectedFiles,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $actual = @{}
    foreach ($file in @(Get-ChildItem -LiteralPath $Root -Recurse -File -Force -ErrorAction Stop)) {
        if (([IO.FileAttributes]$file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Local $Label file is a reparse point: $($file.FullName)"
        }
        $relative = [IO.Path]::GetRelativePath($Root, $file.FullName).Replace('\', '/')
        $actual[$relative] = $file
    }
    $expectedNames = @($ExpectedFiles.Keys)
    $actualNames = @($actual.Keys)
    if ($actualNames.Count -ne $expectedNames.Count -or
        @($actualNames | Where-Object { -not $ExpectedFiles.ContainsKey($_) }).Count -gt 0 -or
        @($expectedNames | Where-Object { -not $actual.ContainsKey($_) }).Count -gt 0) {
        throw "Local $Label file inventory differs from its pinned manifest."
    }
    foreach ($entry in $ExpectedFiles.GetEnumerator()) {
        $file = $actual[$entry.Key]
        $expectedSize = [int64]$entry.Value.size_bytes
        if ([int64]$file.Length -ne $expectedSize) {
            throw "Local $Label artifact size differs for $($entry.Key)."
        }
        $actualHash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualHash -cne [string]$entry.Value.sha256) {
            throw "Local $Label artifact hash differs for $($entry.Key)."
        }
    }
}

function Assert-WorldLocalRiverbankRoot {
    param([Parameter(Mandatory = $true)][string]$Root, [Parameter(Mandatory = $true)]$Authority)

    Assert-WorldLocalImmutableRoot $Root 'riverbank/lakeshore'
    $manifestPath = Join-Path $Root 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw 'Local riverbank/lakeshore manifest is absent.'
    }
    $manifestHash = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($manifestHash -cne [string]$Authority.manifest_sha256) {
        throw 'Local riverbank/lakeshore manifest hash differs from the lock.'
    }
    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    foreach ($field in @('release_id', 'schema', 'policy', 'pipeline_sha', 'contract_fingerprint', 'grid_fingerprint', 'deterministic_fingerprint')) {
        Assert-WorldLockExactValue $manifest $field ([string]$Authority.$field) "local riverbank/lakeshore manifest $field"
    }
    foreach ($field in @('distance_m', 'cell_size_m', 'package_count', 'selected_package_count', 'positive_package_count', 'empty_package_count', 'span_count', 'membership_cell_count')) {
        Assert-WorldLockExactValue $manifest $field ([string]$Authority.$field) "local riverbank/lakeshore manifest $field"
    }
    $inventory = $manifest.PSObject.Properties['inventory']
    if ($null -eq $inventory) { throw 'Local riverbank/lakeshore manifest inventory is missing.' }
    foreach ($field in @('inventory_sha256', 'source_package_fingerprint', 'selected_package_fingerprint', 'source_package_count')) {
        Assert-WorldLockExactValue $inventory.Value $field ([string]$Authority.$field) "local riverbank/lakeshore manifest inventory.$field"
    }
    foreach ($sourceClass in @('river', 'lake', 'world')) {
        $expectedSource = $Authority.source.PSObject.Properties[$sourceClass]
        $actualSource = $manifest.source.PSObject.Properties[$sourceClass]
        if ($null -eq $expectedSource -or $null -eq $actualSource) { throw "Local riverbank/lakeshore source.$sourceClass is missing." }
        foreach ($field in @('release_id', 'manifest_sha256', 'policy')) {
            $expectedValue = $expectedSource.Value.PSObject.Properties[$field]
            if ($null -eq $expectedValue) { continue }
            Assert-WorldLockExactValue $actualSource.Value $field ([string]$expectedValue.Value) "local riverbank/lakeshore manifest source.$sourceClass.$field"
        }
    }
    $expected = @{}
    foreach ($record in @($manifest.packages)) {
        foreach ($artifactKind in @('artifact', 'manifest')) {
            $artifactProperty = $record.PSObject.Properties[$artifactKind]
            if ($null -eq $artifactProperty) { throw "Local riverbank/lakeshore package $($record.package_id) is missing its $artifactKind." }
            $artifact = $artifactProperty.Value
            $path = [string]$artifact.path
            if (-not $path -or $path.StartsWith('/') -or $path.Contains('..')) { throw 'Local riverbank/lakeshore manifest contains an unsafe artifact path.' }
            $expected[$path] = [pscustomobject]@{
                sha256 = ([string]$artifact.sha256).ToLowerInvariant()
                size_bytes = [int64]$artifact.size_bytes
            }
        }
    }
    $expected['manifest.json'] = [pscustomobject]@{
        sha256 = $manifestHash
        size_bytes = [int64](Get-Item -LiteralPath $manifestPath).Length
    }
    Assert-WorldLocalFiles $Root $expected 'riverbank/lakeshore'
}

function Assert-WorldLocalWaterNameIndexRoot {
    param([Parameter(Mandatory = $true)][string]$Root, [Parameter(Mandatory = $true)]$Authority)

    Assert-WorldLocalImmutableRoot $Root 'water-name index'
    $manifestPath = Join-Path $Root 'manifest.json'
    $entriesPath = Join-Path $Root ([string]$Authority.entries_filename)
    foreach ($path in @($manifestPath, $entriesPath)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Local water-name index file is absent: $path" }
    }
    $manifestHash = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($manifestHash -cne [string]$Authority.manifest_sha256) { throw 'Local water-name index manifest hash differs from the lock.' }
    $entriesHash = (Get-FileHash -LiteralPath $entriesPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($entriesHash -cne [string]$Authority.entries_sha256) { throw 'Local water-name index artifact hash differs from the lock.' }
    if ([int64](Get-Item -LiteralPath $entriesPath).Length -ne [int64]$Authority.entries_size_bytes) {
        throw 'Local water-name index artifact size differs from the lock.'
    }
    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    foreach ($field in @('release_id', 'schema', 'policy', 'entries_filename', 'entries_format', 'entries_sha256', 'index_hash', 'deterministic_fingerprint', 'entry_count')) {
        Assert-WorldLockExactValue $manifest $field ([string]$Authority.$field) "local water-name index manifest $field"
    }
    $expectedClasses = $Authority.classes
    foreach ($className in @('river', 'lake', 'ocean')) {
        Assert-WorldLockExactValue $manifest.classes $className ([string]$expectedClasses.$className) "local water-name index manifest classes.$className"
    }
    $expectedMaxDistance = $Authority.max_distance_m
    foreach ($className in @('river', 'lake', 'ocean')) {
        Assert-WorldLockExactValue $manifest.max_distance_m $className ([string]$expectedMaxDistance.$className) "local water-name index manifest max_distance_m.$className"
    }
    $expected = @{
        'manifest.json' = [pscustomobject]@{ sha256 = $manifestHash; size_bytes = [int64](Get-Item -LiteralPath $manifestPath).Length }
        ([string]$Authority.entries_filename) = [pscustomobject]@{ sha256 = $entriesHash; size_bytes = [int64]$Authority.entries_size_bytes }
    }
    Assert-WorldLocalFiles $Root $expected 'water-name index'
}

function Invoke-WorldSupplementalTransfer {
    param(
        [Parameter(Mandatory = $true)]$Transport,
        [Parameter(Mandatory = $true)][string]$SourceRoot,
        [Parameter(Mandatory = $true)][string]$RemoteRoot,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $tar = Get-Command 'tar.exe' -ErrorAction Stop
    $sourceParent = [IO.Path]::GetDirectoryName($SourceRoot)
    $sourceLeaf = [IO.Path]::GetFileName($SourceRoot)
    if (-not $sourceParent -or $sourceLeaf -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
        throw "World $Label source root is not archive-safe: $SourceRoot"
    }
    $archivePath = Join-Path ([IO.Path]::GetTempPath()) (
        'ash-atlas-world-promotion-' + [guid]::NewGuid().ToString('n') + '.tar'
    )
    try {
        $archiveResult = Invoke-BoundedNativeProcess -FilePath $tar.Source -Arguments @(
            '-cf', $archivePath,
            '-C', $sourceParent,
            $sourceLeaf
        ) -TimeoutMilliseconds 3600000
        if (-not $archiveResult.start_succeeded -or $archiveResult.timed_out -or
            $archiveResult.exit_code -ne 0 -or -not (Test-Path -LiteralPath $archivePath -PathType Leaf)) {
            throw "World $Label archive creation failed ($($archiveResult.exit_code)): $($archiveResult.stderr)"
        }
        $archiveFile = Get-Item -LiteralPath $archivePath -Force -ErrorAction Stop
        $archiveHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
        $remoteArchive = "$RemoteRoot.tar"
        $result = Invoke-WslOpenSshCommand -Transport $Transport -Program scp -Arguments @(
            (ConvertTo-WslPath $archivePath),
            "$($Transport.endpoint):$remoteArchive"
        ) -ConnectTimeoutSeconds 30 -HardDeadlineSeconds 3600
        if ($result.exit_code -ne 0) {
            throw "World $Label transfer failed ($($result.failure_class)): $($result.output)"
        }
        return [pscustomobject][ordered]@{
            label = $Label
            transfer_mode = 'single-tar-archive'
            remote_root = $RemoteRoot
            remote_archive = $remoteArchive
            archive_sha256 = $archiveHash
            archive_size_bytes = [int64]$archiveFile.Length
            archive_duration_ms = [long]$archiveResult.duration_ms
            duration_ms = [long]$result.duration_ms
            output = [string]$result.output
        }
    } finally {
        if (Test-Path -LiteralPath $archivePath) {
            Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
        }
    }
}

function Get-WorldLocalTreeCapacity {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Label
    )

    [int64]$expandedBytes = 0
    [int64]$entryCount = 0
    foreach ($entry in Get-ChildItem -LiteralPath $Root -Recurse -Force -ErrorAction Stop) {
        if (([IO.FileAttributes]$entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Local $Label staging estimate encountered a reparse point: $($entry.FullName)"
        }
        $entryCount += 1
        if (-not $entry.PSIsContainer) {
            $expandedBytes += [int64]$entry.Length
        }
    }
    return [pscustomobject][ordered]@{
        label = $Label
        root = $Root
        expanded_bytes = $expandedBytes
        entry_count = $entryCount
    }
}

function Invoke-WorldSupplementalCapacityPreflight {
    param(
        [Parameter(Mandatory = $true)]$Transport,
        [Parameter(Mandatory = $true)][ValidatePattern('^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$')][string]$OperationId,
        [Parameter(Mandatory = $true)][ValidateRange(1, [int64]::MaxValue)][int64]$RequiredBytes,
        [Parameter(Mandatory = $true)][ValidateRange(1, [int64]::MaxValue)][int64]$ArchiveEstimateBytes,
        [Parameter(Mandatory = $true)][ValidateRange(1, [int64]::MaxValue)][int64]$ExpandedBytes
    )

    $stagingRoot = $worldSupplementalStagingRoot
    $preflightScript = @'
set -eu
readonly staging_root=/home/debian/ash-atlas-world-promotion-staging
operation_id=$1
required_bytes=$2
archive_estimate_bytes=$3
expanded_bytes=$4
shift 4
[[ "$operation_id" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$ ]] || {
  printf 'invalid promotion operation identity\n' >&2
  exit 1
}
for value in "$required_bytes" "$archive_estimate_bytes" "$expanded_bytes"; do
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || {
    printf 'invalid supplemental capacity arithmetic\n' >&2
    exit 1
  }
done
[[ "$#" -eq 2 ]] || {
  printf 'invalid supplemental capacity release count\n' >&2
  exit 1
}
[[ -d /home && ! -L /home && -d /home/debian && ! -L /home/debian ]] || {
  printf 'World supplemental staging parent is absent or unsafe\n' >&2
  exit 1
}
if [[ ! -e "$staging_root" && ! -L "$staging_root" ]]; then
  install -d -o debian -g debian -m 0700 -- "$staging_root"
fi
[[ -d "$staging_root" && ! -L "$staging_root" ]] || {
  printf 'World supplemental staging root is absent or unsafe\n' >&2
  exit 1
}
[[ "$(stat -c '%U:%G:%a' -- "$staging_root")" = debian:debian:700 ]] || {
  printf 'World supplemental staging root ownership or mode is unsafe\n' >&2
  exit 1
}
for release_id in "$@"; do
  case "$release_id" in
    riverbank-lakeshore-v1|water-names-v1) ;;
    *)
      printf 'invalid supplemental capacity release identity\n' >&2
      exit 1
      ;;
  esac
  root="$staging_root/$operation_id-$release_id"
  [[ ! -e "$root" && ! -L "$root" && ! -e "$root.tar" && ! -L "$root.tar" ]] || {
    printf 'supplemental staging path already exists\n' >&2
    exit 1
  }
done
available_bytes="$(df -PB1 -- "$staging_root" | awk 'NR == 2 {print $4}')"
[[ "$available_bytes" =~ ^[0-9]+$ ]] || {
  printf 'World supplemental staging free space is unreadable\n' >&2
  exit 1
}
(( available_bytes >= required_bytes )) || {
  printf 'insufficient World supplemental staging free space: available=%s required=%s archive_estimate=%s expanded=%s\n' \
    "$available_bytes" "$required_bytes" "$archive_estimate_bytes" "$expanded_bytes" >&2
  exit 1
}
printf '{"operation_id":"%s","staging_root":"%s","available_bytes":%s,"required_free_bytes":%s,"archive_estimate_bytes":%s,"expanded_bytes":%s}\n' \
  "$operation_id" "$staging_root" "$available_bytes" "$required_bytes" "$archive_estimate_bytes" "$expanded_bytes"
'@
    $preflightScript = $preflightScript.Replace("`r`n", "`n").Replace("`r", "`n")
    $result = Invoke-WslOpenSshCommand -Transport $Transport -Program ssh -Arguments (@(
        [string]$Transport.endpoint, 'sudo', 'bash', '-s', '--', $OperationId,
        [string]$RequiredBytes, [string]$ArchiveEstimateBytes, [string]$ExpandedBytes,
        'riverbank-lakeshore-v1', 'water-names-v1'
    )) -ConnectTimeoutSeconds 30 -HardDeadlineSeconds 120 -StandardInput $preflightScript
    if ($result.exit_code -ne 0) {
        throw "World supplemental staging capacity preflight failed ($($result.failure_class)): $($result.output)"
    }
    $line = @($result.output -split '\r?\n' | Where-Object { $_ -match '^\{"operation_id":' } | Select-Object -Last 1)
    if ($line.Count -ne 1) { throw 'World supplemental staging capacity preflight returned no receipt.' }
    try { $remote = $line[0] | ConvertFrom-Json } catch { throw 'World supplemental staging capacity preflight returned invalid JSON.' }
    if ([string]$remote.operation_id -cne $OperationId -or
        [string]$remote.staging_root -cne $stagingRoot -or
        [int64]$remote.required_free_bytes -ne $RequiredBytes -or
        [int64]$remote.archive_estimate_bytes -ne $ArchiveEstimateBytes -or
        [int64]$remote.expanded_bytes -ne $ExpandedBytes -or
        [int64]$remote.available_bytes -lt $RequiredBytes) {
        throw 'World supplemental staging capacity preflight receipt differs from the local arithmetic.'
    }
    return [pscustomobject][ordered]@{
        staging_root = $stagingRoot
        available_bytes = [int64]$remote.available_bytes
        required_free_bytes = $RequiredBytes
        archive_estimate_bytes = $ArchiveEstimateBytes
        expanded_bytes = $ExpandedBytes
        output = [string]$result.output
        duration_ms = [long]$result.duration_ms
    }
}

function Invoke-WorldSupplementalArchiveFinalize {
    param(
        [Parameter(Mandatory = $true)]$Transport,
        [Parameter(Mandatory = $true)][ValidatePattern('^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$')][string]$OperationId,
        [Parameter(Mandatory = $true)][ValidateSet('riverbank-lakeshore-v1', 'water-names-v1')][string]$ReleaseId
    )

    $stagingRoot = $worldSupplementalStagingRoot
    $finalizeScript = @'
set -eu
readonly staging_root=/home/debian/ash-atlas-world-promotion-staging
operation_id=$1
release_id=$2
shift 2
[[ "$#" -eq 0 ]] || {
  printf 'invalid supplemental archive finalize argument count\n' >&2
  exit 1
}
[[ "$operation_id" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$ ]] || {
  printf 'invalid promotion operation identity\n' >&2
  exit 1
}
case "$release_id" in
  riverbank-lakeshore-v1|water-names-v1) ;;
  *)
    printf 'invalid supplemental archive finalize release identity\n' >&2
    exit 1
    ;;
esac
[[ -d "$staging_root" && ! -L "$staging_root" ]] || {
  printf 'World supplemental staging root is absent or unsafe\n' >&2
  exit 1
}
[[ "$(stat -c '%U:%G:%a' -- "$staging_root")" = debian:debian:700 ]] || {
  printf 'World supplemental staging root ownership or mode is unsafe\n' >&2
  exit 1
}
archive="$staging_root/$operation_id-$release_id.tar"
[[ "$archive" = "/home/debian/ash-atlas-world-promotion-staging/$operation_id-$release_id.tar" ]] || {
  printf 'unsafe supplemental archive path\n' >&2
  exit 1
}
[[ -f "$archive" && ! -L "$archive" ]] || {
  printf 'supplemental archive is absent or unsafe\n' >&2
  exit 1
}
[[ "$(stat -c '%h' -- "$archive")" = 1 ]] || {
  printf 'supplemental archive hard-link count is unsafe\n' >&2
  exit 1
}
chown -- debian:debian "$archive"
chmod -- 0600 "$archive"
[[ "$(stat -c '%U:%G:%a:%h' -- "$archive")" = debian:debian:600:1 ]] || {
  printf 'supplemental archive permission normalization failed\n' >&2
  exit 1
}
printf '{"operation_id":"%s","release_id":"%s","staging_root":"%s","archive":"%s","owner_group":"debian:debian","mode":"600","link_count":1}\n' \
  "$operation_id" "$release_id" "$staging_root" "$archive"
'@
    $finalizeScript = $finalizeScript.Replace("`r`n", "`n").Replace("`r", "`n")
    $result = Invoke-WslOpenSshCommand -Transport $Transport -Program ssh -Arguments @(
        [string]$Transport.endpoint, 'sudo', 'bash', '-s', '--', $OperationId, $ReleaseId
    ) -ConnectTimeoutSeconds 30 -HardDeadlineSeconds 120 -StandardInput $finalizeScript
    if ($result.exit_code -ne 0) {
        throw "World $ReleaseId archive finalization failed ($($result.failure_class)): $($result.output)"
    }
    $line = @($result.output -split '\r?\n' | Where-Object { $_ -match '^\{"operation_id":' } | Select-Object -Last 1)
    if ($line.Count -ne 1) { throw "World $ReleaseId archive finalization returned no receipt." }
    try { $remote = $line[0] | ConvertFrom-Json } catch { throw "World $ReleaseId archive finalization returned invalid JSON." }
    $expectedArchive = "$stagingRoot/$OperationId-$ReleaseId.tar"
    if ([string]$remote.operation_id -cne $OperationId -or
        [string]$remote.release_id -cne $ReleaseId -or
        [string]$remote.staging_root -cne $stagingRoot -or
        [string]$remote.archive -cne $expectedArchive -or
        [string]$remote.owner_group -cne 'debian:debian' -or
        [string]$remote.mode -cne '600' -or
        [int]$remote.link_count -ne 1) {
        throw "World $ReleaseId archive finalization receipt differs from the exact normalized path."
    }
    return [pscustomobject][ordered]@{
        operation_id = $OperationId
        release_id = $ReleaseId
        staging_root = $stagingRoot
        archive = $expectedArchive
        owner_group = 'debian:debian'
        mode = '600'
        link_count = 1
        duration_ms = [long]$result.duration_ms
        output = [string]$result.output
    }
}

function Remove-WorldSupplementalStaging {
    param(
        [Parameter(Mandatory = $true)]$Transport,
        [Parameter(Mandatory = $true)][ValidatePattern('^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$')][string]$OperationId,
        [Parameter(Mandatory = $true)][string[]]$ReleaseIds
    )

    $allowedReleaseIds = @('riverbank-lakeshore-v1', 'water-names-v1')
    if ($ReleaseIds.Count -ne $allowedReleaseIds.Count -or
        @($ReleaseIds | Sort-Object -Unique).Count -ne $allowedReleaseIds.Count -or
        @($ReleaseIds | Where-Object { $_ -notin $allowedReleaseIds }).Count -ne 0) {
        throw 'World supplemental staging cleanup release identity is invalid.'
    }
    $cleanupScript = @'
set -eu
operation_id=$1
shift
[[ "$operation_id" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$ ]] || {
  printf 'invalid promotion operation identity\n' >&2
  exit 1
}
[[ "$#" -eq 2 ]] || {
  printf 'invalid supplemental cleanup release count\n' >&2
  exit 1
}
for release_id in "$@"; do
  case "$release_id" in
    riverbank-lakeshore-v1|water-names-v1) ;;
    *)
      printf 'invalid supplemental cleanup release identity\n' >&2
      exit 1
      ;;
  esac
  root="/home/debian/ash-atlas-world-promotion-staging/$operation_id-$release_id"
  [[ "$root" = "/home/debian/ash-atlas-world-promotion-staging/$operation_id-"* ]] || {
    printf 'unsafe supplemental cleanup path\n' >&2
    exit 1
  }
  rm -rf -- "$root" "$root.tar"
done
'@
    $cleanupScript = $cleanupScript.Replace("`r`n", "`n").Replace("`r", "`n")
    $result = Invoke-WslOpenSshCommand -Transport $Transport -Program ssh -Arguments (@(
        [string]$Transport.endpoint, 'sudo', 'bash', '-s', '--', $OperationId
    ) + @($ReleaseIds)) -ConnectTimeoutSeconds 30 -HardDeadlineSeconds 120 -StandardInput $cleanupScript
    if ($result.exit_code -ne 0) {
        throw "World supplemental staging cleanup failed ($($result.failure_class)): $($result.output)"
    }
    return [pscustomobject][ordered]@{
        operation_id = $OperationId
        release_ids = @($ReleaseIds)
        duration_ms = [long]$result.duration_ms
        output = [string]$result.output
    }
}

if (-not $ConfirmPromotion) { throw 'Protected World promotion requires -ConfirmPromotion.' }
if (-not $SshKey) { $SshKey = $script:AshAtlasProductionSshKeyPath }
if (-not $KnownHostsFile) { $KnownHostsFile = Join-Path $env:USERPROFILE '.ssh\known_hosts' }

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$lockPath = Join-Path $repositoryRoot 'config\world-runtime.lock.json'
$remoteScriptPath = Join-Path $PSScriptRoot 'vps\promote-world-runtime.sh'
foreach ($path in @($lockPath, $remoteScriptPath)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required source file is absent: $path" }
}
$lock = Get-Content -Raw -LiteralPath $lockPath | ConvertFrom-Json
$defaults = Get-Content -Raw -LiteralPath (Join-Path $repositoryRoot 'config\dev-runtime.defaults.json') |
    ConvertFrom-Json
$waterbodyOverlay = $lock.waterbody_identity_overlay
if ($null -eq $waterbodyOverlay) {
    throw 'World runtime lock is missing the waterbody identity overlay authority.'
}
foreach ($field in @('release_id', 'manifest_sha256', 'schema', 'schema_version', 'policy', 'policy_version')) {
    if ([string]::IsNullOrWhiteSpace([string]$waterbodyOverlay.$field)) {
        throw "World runtime lock waterbody identity overlay $field is missing."
    }
}
if ([string]$waterbodyOverlay.manifest_sha256 -notmatch '^[0-9a-f]{64}$') {
    throw 'World runtime lock waterbody identity overlay manifest SHA-256 is invalid.'
}
$riverbankLakeshore = $lock.riverbank_lakeshore
if ($null -eq $riverbankLakeshore) { throw 'World runtime lock is missing the riverbank/lakeshore authority.' }
foreach ($field in @(
    @{ name = 'release_id'; expected = 'riverbank-lakeshore-v1' },
    @{ name = 'manifest_sha256'; expected = 'c3a2823f759271abb77bf23220e33cb1146d9a3ecb2615f79d3e173189a2344f' },
    @{ name = 'schema'; expected = 'riverbank-lakeshore-row-spans-v1' },
    @{ name = 'policy'; expected = 'canonical-water-surface-land-within-500m-v1' },
    @{ name = 'pipeline_sha'; expected = '4d3448ae3f719e678d864e04679008294f72df8c' },
    @{ name = 'contract_fingerprint'; expected = '32572021050b078ba856469a705631902e8036c8bf4512334d056732b35000ce' },
    @{ name = 'grid_fingerprint'; expected = '44e1b2d53f5b3d38b6f5370d30c94403d6d4f90a6207f12ccdee799713a6229b' },
    @{ name = 'inventory_sha256'; expected = '2f6048b8cee3c73031ec0e58b01f870e6318d7d8cdc902aae7cf5289b9aa74a0' },
    @{ name = 'source_package_fingerprint'; expected = 'f92da45fcd830d2191cd015db54193b72ff0307f5ce3125e4406de0681792680' },
    @{ name = 'selected_package_fingerprint'; expected = 'aab9bbdf505dda7fe1037fcb31d36e8260422307cc88edb66ed184e40f4c968e' },
    @{ name = 'deterministic_fingerprint'; expected = '63b63551b99514f4db818ce324005f0476663133651f6b9bba040154180422e6' },
    @{ name = 'distance_m'; expected = '500' },
    @{ name = 'cell_size_m'; expected = '125' },
    @{ name = 'package_count'; expected = '14627' },
    @{ name = 'selected_package_count'; expected = '20542' },
    @{ name = 'positive_package_count'; expected = '14627' },
    @{ name = 'empty_package_count'; expected = '5915' },
    @{ name = 'source_package_count'; expected = '14598' },
    @{ name = 'span_count'; expected = '59122237' },
    @{ name = 'membership_cell_count'; expected = '391536663' }
)) {
    Assert-WorldLockExactValue $riverbankLakeshore $field.name $field.expected "riverbank/lakeshore.$($field.name)"
}
$waterNameIndex = $lock.water_name_index
if ($null -eq $waterNameIndex) { throw 'World runtime lock is missing the water-name index authority.' }
foreach ($field in @(
    @{ name = 'release_id'; expected = 'water-names-v1' },
    @{ name = 'manifest_sha256'; expected = 'bb73ebeac7c48d4adcedf9dd10e9a0a6cf591bd8ef7dfe01dca2a141a9e6317b' },
    @{ name = 'schema'; expected = 'water-names-v1' },
    @{ name = 'policy'; expected = 'same-class-nearest-authoritative-name-v1' },
    @{ name = 'entries_filename'; expected = 'entries.sqlite3' },
    @{ name = 'entries_format'; expected = 'sqlite-wkb-rtree-v1' },
    @{ name = 'entries_sha256'; expected = '40dd4b1427c0fc98cdd437ea6dcdb2b2e4d8d5412af636159624e144b337fee9' },
    @{ name = 'entries_size_bytes'; expected = '2295668736' },
    @{ name = 'index_hash'; expected = '90482d2633df3cc869e1c1162aa7b1da0503f051740122eeeb65612cd33c3bd2' },
    @{ name = 'deterministic_fingerprint'; expected = '41d3431fc3f87eb52b1219bccebc32228c6dd49e610f0194ea55c76c8c370661' },
    @{ name = 'entry_count'; expected = '526218' }
)) {
    Assert-WorldLockExactValue $waterNameIndex $field.name $field.expected "water_name_index.$($field.name)"
}
foreach ($field in @(
    @{ name = 'river'; expected = '523086' },
    @{ name = 'lake'; expected = '3021' },
    @{ name = 'ocean'; expected = '111' }
)) {
    Assert-WorldLockExactValue $waterNameIndex.classes $field.name $field.expected "water_name_index.classes.$($field.name)"
}
foreach ($field in @(
    @{ name = 'river'; expected = '25000' },
    @{ name = 'lake'; expected = '100000' },
    @{ name = 'ocean'; expected = '500000' }
)) {
    Assert-WorldLockExactValue $waterNameIndex.max_distance_m $field.name $field.expected "water_name_index.max_distance_m.$($field.name)"
}
$targetRiverRelease = [string]$lock.river_surface.release_id
$targetRiverManifest = [string]$lock.river_surface.manifest_sha256
$targetRiverPolicy = [string]$lock.river_surface.policy
foreach ($field in @(
    @{ name = 'river_surface.release_id'; value = $targetRiverRelease },
    @{ name = 'river_surface.manifest_sha256'; value = $targetRiverManifest },
    @{ name = 'river_surface.policy'; value = $targetRiverPolicy }
)) {
    if ([string]::IsNullOrWhiteSpace([string]$field.value)) {
        throw "World runtime lock $($field.name) is missing."
    }
}
if ($targetRiverRelease -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
    throw 'World runtime lock river surface release ID is invalid.'
}
if ($targetRiverManifest -notmatch '^[0-9a-f]{64}$') {
    throw 'World runtime lock river surface manifest SHA-256 is invalid.'
}
$targetRiverSurfaceRootToken = '{0}--sha256-{1}' -f $targetRiverRelease, $targetRiverManifest
$targetRiverbankRootToken = [string]$riverbankLakeshore.release_id
$targetWaterNameIndexRootToken = [string]$waterNameIndex.release_id
$currentLockCommitResult = Invoke-BoundedNativeProcess -FilePath 'git' -Arguments @(
    '-C', $repositoryRoot, 'rev-parse', '--verify', "$ExpectedCurrentWorldLockRef`^{commit}"
) -TimeoutMilliseconds 10000
if (-not $currentLockCommitResult.start_succeeded -or $currentLockCommitResult.timed_out -or
    $currentLockCommitResult.exit_code -ne 0) {
    throw "Could not resolve the protected current World lock ref $ExpectedCurrentWorldLockRef."
}
$currentLockCommit = ([string]$currentLockCommitResult.stdout).Trim()
if ($currentLockCommit -notmatch '^[0-9a-f]{40}$') {
    throw "Protected current World lock ref $ExpectedCurrentWorldLockRef did not resolve to a canonical commit."
}
$currentLockBlobResult = Invoke-BoundedNativeProcess -FilePath 'git' -Arguments @(
    '-C', $repositoryRoot, 'cat-file', 'blob', "${currentLockCommit}:config/world-runtime.lock.json"
) -TimeoutMilliseconds 10000
if (-not $currentLockBlobResult.start_succeeded -or $currentLockBlobResult.timed_out -or
    $currentLockBlobResult.exit_code -ne 0) {
    throw "Could not read config/world-runtime.lock.json from protected ref $ExpectedCurrentWorldLockRef."
}
try {
    $currentLock = [string]$currentLockBlobResult.stdout | ConvertFrom-Json
} catch {
    throw "Protected current World lock ref $ExpectedCurrentWorldLockRef contains invalid JSON."
}
if ([string]$currentLock.pipeline.sha -ne $ExpectedCurrentWorldSha) {
    throw "Protected current World lock ref $ExpectedCurrentWorldLockRef records World SHA $($currentLock.pipeline.sha), expected $ExpectedCurrentWorldSha."
}
$currentWorldRelease = [string]$currentLock.release.release_id
$currentWorldManifest = [string]$currentLock.release.manifest_sha256
$currentRiverRelease = [string]$currentLock.river_surface.release_id
$currentRiverManifest = [string]$currentLock.river_surface.manifest_sha256
$currentLakeRelease = [string]$currentLock.lake_surface.release_id
$currentLakeManifest = [string]$currentLock.lake_surface.manifest_sha256
$currentOceanRelease = [string]$currentLock.ocean_coast_surface.release_id
$currentOceanManifest = [string]$currentLock.ocean_coast_surface.manifest_sha256
foreach ($field in @(
    @{ name = 'release.release_id'; value = $currentWorldRelease },
    @{ name = 'release.manifest_sha256'; value = $currentWorldManifest },
    @{ name = 'river_surface.release_id'; value = $currentRiverRelease },
    @{ name = 'river_surface.manifest_sha256'; value = $currentRiverManifest },
    @{ name = 'lake_surface.release_id'; value = $currentLakeRelease },
    @{ name = 'lake_surface.manifest_sha256'; value = $currentLakeManifest },
    @{ name = 'ocean_coast_surface.release_id'; value = $currentOceanRelease },
    @{ name = 'ocean_coast_surface.manifest_sha256'; value = $currentOceanManifest }
)) {
    if ([string]::IsNullOrWhiteSpace([string]$field.value)) {
        throw "Protected current World lock $ExpectedCurrentWorldLockRef $($field.name) is missing."
    }
}
foreach ($field in @(
    @{ name = 'release.manifest_sha256'; value = $currentWorldManifest },
    @{ name = 'river_surface.manifest_sha256'; value = $currentRiverManifest },
    @{ name = 'lake_surface.manifest_sha256'; value = $currentLakeManifest },
    @{ name = 'ocean_coast_surface.manifest_sha256'; value = $currentOceanManifest }
)) {
    if ([string]$field.value -notmatch '^[0-9a-f]{64}$') {
        throw "Protected current World lock $ExpectedCurrentWorldLockRef $($field.name) is invalid."
    }
}
if (-not $WorldRepository) {
    $WorldRepository = [string]$defaults.map_repository
}
$WorldRepository = [IO.Path]::GetFullPath($WorldRepository)
if (-not (Test-Path -LiteralPath (Join-Path $WorldRepository '.git'))) {
    throw "World repository is absent: $WorldRepository"
}
$globalPackagesRoot = [IO.Path]::GetFullPath((Join-Path $WorldRepository 'data\intermediate\global-packages'))
$riverbankRoot = [IO.Path]::GetFullPath((Join-Path $globalPackagesRoot ([string]$riverbankLakeshore.release_id)))
if (-not $WaterNameIndexRoot) { $WaterNameIndexRoot = [string]$defaults.water_name_index_root }
$WaterNameIndexRoot = [IO.Path]::GetFullPath($WaterNameIndexRoot)
if ([IO.Path]::GetFileName($riverbankRoot) -cne [string]$riverbankLakeshore.release_id -or
    [IO.Path]::GetDirectoryName($riverbankRoot).TrimEnd('\') -cne $globalPackagesRoot.TrimEnd('\')) {
    throw 'Riverbank/lakeshore root is not the canonical map global-packages release.'
}
if ([IO.Path]::GetFileName($WaterNameIndexRoot) -cne [string]$waterNameIndex.release_id) {
    throw 'Water-name index root must end in its locked release ID.'
}
Assert-WorldLocalRiverbankRoot $riverbankRoot $riverbankLakeshore
Assert-WorldLocalWaterNameIndexRoot $WaterNameIndexRoot $waterNameIndex

& git -C $WorldRepository fetch origin --prune
if ($LASTEXITCODE -ne 0) { throw 'Could not fetch protected World main.' }
$protectedSha = (& git -C $WorldRepository rev-parse origin/main).Trim()
if ($LASTEXITCODE -ne 0 -or $protectedSha -ne $WorldSha) {
    throw "Protected World main is $protectedSha, expected $WorldSha."
}
$pyproject = Invoke-BoundedNativeProcess -FilePath 'git' -Arguments @(
    '-C', $WorldRepository, 'cat-file', 'blob', "${WorldSha}:pyproject.toml"
) -TimeoutMilliseconds 10000
if (-not $pyproject.start_succeeded -or $pyproject.timed_out -or $pyproject.exit_code -ne 0) {
    throw 'Could not read the protected dependency manifest.'
}
$algorithm = [Security.Cryptography.SHA256]::Create()
try {
    $dependencySha = ([BitConverter]::ToString($algorithm.ComputeHash(
        [Text.UTF8Encoding]::new($false).GetBytes([string]$pyproject.stdout)
    ))).Replace('-', '').ToLowerInvariant()
} finally {
    $algorithm.Dispose()
}

$operationId = '{0}-{1}' -f (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ'),
    ([Guid]::NewGuid().ToString('N').Substring(0, 8))
$riverbankTransferRemoteRoot = "$worldSupplementalStagingRoot/$operationId-$($riverbankLakeshore.release_id)"
$waterNameIndexTransferRemoteRoot = "$worldSupplementalStagingRoot/$operationId-$($waterNameIndex.release_id)"
$utf8 = [Text.UTF8Encoding]::new($false, $true)
$remoteScript = [IO.File]::ReadAllText($remoteScriptPath, $utf8).Replace("`r`n", "`n").Replace("`r", "`n")
$arguments = @(
    $WorldSha,
    $ExpectedCurrentWorldSha,
    $dependencySha,
    [string]$lock.release.release_id,
    [string]$lock.release.manifest_sha256,
    [string]$lock.river_surface.release_id,
    [string]$lock.river_surface.manifest_sha256,
    [string]$lock.river_surface.policy,
    [string]$lock.lake_surface.release_id,
    [string]$lock.lake_surface.manifest_sha256,
    [string]$lock.lake_surface.policy,
    [string]$lock.ocean_coast_surface.release_id,
    [string]$lock.ocean_coast_surface.manifest_sha256,
    [string]$lock.ocean_coast_surface.policy,
    [string]$waterbodyOverlay.release_id,
    [string]$waterbodyOverlay.manifest_sha256,
    [string]$waterbodyOverlay.schema,
    [string]$waterbodyOverlay.schema_version,
    [string]$waterbodyOverlay.policy,
    [string]$waterbodyOverlay.policy_version,
    $currentWorldRelease,
    $currentWorldManifest,
    $currentRiverRelease,
    $currentRiverManifest,
    $currentLakeRelease,
    $currentLakeManifest,
    $currentOceanRelease,
    $currentOceanManifest,
    $operationId,
    $CandidateReadinessSeconds,
    $targetRiverSurfaceRootToken,
    [string]$riverbankLakeshore.release_id,
    [string]$riverbankLakeshore.manifest_sha256,
    [string]$riverbankLakeshore.schema,
    [string]$riverbankLakeshore.policy,
    [string]$riverbankLakeshore.pipeline_sha,
    [string]$riverbankLakeshore.contract_fingerprint,
    [string]$riverbankLakeshore.grid_fingerprint,
    [string]$riverbankLakeshore.distance_m,
    [string]$riverbankLakeshore.cell_size_m,
    [string]$riverbankLakeshore.inventory_sha256,
    [string]$riverbankLakeshore.source_package_fingerprint,
    [string]$riverbankLakeshore.selected_package_fingerprint,
    [string]$riverbankLakeshore.deterministic_fingerprint,
    [string]$riverbankLakeshore.package_count,
    [string]$riverbankLakeshore.selected_package_count,
    [string]$riverbankLakeshore.positive_package_count,
    [string]$riverbankLakeshore.empty_package_count,
    [string]$riverbankLakeshore.source_package_count,
    [string]$riverbankLakeshore.span_count,
    [string]$riverbankLakeshore.membership_cell_count,
    [string]$waterNameIndex.release_id,
    [string]$waterNameIndex.manifest_sha256,
    [string]$waterNameIndex.schema,
    [string]$waterNameIndex.policy,
    [string]$waterNameIndex.entries_filename,
    [string]$waterNameIndex.entries_format,
    [string]$waterNameIndex.entries_sha256,
    [string]$waterNameIndex.entries_size_bytes,
    [string]$waterNameIndex.index_hash,
    [string]$waterNameIndex.deterministic_fingerprint,
    [string]$waterNameIndex.entry_count,
    [string]$waterNameIndex.classes.river,
    [string]$waterNameIndex.classes.lake,
    [string]$waterNameIndex.classes.ocean,
    [string]$waterNameIndex.max_distance_m.river,
    [string]$waterNameIndex.max_distance_m.lake,
    [string]$waterNameIndex.max_distance_m.ocean
)
$transport = Resolve-WslOpenSshTransport `
    -SshHost $SshHost -SshKey $SshKey -KnownHostsFile $KnownHostsFile
$riverbankCapacity = Get-WorldLocalTreeCapacity -Root $riverbankRoot -Label 'riverbank/lakeshore authority'
$waterNameIndexCapacity = Get-WorldLocalTreeCapacity -Root $WaterNameIndexRoot -Label 'water-name index authority'
$archiveHeaderReservePerEntryBytes = [int64]65536
$archiveSafetyReserveBytesPerRoot = [int64]67108864
$expandedSafetyReserveBytesPerRoot = [int64]67108864
$controllerSafetyReserveBytes = [int64]268435456
$expandedBytes = [int64]$riverbankCapacity.expanded_bytes + [int64]$waterNameIndexCapacity.expanded_bytes
$entryCount = [int64]$riverbankCapacity.entry_count + [int64]$waterNameIndexCapacity.entry_count
# The gate covers both remote tar archives plus both expanded roots at peak,
# with per-entry tar overhead and explicit extraction/controller reserves.
$archiveEstimateBytes = $expandedBytes +
    ($entryCount * $archiveHeaderReservePerEntryBytes) +
    (2 * $archiveSafetyReserveBytesPerRoot)
$requiredFreeBytes = $archiveEstimateBytes +
    $expandedBytes +
    (2 * $expandedSafetyReserveBytesPerRoot) +
    $controllerSafetyReserveBytes
$capacityPreflight = Invoke-WorldSupplementalCapacityPreflight -Transport $transport -OperationId $operationId `
    -RequiredBytes $requiredFreeBytes -ArchiveEstimateBytes $archiveEstimateBytes -ExpandedBytes $expandedBytes
$transferReleaseIds = @([string]$riverbankLakeshore.release_id, [string]$waterNameIndex.release_id)
try {
    $riverbankTransfer = Invoke-WorldSupplementalTransfer -Transport $transport -SourceRoot $riverbankRoot `
        -RemoteRoot $riverbankTransferRemoteRoot -Label 'riverbank/lakeshore authority'
    $riverbankArchiveFinalize = Invoke-WorldSupplementalArchiveFinalize -Transport $transport -OperationId $operationId `
        -ReleaseId ([string]$riverbankLakeshore.release_id)
    $waterNameIndexTransfer = Invoke-WorldSupplementalTransfer -Transport $transport -SourceRoot $WaterNameIndexRoot `
        -RemoteRoot $waterNameIndexTransferRemoteRoot -Label 'water-name index authority'
    $waterNameIndexArchiveFinalize = Invoke-WorldSupplementalArchiveFinalize -Transport $transport -OperationId $operationId `
        -ReleaseId ([string]$waterNameIndex.release_id)
} catch {
    $transferFailure = $_
    try {
        $transferCleanup = Remove-WorldSupplementalStaging -Transport $transport -OperationId $operationId `
            -ReleaseIds $transferReleaseIds
    } catch {
        throw "World supplemental staging handoff failed and owned staging cleanup failed: $($_.Exception.Message)`nOriginal handoff failure: $($transferFailure.Exception.Message)"
    }
    throw $transferFailure
}
$stopwatch = [Diagnostics.Stopwatch]::StartNew()
$result = Invoke-WslOpenSshCommand -Transport $transport -Program ssh -Arguments (@(
    [string]$transport.endpoint, 'sudo', 'bash', '-s', '--'
) + $arguments) -ConnectTimeoutSeconds 30 -HardDeadlineSeconds 1200 -StandardInput $remoteScript
$stopwatch.Stop()

$reportRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) (
    'AshAtlas\{0}\World Promotion Operations' -f (Get-Date).ToString('yyyy-MM-dd'))
New-Item -ItemType Directory -Force -Path $reportRoot | Out-Null
$reportPath = Join-Path $reportRoot "$operationId.json"
$targetIdentity = [pscustomobject][ordered]@{
    world_sha = $WorldSha
    release = [pscustomobject][ordered]@{
        release_id = [string]$lock.release.release_id
        manifest_sha256 = [string]$lock.release.manifest_sha256
    }
    river_surface = [pscustomobject][ordered]@{
        release_id = [string]$lock.river_surface.release_id
        manifest_sha256 = [string]$lock.river_surface.manifest_sha256
        release_root_token = $targetRiverSurfaceRootToken
    }
    riverbank_lakeshore = [pscustomobject][ordered]@{
        release_id = [string]$riverbankLakeshore.release_id
        manifest_sha256 = [string]$riverbankLakeshore.manifest_sha256
        schema = [string]$riverbankLakeshore.schema
        policy = [string]$riverbankLakeshore.policy
        pipeline_sha = [string]$riverbankLakeshore.pipeline_sha
        contract_fingerprint = [string]$riverbankLakeshore.contract_fingerprint
        grid_fingerprint = [string]$riverbankLakeshore.grid_fingerprint
        release_root_token = $targetRiverbankRootToken
    }
    lake_surface = [pscustomobject][ordered]@{
        release_id = [string]$lock.lake_surface.release_id
        manifest_sha256 = [string]$lock.lake_surface.manifest_sha256
    }
    ocean_coast_surface = [pscustomobject][ordered]@{
        release_id = [string]$lock.ocean_coast_surface.release_id
        manifest_sha256 = [string]$lock.ocean_coast_surface.manifest_sha256
    }
    water_name_index = [pscustomobject][ordered]@{
        release_id = [string]$waterNameIndex.release_id
        manifest_sha256 = [string]$waterNameIndex.manifest_sha256
        schema = [string]$waterNameIndex.schema
        policy = [string]$waterNameIndex.policy
        entries_filename = [string]$waterNameIndex.entries_filename
        entries_format = [string]$waterNameIndex.entries_format
        entries_sha256 = [string]$waterNameIndex.entries_sha256
        entries_size_bytes = [int64]$waterNameIndex.entries_size_bytes
        index_hash = [string]$waterNameIndex.index_hash
        deterministic_fingerprint = [string]$waterNameIndex.deterministic_fingerprint
        entry_count = [int]$waterNameIndex.entry_count
        release_root_token = $targetWaterNameIndexRootToken
    }
    waterbody_identity_overlay = [pscustomobject][ordered]@{
        release_id = [string]$waterbodyOverlay.release_id
        manifest_sha256 = [string]$waterbodyOverlay.manifest_sha256
        schema = [string]$waterbodyOverlay.schema
        schema_version = [string]$waterbodyOverlay.schema_version
        policy = [string]$waterbodyOverlay.policy
        policy_version = [string]$waterbodyOverlay.policy_version
    }
}
$currentIdentity = [pscustomobject][ordered]@{
    world_sha = $ExpectedCurrentWorldSha
    lock_ref = $ExpectedCurrentWorldLockRef
    lock_commit = $currentLockCommit
    release = [pscustomobject][ordered]@{
        release_id = $currentWorldRelease
        manifest_sha256 = $currentWorldManifest
    }
    river_surface = [pscustomobject][ordered]@{
        release_id = $currentRiverRelease
        manifest_sha256 = $currentRiverManifest
        release_root_token = $currentRiverRelease
    }
    lake_surface = [pscustomobject][ordered]@{
        release_id = $currentLakeRelease
        manifest_sha256 = $currentLakeManifest
    }
    ocean_coast_surface = [pscustomobject][ordered]@{
        release_id = $currentOceanRelease
        manifest_sha256 = $currentOceanManifest
    }
}
$phaseRows = @($result.stdout -split '\r?\n' | ForEach-Object {
    if ($_ -match '^(?<phase>[a-z_]+)\t(?<duration>[0-9]+)\t(?<result>[^\r\n]+)$') {
        [pscustomobject][ordered]@{
            phase = $Matches.phase
            duration_ms = [long]$Matches.duration
            result = $Matches.result
        }
    }
})
$finalLine = @($result.stdout -split '\r?\n' | Where-Object { $_ -match '^\{"ok":true,' } | Select-Object -Last 1)
$remoteReceipt = if ($finalLine) { $finalLine | ConvertFrom-Json } else { $null }
$receipt = [pscustomobject][ordered]@{
    schema_version = 1
    operation_id = $operationId
    requested_world_sha = $WorldSha
    protected_world_sha = $protectedSha
    previous_locked_world_sha = $ExpectedCurrentWorldSha
    expected_current_identity = $currentIdentity
    target_identity = $targetIdentity
    target_river_surface_root_token = $targetRiverSurfaceRootToken
    target_riverbank_lakeshore_root_token = $targetRiverbankRootToken
    target_water_name_index_root_token = $targetWaterNameIndexRootToken
    supplemental_staging_preflight = [pscustomobject][ordered]@{
        staging_root = $capacityPreflight.staging_root
        available_bytes = $capacityPreflight.available_bytes
        required_free_bytes = $capacityPreflight.required_free_bytes
        archive_estimate_bytes = $capacityPreflight.archive_estimate_bytes
        expanded_bytes = $capacityPreflight.expanded_bytes
        archive_header_reserve_per_entry_bytes = $archiveHeaderReservePerEntryBytes
        archive_safety_reserve_bytes_per_root = $archiveSafetyReserveBytesPerRoot
        expanded_safety_reserve_bytes_per_root = $expandedSafetyReserveBytesPerRoot
        controller_safety_reserve_bytes = $controllerSafetyReserveBytes
        riverbank_entry_count = $riverbankCapacity.entry_count
        water_name_index_entry_count = $waterNameIndexCapacity.entry_count
        duration_ms = $capacityPreflight.duration_ms
    }
    supplemental_transfers = @($riverbankTransfer, $waterNameIndexTransfer)
    supplemental_archive_finalizations = @($riverbankArchiveFinalize, $waterNameIndexArchiveFinalize)
    dependency_manifest_sha256 = $dependencySha
    candidate_readiness_seconds = $CandidateReadinessSeconds
    waterbody_identity_overlay = [pscustomobject][ordered]@{
        release_id = [string]$waterbodyOverlay.release_id
        manifest_sha256 = [string]$waterbodyOverlay.manifest_sha256
        schema = [string]$waterbodyOverlay.schema
        schema_version = [string]$waterbodyOverlay.schema_version
        policy = [string]$waterbodyOverlay.policy
        policy_version = [string]$waterbodyOverlay.policy_version
    }
    command_duration_ms = [long]$stopwatch.ElapsedMilliseconds
    transport_duration_ms = [long]$result.duration_ms
    result = if ($result.exit_code -eq 0) { 'completed' } else { 'failed' }
    failure_class = [string]$result.failure_class
    phases = $phaseRows
    remote_receipt = $remoteReceipt
    output = [string]$result.output
}
$receipt | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $reportPath -Encoding utf8
if ($result.exit_code -ne 0) {
    throw "World promotion failed ($($result.failure_class)). Receipt: $reportPath`n$($result.output)"
}
[pscustomobject][ordered]@{
    operation_id = $operationId
    world_sha = $WorldSha
    expected_current_identity = $currentIdentity
    target_identity = $targetIdentity
    target_river_surface_root_token = $targetRiverSurfaceRootToken
    target_riverbank_lakeshore_root_token = $targetRiverbankRootToken
    target_water_name_index_root_token = $targetWaterNameIndexRootToken
    supplemental_staging_preflight = [pscustomobject][ordered]@{
        staging_root = $capacityPreflight.staging_root
        available_bytes = $capacityPreflight.available_bytes
        required_free_bytes = $capacityPreflight.required_free_bytes
        archive_estimate_bytes = $capacityPreflight.archive_estimate_bytes
        expanded_bytes = $capacityPreflight.expanded_bytes
        archive_header_reserve_per_entry_bytes = $archiveHeaderReservePerEntryBytes
        archive_safety_reserve_bytes_per_root = $archiveSafetyReserveBytesPerRoot
        expanded_safety_reserve_bytes_per_root = $expandedSafetyReserveBytesPerRoot
        controller_safety_reserve_bytes = $controllerSafetyReserveBytes
        riverbank_entry_count = $riverbankCapacity.entry_count
        water_name_index_entry_count = $waterNameIndexCapacity.entry_count
        duration_ms = $capacityPreflight.duration_ms
    }
    supplemental_transfers = @($riverbankTransfer, $waterNameIndexTransfer)
    supplemental_archive_finalizations = @($riverbankArchiveFinalize, $waterNameIndexArchiveFinalize)
    dependency_manifest_sha256 = $dependencySha
    candidate_readiness_seconds = $CandidateReadinessSeconds
    duration_ms = [long]$stopwatch.ElapsedMilliseconds
    phases = $phaseRows
    remote_receipt = $remoteReceipt
    report = $reportPath
} | ConvertTo-Json -Depth 10
