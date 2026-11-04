Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$updater = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'deploy-test-update.sh')
$start = $updater.IndexOf('recovery_cache_policy_matches_audit()')
if ($start -lt 0) { throw 'Recovery cache-policy verifier is absent' }
$script = [regex]::Match($updater.Substring($start), "(?s)<<'NODE'\r?\n(?<body>.*?)\r?\nNODE")
if (-not $script.Success) { throw 'Recovery cache-policy verifier cannot be extracted' }
$nodeScript = $script.Groups['body'].Value

$root = Join-Path ([IO.Path]::GetTempPath()) ('ash-atlas-recovery-' + [guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Path $root | Out-Null
try {
    $receiptPath = Join-Path $root 'receipt.json'
    $auditPath = Join-Path $root 'audit.json'
    $policyPath = Join-Path $root 'policy.caddy'
    $operation = 'coordinated-fixture'
    $target = 'a' * 40
    $updaterHash = 'b' * 64
    [IO.File]::WriteAllText($policyPath, 'trusted-policy')
    $policyHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $policyPath).Hash.ToLowerInvariant()
    $audit = [ordered]@{
        operation_id = $operation
        target_sha = $target
        recovery_updater_sha256 = $updaterHash
        proof = @{ installed_cache_policy_sha256 = $policyHash }
        failed_receipt = @{
            operation_id = $operation
            result = 'failed'
            current_phase = 'artifact_hashing'
        }
    }
    [IO.File]::WriteAllText($auditPath, ($audit | ConvertTo-Json -Depth 8 -Compress))
    $auditHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $auditPath).Hash.ToLowerInvariant()
    $receipt = @{
        operation_id = $operation
        requested_action = 'prepare'
        requested_target_sha = $target
        updater_hash = $updaterHash
        recovery_audit_path = $auditPath
        recovery_audit_sha256 = $auditHash
        recovery_cache_policy_sha256 = $policyHash
    }
    [IO.File]::WriteAllText($receiptPath, ($receipt | ConvertTo-Json -Depth 8 -Compress))

    $nodeScript | & node - $receiptPath $auditPath $policyPath $operation $target
    if ($LASTEXITCODE -ne 0) { throw 'Trusted recovery policy was rejected' }
    [IO.File]::WriteAllText($policyPath, 'altered-policy')
    $nodeScript | & node - $receiptPath $auditPath $policyPath $operation $target
    if ($LASTEXITCODE -eq 0) { throw 'Altered installed policy was accepted' }
    [IO.File]::WriteAllText($policyPath, 'trusted-policy')
    $audit.proof.installed_cache_policy_sha256 = 'c' * 64
    [IO.File]::WriteAllText($auditPath, ($audit | ConvertTo-Json -Depth 8 -Compress))
    $nodeScript | & node - $receiptPath $auditPath $policyPath $operation $target
    if ($LASTEXITCODE -eq 0) { throw 'Altered recovery audit was accepted' }
    'deploy-update-recovery.tests.ps1: passed'
} finally {
    foreach ($path in @($receiptPath, $auditPath, $policyPath)) {
        if ($path) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
    }
    Remove-Item -LiteralPath $root -ErrorAction SilentlyContinue
}
