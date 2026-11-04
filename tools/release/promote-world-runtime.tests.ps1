$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
. (Join-Path $root 'tools\release\deployment-transport.ps1')
$wrapperPath = Join-Path $root 'tools\release\promote-world-runtime.ps1'
$remotePath = Join-Path $root 'tools\release\vps\promote-world-runtime.sh'
$wrapper = Get-Content -Raw -LiteralPath $wrapperPath
$remote = Get-Content -Raw -LiteralPath $remotePath
$lock = Get-Content -Raw -LiteralPath (Join-Path $root 'config\world-runtime.lock.json') | ConvertFrom-Json

$tokens = $null
$errors = $null
[void][Management.Automation.Language.Parser]::ParseFile($wrapperPath, [ref]$tokens, [ref]$errors)
if (@($errors).Count -ne 0) { throw 'World promotion wrapper has PowerShell parse errors.' }

$bash = Get-Command bash -ErrorAction Stop
& $bash.Source -n (ConvertTo-WslPath $remotePath) 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'World promotion remote helper has bash parse errors.' }

function Assert-Contract([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "World promotion contract failed: $Message" }
}

Assert-Contract ([regex]::Matches($wrapper, 'Invoke-WslOpenSshCommand').Count -eq 5) 'wrapper uses bounded preflight, SCP, archive finalization, cleanup, and SSH transport'
Assert-Contract ($wrapper -match 'WaterNameIndexRoot' -and
    $wrapper -match 'Assert-WorldLocalRiverbankRoot' -and
    $wrapper -match 'Assert-WorldLocalWaterNameIndexRoot' -and
    $wrapper -match 'Invoke-WorldSupplementalTransfer' -and
    $wrapper -match "Get-Command 'tar[.]exe'" -and
    $wrapper -match "'-cf', \`$archivePath" -and
    $wrapper -match "transfer_mode = 'single-tar-archive'" -and
    $wrapper -match 'archive_sha256' -and
    $wrapper -match 'Get-WorldLocalTreeCapacity' -and
    $wrapper -match 'Invoke-WorldSupplementalCapacityPreflight' -and
    $wrapper -match 'requiredFreeBytes' -and
    $wrapper -match 'available_bytes -lt \$RequiredBytes' -and
    $wrapper -match 'insufficient World supplemental staging free space' -and
    $wrapper -match 'required_free_bytes' -and
    $wrapper -match 'archiveHeaderReservePerEntryBytes' -and
    $wrapper -match 'expandedSafetyReserveBytesPerRoot' -and
    $wrapper -match 'controllerSafetyReserveBytes' -and
    $wrapper -match 'TimeoutMilliseconds 3600000' -and
    $wrapper -match 'HardDeadlineSeconds 3600' -and
    $wrapper -match 'Invoke-WorldSupplementalArchiveFinalize' -and
    $wrapper -match 'archiveFinalize' -and
    $wrapper -match 'chown -- debian:debian' -and
    $wrapper -match 'chmod -- 0600' -and
    $wrapper -match 'unsafe supplemental archive path' -and
    $wrapper -match 'supplemental archive is absent or unsafe' -and
    $wrapper -match 'supplemental archive hard-link count is unsafe' -and
    $wrapper -match 'owner_group' -and
    $wrapper -match 'link_count' -and
    $wrapper -match 'supplemental_archive_finalizations' -and
    $wrapper -match '(?s)\$riverbankTransfer = Invoke-WorldSupplementalTransfer.+?\$riverbankArchiveFinalize = Invoke-WorldSupplementalArchiveFinalize' -and
    $wrapper -match '(?s)\$waterNameIndexTransfer = Invoke-WorldSupplementalTransfer.+?\$waterNameIndexArchiveFinalize = Invoke-WorldSupplementalArchiveFinalize' -and
    $wrapper -match 'Remove-WorldSupplementalStaging' -and
    $wrapper -match '\$targetRiverbankRootToken = \[string\]\$riverbankLakeshore[.]release_id' -and
    $wrapper -match '\$targetWaterNameIndexRootToken = \[string\]\$waterNameIndex[.]release_id' -and
    $wrapper -notmatch '\$targetRiverbankRootToken = .*--sha256-' -and
    $wrapper -notmatch '\$targetWaterNameIndexRootToken = .*--sha256-' -and
    $wrapper -match 'HardDeadlineSeconds 120' -and
    $wrapper -match 'transferReleaseIds' -and
    $wrapper -match 'transferFailure' -and
    $wrapper -match 'transferCleanup' -and
    $wrapper -match 'owned staging cleanup failed' -and
    $wrapper -notmatch "(?s)function Invoke-WorldSupplementalTransfer.+?'\-r'," -and
    $wrapper -match '-Program scp' -and
    $wrapper -match '/home/debian/ash-atlas-world-promotion-staging/' -and
    $wrapper -notmatch '/tmp/ash-atlas-world-promotion-') 'wrapper validates, capacity-checks, and stages both supplemental roots'
Assert-Contract ($remote -match 'validate_riverbank_release_root' -and
    $remote -match 'validate_water_name_index_release_root' -and
    $remote -match 'publish_supplemental_root' -and
    $remote -match 'extract_transferred_archive' -and
    $remote -match 'tarfile[.]open' -and
    $remote -match 'member[.]isfile' -and
    $remote -match '\$transfer[.]tar' -and
    $remote -match 'mv -T -- "\$incoming" "\$target"' -and
    $remote -match 'SUPPLEMENTAL_STAGING_ROOT=/home/debian/ash-atlas-world-promotion-staging' -and
    $remote -match 'stat -c ''%U:%G:%a''' -and
    $remote -match 'validate_transferred_archive' -and
    $remote -match '\[\[ -f "\$archive" && ! -L "\$archive" \]\]' -and
    $remote -match 'archive ownership is unsafe' -and
    $remote -match 'archive mode is unsafe' -and
    $remote -match 'printf ''%d'' "0\$mode"' -and
    $remote -match 'mode_value & 0022' -and
    $remote -match 'supplemental extraction directory already exists' -and
    $remote -match 'validate_transferred_archive "\$RIVERBANK_TRANSFER_ROOT[.]tar"' -and
    $remote -match 'validate_transferred_archive "\$WATER_NAME_INDEX_TRANSFER_ROOT[.]tar"' -and
    $remote -match 'RIVERBANK_TRANSFER_ROOT=\$SUPPLEMENTAL_STAGING_ROOT/' -and
    $remote -match 'WATER_NAME_INDEX_TRANSFER_ROOT=\$SUPPLEMENTAL_STAGING_ROOT/' -and
    $remote -match 'readonly RIVERBANK_TARGET_ROOT_TOKEN=\$RIVERBANK_RELEASE' -and
    $remote -match 'readonly WATER_NAME_INDEX_TARGET_ROOT_TOKEN=\$WATER_NAME_INDEX_RELEASE' -and
    $remote -notmatch 'readonly RIVERBANK_TARGET_ROOT_TOKEN=\$RIVERBANK_RELEASE--sha256-' -and
    $remote -notmatch 'readonly WATER_NAME_INDEX_TARGET_ROOT_TOKEN=\$WATER_NAME_INDEX_RELEASE--sha256-' -and
    $remote -match '(?m)^ExecStart=' -and
    $remote -notmatch '(?m)^ ExecStart=' -and
    $remote -match '--riverbank-lakeshore-release-root \$RIVERBANK_TARGET_ROOT' -and
    $remote -match '--water-name-index-root \$WATER_NAME_INDEX_TARGET_ROOT') 'remote helper validates and atomically publishes both roots'
Assert-Contract ($remote -match 'require_supplemental=\$\{14:-false\}' -and
    $remote -match 'riverbankLakeshoreV1' -and
    $remote -match 'unit_has_supplemental_args' -and
    $remote -match 'unit_has_canonical_execstart' -and
    $remote -match 'if unit_has_supplemental_args && unit_has_canonical_execstart && wait_ready' -and
    $remote -match 'result":"already-active"') 'candidate, active, and same-SHA recovery require supplemental health proof'
Assert-Contract ($remote -match 'readonly UNIT=/etc/systemd/system/ash-atlas-world[.]service' -and
    $remote -match 'read_validated_unit_text' -and
    $remote -match '\[\[ -f "\$UNIT" && ! -L "\$UNIT" \]\] \|\| return 2' -and
    $remote -match 'cat -- "\$UNIT"' -and
    $remote -notmatch 'systemctl cat "\$UNIT"') 'supplemental classifier reads the exact validated absolute unit file and rejects read/path failure'
Assert-Contract ($remote -match 'TARGET_ACTIVE_RECOVERY=false' -and
    $remote -match 'unit_supplemental_arg_state' -and
    $remote -match 'target_active_recovery_state_is_safe' -and
    $remote -match '\[\[ "\$state" = missing \]\]' -and
    $remote -match '! unit_has_canonical_execstart' -and
    $remote -match '(?s)target_active_recovery_state_is_safe "\$supplemental_state".+?wait_ready 8765 "\$TARGET_SHA"' -and
    $remote -match 'target-active recovery requires missing supplemental arguments or a complete exact noncanonical repair state' -and
    $remote -match 'current World is neither the approved base nor an eligible target-active recovery' -and
    $remote -match 'TARGET_ACTIVE_RECOVERY=true' -and
    $remote -match 'target_active_recovery":%s') 'target-active recovery requires exact target core identity and a safe supplemental repair state'
Assert-Contract ($remote -match 'TRAP_INSTALLED=false' -and
    $remote -match 'CLEANUP_DONE=false' -and
    $remote -match 'ROLLBACK_RUNNING=false' -and
    $remote -match 'CLEANUP_DONE=true' -and
    $remote -match 'TRAP_INSTALLED" = true' -and
    $remote -match 'BASH_SUBSHELL" -eq 0' -and
    $remote -match 'rollback 1' -and
    $remote -match 'trap - ERR HUP INT TERM' -and
    $remote -match 'if \[\[ "\$ROLLBACK_RUNNING" = true \]\]' -and
    $remote -match 'cleanup_supplemental_staging') 'remote failure and signal cleanup is one-shot, trap-safe, and disabled on success'
Assert-Contract ([string]$lock.riverbank_lakeshore.manifest_sha256 -eq
    'c3a2823f759271abb77bf23220e33cb1146d9a3ecb2615f79d3e173189a2344f' -and
    [string]$lock.water_name_index.manifest_sha256 -eq
    'bb73ebeac7c48d4adcedf9dd10e9a0a6cf591bd8ef7dfe01dca2a141a9e6317b') 'lock contains the pinned supplemental authorities'

Write-Output 'promote-world-runtime PowerShell contract tests passed'
