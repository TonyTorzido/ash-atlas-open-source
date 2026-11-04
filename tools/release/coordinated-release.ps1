Set-StrictMode -Version Latest

# Shared, side-effect free rules for a coordinated server/mobile release.  The
# canonical release orchestrator dot-sources this file, while the focused
# fixture suite loads it directly.  Store writes remain owned by the mobile
# release worker; this file only validates and journals the coordinator's
# durable identity and gate state.

function Stop-CoordinatedRelease {
    param([Parameter(Mandatory = $true)][string]$Message)
    $stop = Get-Command Stop-Workflow -ErrorAction SilentlyContinue
    if ($null -ne $stop) { & $stop $Message }
    throw $Message
}

function Get-CoordinatedProperty {
    param(
        [Parameter(Mandatory = $true)][AllowNull()]$Object,
        [Parameter(Mandatory = $true)][string]$Name,
        $Default = $null
    )
    if ($null -eq $Object) { return $Default }
    if ($Object -is [System.Collections.IDictionary] -and $Object.Contains($Name)) {
        return $Object[$Name]
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $Default }
    return $property.Value
}

function Assert-CoordinatedPattern {
    param(
        [Parameter(Mandatory = $true)][string]$Value,
        [Parameter(Mandatory = $true)][string]$Pattern,
        [Parameter(Mandatory = $true)][string]$Label
    )
    if ($Value -notmatch $Pattern) {
        Stop-CoordinatedRelease "$Label is invalid"
    }
}

function Get-CoordinatedReleasePhaseOrder {
    return @(
        'manifest_created',
        'apps_submitted',
        'apps_ready',
        'server_published',
        'server_activated',
        'server_healthy',
        'apps_release_requested',
        'completed'
    )
}

function Get-CoordinatedReleasePhaseIndex {
    param([Parameter(Mandatory = $true)][string]$Phase)
    $phases = @(Get-CoordinatedReleasePhaseOrder)
    $index = [Array]::IndexOf($phases, $Phase)
    if ($index -lt 0) { Stop-CoordinatedRelease "unknown coordinated release phase '$Phase'" }
    return $index
}

function Get-CoordinatedReleaseAppPlatforms {
    return @('ios', 'android')
}

function Get-CoordinatedReleaseDeliveryMode {
    param([AllowNull()]$Value)
    $raw = if ($Value -is [string]) { $Value } else {
        $mode = Get-CoordinatedProperty $Value 'delivery_mode' $null
        if ($null -eq $mode) { $mode = Get-CoordinatedProperty $Value 'deliveryMode' $null }
        $mode
    }
    if ($null -eq $raw -or [string]$raw -eq '') { return 'production' }
    $mode = [string]$raw
    if ($mode -notin @('production', 'daily-testers')) {
        Stop-CoordinatedRelease "unsupported coordinated delivery mode '$mode'"
    }
    return $mode
}

function Get-CoordinatedReleaseAliasValue {
    param(
        [AllowNull()]$Value,
        [Parameter(Mandatory = $true)][string[]]$Names,
        [Parameter(Mandatory = $true)][string]$Label,
        [switch]$Optional
    )
    $supplied = @($Names | ForEach-Object {
            $candidate = Get-CoordinatedProperty $Value $_ $null
            if ($null -ne $candidate) { $candidate }
        })
    if ($supplied.Count -eq 0) {
        if ($Optional) { return $null }
        Stop-CoordinatedRelease "$Label is required"
    }
    $normalized = @($supplied | ForEach-Object { [string]$_ })
    if (@($normalized | Where-Object { $_ -cne $normalized[0] }).Count -gt 0) {
        Stop-CoordinatedRelease "$Label aliases disagree"
    }
    return $normalized[0]
}

function Normalize-CoordinatedReleaseTesterDestination {
    param(
        [Parameter(Mandatory = $true)][string]$Platform,
        [AllowNull()]$Destination
    )
    if ($null -eq $Destination) { return $null }
    if ($Platform -notin @(Get-CoordinatedReleaseAppPlatforms)) {
        Stop-CoordinatedRelease "unsupported coordinated platform '$Platform'"
    }
    $kind = Get-CoordinatedReleaseAliasValue $Destination @('kind', 'destination') `
        "$Platform tester destination kind"
    if ($Platform -eq 'android') {
        $track = Get-CoordinatedReleaseAliasValue $Destination @('track', 'google_track') `
            'Android tester destination track'
        if ($kind -notin @('google-play-internal', 'google-play') -or $track -cne 'internal') {
            Stop-CoordinatedRelease 'Android tester destination must use Google Play internal track internal'
        }
        return [pscustomobject][ordered]@{
            kind = 'google-play-internal'
            track = 'internal'
        }
    }
    $groupType = (Get-CoordinatedReleaseAliasValue $Destination @('group_type', 'groupType') `
        'iOS TestFlight group type').ToLowerInvariant()
    $groupId = Get-CoordinatedReleaseAliasValue $Destination @('group_id', 'groupId') `
        'iOS TestFlight group ID'
    if ($kind -cne 'testflight' -or $groupType -notin @('internal', 'external') -or
        $groupId -notmatch '^[A-Za-z0-9-]+$') {
        Stop-CoordinatedRelease 'iOS tester destination must identify a TestFlight internal or external group'
    }
    $publicLink = Get-CoordinatedReleaseAliasValue $Destination @('public_link', 'publicLink') `
        'TestFlight public link' -Optional
    if ($groupType -eq 'external') {
        if ($publicLink -notmatch '^https://testflight\.apple\.com/join/[A-Za-z0-9]+$') {
            Stop-CoordinatedRelease 'external TestFlight destination requires its existing public link'
        }
    } elseif ($null -ne $publicLink -and $publicLink -ne '') {
        Stop-CoordinatedRelease 'internal TestFlight destination must not include a public link'
    }
    $normalized = [ordered]@{
        kind = 'testflight'
        group_type = $groupType
        group_id = $groupId
    }
    if ($groupType -eq 'external') { $normalized.public_link = $publicLink }
    return [pscustomobject]$normalized
}

function Get-CoordinatedReleaseTesterDestination {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string]$Platform
    )
    $candidate = Get-CoordinatedProperty $Value 'candidate' $null
    if ($null -eq $candidate) { $candidate = $Value }
    $destination = $null
    foreach ($container in @($candidate, $Value)) {
        if ($null -ne $destination) { break }
        foreach ($name in @('tester_destination', 'testerDestination', 'testing')) {
            $supplied = Get-CoordinatedProperty $container $name $null
            if ($null -ne $supplied) { $destination = $supplied; break }
        }
    }
    return Normalize-CoordinatedReleaseTesterDestination $Platform $destination
}

function Assert-CoordinatedReleaseTesterDestinationBinding {
    param(
        [Parameter(Mandatory = $true)]$Actual,
        [Parameter(Mandatory = $true)]$Expected,
        [Parameter(Mandatory = $true)][string]$Platform
    )
    $actualDestination = Normalize-CoordinatedReleaseTesterDestination $Platform $Actual
    $expectedDestination = Normalize-CoordinatedReleaseTesterDestination $Platform $Expected
    if (($actualDestination | ConvertTo-Json -Depth 8 -Compress) -cne
        ($expectedDestination | ConvertTo-Json -Depth 8 -Compress)) {
        Stop-CoordinatedRelease "$Platform tester destination changed for the coordinated candidate"
    }
    return $expectedDestination
}

function Get-CoordinatedReleaseCandidateIdentity {
    param(
        [Parameter(Mandatory = $true)]$App,
        [Parameter(Mandatory = $true)][string]$Platform
    )
    $candidate = Get-CoordinatedProperty $App 'candidate' $null
    if ($null -eq $candidate) { $candidate = $App }
    $toolingApproval = Get-CoordinatedProperty $candidate 'toolingApproval' $null
    $toolSha = [string](Get-CoordinatedProperty $candidate 'toolSha' '')
    if (-not $toolSha) { $toolSha = [string](Get-CoordinatedProperty $candidate 'tooling_sha' '') }
    if (-not $toolSha -and $null -ne $toolingApproval) {
        $toolSha = [string](Get-CoordinatedProperty $toolingApproval 'toolSha' '')
    }
    if (-not $toolSha) { $toolSha = [string](Get-CoordinatedProperty $App 'tooling_sha' '') }
    if (-not $toolSha) { $toolSha = [string](Get-CoordinatedProperty $App 'toolSha' '') }
    $metadataHash = [string](Get-CoordinatedProperty $candidate 'metadataHash' '')
    if (-not $metadataHash) { $metadataHash = [string](Get-CoordinatedProperty $candidate 'metadata_sha256' '') }
    if (-not $metadataHash) {
        $metadataHash = [string](Get-CoordinatedProperty $App 'metadata_sha256' '')
    }
    $countries = @(Get-CoordinatedProperty $candidate 'countries' @())
    if ($countries.Count -eq 0) { $countries = @(Get-CoordinatedProperty $App 'countries' @()) }
    $rollout = Get-CoordinatedProperty $candidate 'rollout' $null
    if ($null -eq $rollout) { $rollout = Get-CoordinatedProperty $App 'rollout' $null }
    $releaseId = [string](Get-CoordinatedProperty $candidate 'releaseId' '')
    if (-not $releaseId) { $releaseId = [string](Get-CoordinatedProperty $candidate 'release_id' '') }
    if (-not $releaseId) { $releaseId = [string](Get-CoordinatedProperty $App 'release_id' '') }
    $sourceSha = [string](Get-CoordinatedProperty $candidate 'sourceSha' '')
    if (-not $sourceSha) { $sourceSha = [string](Get-CoordinatedProperty $candidate 'source_sha' '') }
    if (-not $sourceSha) { $sourceSha = [string](Get-CoordinatedProperty $App 'source_sha' '') }
    $generation = [string](Get-CoordinatedProperty $candidate 'generation' '')
    if (-not $generation) { $generation = [string](Get-CoordinatedProperty $App 'generation' '') }
    $marketingVersion = [string](Get-CoordinatedProperty $candidate 'marketingVersion' '')
    if (-not $marketingVersion) {
        $marketingVersion = [string](Get-CoordinatedProperty $candidate 'marketing_version' '')
    }
    if (-not $marketingVersion) {
        $marketingVersion = [string](Get-CoordinatedProperty $App 'marketing_version' '')
    }
    $build = Get-CoordinatedProperty $candidate 'build' $null
    if ($null -eq $build) { $build = Get-CoordinatedProperty $App 'build' $null }
    $storeBuildId = [string](Get-CoordinatedProperty $candidate 'storeBuildId' '')
    if (-not $storeBuildId) { $storeBuildId = [string](Get-CoordinatedProperty $candidate 'store_build_id' '') }
    if (-not $storeBuildId) {
        $storeBuildId = [string](Get-CoordinatedProperty $App 'store_build_id' '')
    }
    $artifactSha256 = [string](Get-CoordinatedProperty $candidate 'artifactSha256' '')
    if (-not $artifactSha256) { $artifactSha256 = [string](Get-CoordinatedProperty $candidate 'artifact_sha256' '') }
    if (-not $artifactSha256) {
        $artifactSha256 = [string](Get-CoordinatedProperty $App 'artifact_sha256' '')
    }
    $identity = [pscustomobject][ordered]@{
        platform = $Platform
        release_id = $releaseId
        source_sha = $sourceSha
        generation = $generation
        marketing_version = $marketingVersion
        build = $build
        store_build_id = $storeBuildId
        artifact_sha256 = $artifactSha256
        tooling_sha = $toolSha
        metadata_sha256 = $metadataHash
        countries = @($countries | ForEach-Object { [string]$_ } | Sort-Object)
        rollout = if ($null -eq $rollout) { $null } else {
            $rollout | ConvertTo-Json -Depth 12 | ConvertFrom-Json
        }
    }
    $testerDestination = Get-CoordinatedReleaseTesterDestination $App $Platform
    if ($null -ne $testerDestination) {
        $identity | Add-Member -NotePropertyName tester_destination -NotePropertyValue $testerDestination
    }
    return $identity
}

function Assert-CoordinatedReleaseAppIdentity {
    param(
        [Parameter(Mandatory = $true)]$App,
        [Parameter(Mandatory = $true)][string]$Platform,
        [Parameter(Mandatory = $true)][string]$PinnedGeneration,
        [Parameter(Mandatory = $true)][string]$PinnedServerSha
    )
    $identity = Get-CoordinatedReleaseCandidateIdentity $App $Platform
    if ([string]$identity.platform -cne $Platform) {
        Stop-CoordinatedRelease "$Platform candidate platform does not match its manifest key"
    }
    Assert-CoordinatedPattern ([string]$identity.release_id) '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$' "$Platform release ID"
    Assert-CoordinatedPattern ([string]$identity.source_sha) '^[0-9a-f]{40}$' "$Platform source SHA"
    Assert-CoordinatedPattern ([string]$identity.generation) '^t\d{3,4}$' "$Platform generation"
    Assert-CoordinatedPattern ([string]$identity.artifact_sha256) '^[0-9a-f]{64}$' "$Platform artifact SHA256"
    Assert-CoordinatedPattern ([string]$identity.tooling_sha) '^[0-9a-f]{40}$' "$Platform tooling SHA"
    Assert-CoordinatedPattern ([string]$identity.metadata_sha256) '^[0-9a-f]{64}$' "$Platform metadata SHA256"
    if ([string]$identity.source_sha -cne $PinnedServerSha -or
        [string]$identity.generation -cne $PinnedGeneration) {
        Stop-CoordinatedRelease "$Platform candidate is not bound to the pinned server generation"
    }
    if ([string]$identity.marketing_version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') {
        Stop-CoordinatedRelease "$Platform marketing version is invalid"
    }
    $parsedBuild = 0L
    if ($null -eq $identity.build -or -not ([int64]::TryParse([string]$identity.build, [ref]$parsedBuild)) -or
        $parsedBuild -le 0) {
        Stop-CoordinatedRelease "$Platform build is invalid"
    }
    if (-not [string]$identity.store_build_id) {
        Stop-CoordinatedRelease "$Platform store build ID is required"
    }
    $countries = @($identity.countries)
    if ($countries.Count -eq 0 -or @($countries | Where-Object { $_ -notmatch '^[A-Z]{2}$' }).Count -ne 0 -or
        @($countries | Sort-Object -Unique).Count -ne $countries.Count) {
        Stop-CoordinatedRelease "$Platform countries are invalid"
    }
    $rollout = $identity.rollout
    if ($null -eq $rollout -or [string](Get-CoordinatedProperty $rollout 'kind' '') -notin @('first-publish', 'update') -or
        [string](Get-CoordinatedProperty $rollout 'mode' '') -notin @('manual', 'staged', 'full')) {
        Stop-CoordinatedRelease "$Platform rollout policy is invalid"
    }
    if ([string](Get-CoordinatedProperty $rollout 'mode' '') -eq 'staged') {
        $fraction = Get-CoordinatedProperty $rollout 'fraction' $null
        if ($null -eq $fraction -or [double]$fraction -le 0 -or [double]$fraction -ge 1) {
            Stop-CoordinatedRelease "$Platform staged rollout fraction is invalid"
        }
    }
    if ($Platform -eq 'android' -and [string](Get-CoordinatedProperty $rollout 'kind' '') -eq 'first-publish' -and
        [string](Get-CoordinatedProperty $rollout 'mode' '') -ne 'full') {
        Stop-CoordinatedRelease 'Google first publication must use a full rollout'
    }
    return $identity
}

function New-CoordinatedReleaseManifest {
    param(
        [Parameter(Mandatory = $true)][string]$OperationId,
        [Parameter(Mandatory = $true)][string]$PinnedGeneration,
        [Parameter(Mandatory = $true)][string]$PinnedServerSha,
        [Parameter(Mandatory = $true)][string]$AcceptedMasterSha,
        [Parameter(Mandatory = $true)][string]$CurrentServerSha,
        [Parameter(Mandatory = $true)]$Apps,
        [string]$AcceptedIntegrationSha = '',
        [string]$Source = 'coordinated-release',
        [string]$DeliveryMode = 'production'
    )
    $deliveryMode = Get-CoordinatedReleaseDeliveryMode $DeliveryMode
    Assert-CoordinatedPattern $OperationId '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$' 'coordinated operation ID'
    Assert-CoordinatedPattern $PinnedGeneration '^t\d{3,4}$' 'pinned generation'
    Assert-CoordinatedPattern $PinnedServerSha '^[0-9a-f]{40}$' 'pinned server SHA'
    Assert-CoordinatedPattern $AcceptedMasterSha '^[0-9a-f]{40}$' 'accepted master SHA'
    Assert-CoordinatedPattern $CurrentServerSha '^[0-9a-f]{40}$' 'current server SHA'
    if ($AcceptedIntegrationSha) {
        Assert-CoordinatedPattern $AcceptedIntegrationSha '^[0-9a-f]{40}$' 'accepted integration SHA'
        if ($AcceptedIntegrationSha -cne $PinnedServerSha) {
            Stop-CoordinatedRelease 'accepted integration SHA must equal the pinned server SHA'
        }
    }
    if ($CurrentServerSha -cne $PinnedServerSha -and $CurrentServerSha -notmatch '^[0-9a-f]{40}$') {
        Stop-CoordinatedRelease 'current server SHA is not canonical'
    }
    $platformEntries = [ordered]@{}
    foreach ($platform in @(Get-CoordinatedReleaseAppPlatforms)) {
        $entry = Get-CoordinatedProperty $Apps $platform $null
        if ($null -eq $entry) {
            Stop-CoordinatedRelease "coordinated manifest must include $platform"
        }
        $identity = Assert-CoordinatedReleaseAppIdentity $entry $platform $PinnedGeneration $PinnedServerSha
        $testerDestination = Get-CoordinatedReleaseTesterDestination $entry $platform
        if ($deliveryMode -eq 'daily-testers' -and $null -eq $testerDestination) {
            Stop-CoordinatedRelease "$platform daily tester destination is required in the immutable seed"
        }
        if ($deliveryMode -eq 'production' -and $null -ne $testerDestination) {
            Stop-CoordinatedRelease "$platform tester destination requires daily-testers delivery mode"
        }
        $childOperationId = [string](Get-CoordinatedProperty $entry 'child_operation_id' '')
        if (-not $childOperationId) {
            $childOperationId = [string](Get-CoordinatedProperty $entry 'childOperationId' '')
        }
        if (-not $childOperationId) {
            $childOperationId = [string](Get-CoordinatedProperty $entry 'operation_id' '')
        }
        if (-not $childOperationId) {
            $childOperationId = "${OperationId}:$platform"
        }
        Assert-CoordinatedPattern $childOperationId '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$' "$platform child operation ID"
        if ($childOperationId -cne "${OperationId}:$platform") {
            Stop-CoordinatedRelease "$platform child operation ID must be '${OperationId}:$platform'"
        }
        $managedPublishing = [bool](Get-CoordinatedProperty $entry 'managed_publishing' $false)
        $firstPublish = [string](Get-CoordinatedProperty $identity.rollout 'kind' '') -eq 'first-publish'
        $seedReady = [bool](Get-CoordinatedProperty $entry 'ready' $false)
        $seedSubmitted = [bool](Get-CoordinatedProperty $entry 'submitted' $false)
        $storeStatus = [string](Get-CoordinatedProperty $entry 'store_status' '')
        if ($deliveryMode -eq 'daily-testers' -and $seedReady) {
            # A trusted daily seed proves the exact candidate was prepared.  The
            # server still waits for a post-health tester receipt before it can
            # complete the operation.
            $seedSubmitted = $true
            if (-not $storeStatus) { $storeStatus = 'TESTER_PREPARED' }
        }
        $platformEntry = [ordered]@{
            platform = $platform
            candidate = $identity
            child_operation_id = $childOperationId
            submitted = $seedSubmitted
            ready = $seedReady
            approval = [pscustomobject][ordered]@{
                approved = [bool](Get-CoordinatedProperty (Get-CoordinatedProperty $entry 'approval' $null) 'approved' $false)
                fingerprint = [string](Get-CoordinatedProperty (Get-CoordinatedProperty $entry 'approval' $null) 'fingerprint' '')
                candidate_fingerprint = [string](Get-CoordinatedProperty (Get-CoordinatedProperty $entry 'approval' $null) 'candidate_fingerprint' '')
                metadata_sha256 = [string]$identity.metadata_sha256
                countries = @($identity.countries)
                rollout = $identity.rollout
            }
            store_status = $storeStatus
            managed_publishing = $managedPublishing
            first_publication_bootstrap_verified = [bool](Get-CoordinatedProperty $entry 'first_publication_bootstrap_verified' $false)
            release_requested = $false
            public_available = $false
            public_status = ''
            tester_available = $false
            tester_status = ''
            tester_observed_after_server_health = $false
            first_publish = $firstPublish
            last_evidence_fingerprint = ''
            last_observed_at_utc = ''
        }
        $platformEntries[$platform] = [pscustomobject]$platformEntry
    }
    $now = (Get-Date).ToUniversalTime().ToString('o')
    return [pscustomobject][ordered]@{
        schema_version = 1
        kind = 'ash-atlas-coordinated-release'
        operation_id = $OperationId
        source = $Source
        delivery_mode = $deliveryMode
        created_at_utc = $now
        updated_at_utc = $now
        current_phase = 'manifest_created'
        pinned = [pscustomobject][ordered]@{
            generation = $PinnedGeneration
            generation_tag = "test/$PinnedGeneration"
            server_sha = $PinnedServerSha
            accepted_integration_sha = if ($AcceptedIntegrationSha) { $AcceptedIntegrationSha } else { $PinnedServerSha }
            accepted_master_sha = $AcceptedMasterSha
            current_server_sha = $CurrentServerSha
        }
        server = [pscustomobject][ordered]@{
            old_server_sha = $CurrentServerSha
            candidate_sha = $PinnedServerSha
            generation = $PinnedGeneration
            published = $false
            activated = $false
            healthy = $false
            public_release_sha = ''
        }
        apps = [pscustomobject]$platformEntries
        completion = [pscustomobject][ordered]@{
            status = 'waiting_for_mobile'
            waiting_reason = if ($deliveryMode -eq 'daily-testers') {
                'both exact mobile candidates must be prepared for their configured TestFlight group and Google Play qa track before server publication'
            } else {
                'both exact mobile candidates must be submitted and approved before server publication'
            }
            completed_at_utc = ''
        }
    }
}

function Assert-CoordinatedReleaseManifest {
    param([Parameter(Mandatory = $true)]$Manifest)
    if ([int](Get-CoordinatedProperty $Manifest 'schema_version' 0) -ne 1 -or
        [string](Get-CoordinatedProperty $Manifest 'kind' '') -cne 'ash-atlas-coordinated-release') {
        Stop-CoordinatedRelease 'coordinated manifest schema is unsupported'
    }
    $operationId = [string](Get-CoordinatedProperty $Manifest 'operation_id' '')
    Assert-CoordinatedPattern $operationId '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$' 'coordinated operation ID'
    $pinned = Get-CoordinatedProperty $Manifest 'pinned' $null
    if ($null -eq $pinned) { Stop-CoordinatedRelease 'coordinated manifest has no pinned identity' }
    $generation = [string](Get-CoordinatedProperty $pinned 'generation' '')
    $serverSha = [string](Get-CoordinatedProperty $pinned 'server_sha' '')
    $masterSha = [string](Get-CoordinatedProperty $pinned 'accepted_master_sha' '')
    $currentServerSha = [string](Get-CoordinatedProperty $pinned 'current_server_sha' '')
    Assert-CoordinatedPattern $generation '^t\d{3,4}$' 'pinned generation'
    Assert-CoordinatedPattern $serverSha '^[0-9a-f]{40}$' 'pinned server SHA'
    Assert-CoordinatedPattern $masterSha '^[0-9a-f]{40}$' 'accepted master SHA'
    Assert-CoordinatedPattern $currentServerSha '^[0-9a-f]{40}$' 'current server SHA'
    $acceptedIntegration = [string](Get-CoordinatedProperty $pinned 'accepted_integration_sha' '')
    Assert-CoordinatedPattern $acceptedIntegration '^[0-9a-f]{40}$' 'accepted integration SHA'
    if ($acceptedIntegration -cne $serverSha) {
        Stop-CoordinatedRelease 'accepted integration SHA must equal the pinned server SHA'
    }
    $deliveryMode = Get-CoordinatedReleaseDeliveryMode $Manifest
    $apps = Get-CoordinatedProperty $Manifest 'apps' $null
    if ($null -eq $apps) { Stop-CoordinatedRelease 'coordinated manifest has no mobile app identities' }
    foreach ($platform in @(Get-CoordinatedReleaseAppPlatforms)) {
        $entry = Get-CoordinatedProperty $apps $platform $null
        if ($null -eq $entry) { Stop-CoordinatedRelease "coordinated manifest is missing $platform" }
        Assert-CoordinatedReleaseAppIdentity $entry $platform $generation $serverSha | Out-Null
        $childId = [string](Get-CoordinatedProperty $entry 'child_operation_id' '')
        Assert-CoordinatedPattern $childId '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$' "$platform child operation ID"
        if ($childId -cne "$operationId`:$platform") {
            Stop-CoordinatedRelease "$platform child operation ID must be '$operationId`:$platform'"
        }
        $candidate = Get-CoordinatedProperty $entry 'candidate' $entry
        $testerDestination = Get-CoordinatedReleaseTesterDestination $entry $platform
        if ($deliveryMode -eq 'daily-testers' -and $null -eq $testerDestination) {
            Stop-CoordinatedRelease "$platform daily tester destination is missing from the durable manifest"
        }
        if ($deliveryMode -eq 'production' -and $null -ne $testerDestination) {
            Stop-CoordinatedRelease "$platform tester destination requires daily-testers delivery mode"
        }
        $candidateDestination = Get-CoordinatedReleaseTesterDestination $candidate $platform
        if (($null -eq $testerDestination) -ne ($null -eq $candidateDestination)) {
            Stop-CoordinatedRelease "$platform tester destination is not bound to the candidate identity"
        }
        if ($null -ne $testerDestination) {
            Assert-CoordinatedReleaseTesterDestinationBinding $candidateDestination $testerDestination $platform | Out-Null
        }
        if ($deliveryMode -eq 'daily-testers' -and
            $null -ne (Get-CoordinatedProperty $entry 'tester_available' $null) -and
            [bool](Get-CoordinatedProperty $entry 'tester_available' $false) -and
            -not [bool](Get-CoordinatedProperty $entry 'tester_observed_after_server_health' $false)) {
            Stop-CoordinatedRelease "$platform tester availability is missing post-health observation proof"
        }
        $countries = @(Get-CoordinatedProperty $candidate 'countries' @())
        if (@($countries | Where-Object { $_ -notmatch '^[A-Z]{2}$' }).Count -ne 0) {
            Stop-CoordinatedRelease "$platform country approval is invalid"
        }
    }
    $phase = [string](Get-CoordinatedProperty $Manifest 'current_phase' '')
    Get-CoordinatedReleasePhaseIndex $phase | Out-Null
    return $Manifest
}

function New-CoordinatedReleaseManifestFromSeed {
    param([Parameter(Mandatory = $true)]$Seed)
    if ([int](Get-CoordinatedProperty $Seed 'schema_version' 0) -ne 1 -or
        [string](Get-CoordinatedProperty $Seed 'kind' '') -cne 'ash-atlas-coordinated-release-seed') {
        Stop-CoordinatedRelease 'coordinated bootstrap seed schema is unsupported'
    }
    $pinned = Get-CoordinatedProperty $Seed 'pinned' $null
    $apps = Get-CoordinatedProperty $Seed 'apps' $null
    if ($null -eq $pinned -or $null -eq $apps) {
        Stop-CoordinatedRelease 'coordinated bootstrap seed must include pinned server and both app identities'
    }
    $deliveryMode = Get-CoordinatedReleaseDeliveryMode $Seed
    return New-CoordinatedReleaseManifest `
        -OperationId ([string](Get-CoordinatedProperty $Seed 'operation_id' '')) `
        -PinnedGeneration ([string](Get-CoordinatedProperty $pinned 'generation' '')) `
        -PinnedServerSha ([string](Get-CoordinatedProperty $pinned 'server_sha' '')) `
        -AcceptedMasterSha ([string](Get-CoordinatedProperty $pinned 'accepted_master_sha' '')) `
        -CurrentServerSha ([string](Get-CoordinatedProperty $pinned 'current_server_sha' '')) `
        -AcceptedIntegrationSha ([string](Get-CoordinatedProperty $pinned 'accepted_integration_sha' '')) `
        -Apps $apps `
        -Source ([string](Get-CoordinatedProperty $Seed 'source' 'mobile-bootstrap')) `
        -DeliveryMode $deliveryMode
}

function Get-CoordinatedReleaseManifestPath {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$OperationId
    )
    Assert-CoordinatedPattern $OperationId '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$' 'coordinated operation ID'
    return Join-Path ([IO.Path]::GetFullPath($Root).TrimEnd('\')) "$OperationId.coordinated-manifest.json"
}

function Get-CoordinatedReleaseJournalPath {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$OperationId
    )
    Assert-CoordinatedPattern $OperationId '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$' 'coordinated operation ID'
    return Join-Path ([IO.Path]::GetFullPath($Root).TrimEnd('\')) "$OperationId.coordinated-journal.json"
}

function Write-CoordinatedReleaseJson {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Value
    )
    $directory = Split-Path -Parent $Path
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $temporary = "$Path.$PID.tmp"
    try {
        $Value | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $temporary -Encoding utf8
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    } finally {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        }
    }
}

function ConvertTo-CoordinatedCanonicalJson {
    param([AllowNull()]$Value)
    if ($null -eq $Value) { return 'null' }
    if ($Value -is [string]) { return ($Value | ConvertTo-Json -Compress) }
    if ($Value -is [bool]) { return $(if ($Value) { 'true' } else { 'false' }) }
    if ($Value -is [System.Collections.IDictionary]) {
        $keys = [string[]]@($Value.Keys | ForEach-Object { [string]$_ })
        if ($keys.Count -gt 1) { [Array]::Sort($keys, [StringComparer]::Ordinal) }
        $pairs = @($keys | ForEach-Object {
                $key = $_
                '{0}:{1}' -f ($key | ConvertTo-Json -Compress),
                    (ConvertTo-CoordinatedCanonicalJson $Value[$_])
            })
        return '{' + ($pairs -join ',') + '}'
    }
    if ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [string]) {
        return '[' + (@($Value | ForEach-Object { ConvertTo-CoordinatedCanonicalJson $_ }) -join ',') + ']'
    }
    if ($Value -is [ValueType]) {
        return ($Value | ConvertTo-Json -Compress)
    }
    $properties = @($Value.PSObject.Properties)
    $keys = [string[]]@($properties | ForEach-Object { [string]$_.Name })
    if ($keys.Count -gt 1) { [Array]::Sort($keys, [StringComparer]::Ordinal) }
    $pairs = @($keys | ForEach-Object {
            $property = $Value.PSObject.Properties[$_]
            '{0}:{1}' -f ($_.ToString() | ConvertTo-Json -Compress),
                (ConvertTo-CoordinatedCanonicalJson $property.Value)
        })
    return '{' + ($pairs -join ',') + '}'
}

function Get-CoordinatedSha256Text {
    param([Parameter(Mandatory = $true)][string]$Text)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString(
                $algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)))).Replace('-', '').ToLowerInvariant()
    } finally { $algorithm.Dispose() }
}

function Get-CoordinatedHmacSha256Text {
    param(
        [Parameter(Mandatory = $true)][string]$Text,
        [Parameter(Mandatory = $true)][byte[]]$Key
    )
    $algorithm = [Security.Cryptography.HMACSHA256]::new($Key)
    try {
        return ([BitConverter]::ToString(
                $algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)))).Replace('-', '').ToLowerInvariant()
    } finally { $algorithm.Dispose() }
}

function Read-CoordinatedReleaseJson {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try { return Get-Content -Raw -LiteralPath $Path -Encoding utf8 | ConvertFrom-Json }
    catch { Stop-CoordinatedRelease "coordinated release JSON is unreadable: $($_.Exception.Message)" }
}

function Write-CoordinatedReleaseManifest {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)][string]$Root
    )
    Assert-CoordinatedReleaseManifest $Manifest | Out-Null
    $Manifest.updated_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    Write-CoordinatedReleaseJson (Get-CoordinatedReleaseManifestPath $Root ([string]$Manifest.operation_id)) $Manifest
    return $Manifest
}

function Read-CoordinatedReleaseManifest {
    param(
        [Parameter(Mandatory = $true)][string]$Path
    )
    $manifest = Read-CoordinatedReleaseJson $Path
    if ($null -eq $manifest) { Stop-CoordinatedRelease "coordinated manifest was not found: $Path" }
    Assert-CoordinatedReleaseManifest $manifest | Out-Null
    return $manifest
}

function Read-CoordinatedReleaseJournal {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$OperationId
    )
    $journal = Read-CoordinatedReleaseJson (Get-CoordinatedReleaseJournalPath $Root $OperationId)
    if ($null -eq $journal) { return @() }
    if ($journal -is [Array]) { return @($journal) }
    return @($journal)
}

function Write-CoordinatedReleaseJournal {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$OperationId,
        [Parameter(Mandatory = $true)][AllowNull()]$Journal
    )
    Write-CoordinatedReleaseJson (Get-CoordinatedReleaseJournalPath $Root $OperationId) @($Journal)
    return @($Journal)
}

function Add-CoordinatedReleaseJournalEntry {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Event,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Detail,
        [Parameter(Mandatory = $true)][AllowNull()]$Journal
    )
    Assert-CoordinatedReleaseManifest $Manifest | Out-Null
    $entries = @($Journal)
    $sequence = $entries.Count + 1
    $entry = [pscustomobject][ordered]@{
        schema_version = 1
        sequence = $sequence
        operation_id = [string]$Manifest.operation_id
        phase = [string]$Manifest.current_phase
        event = $Event
        detail = $Detail
        observed_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    }
    return @($entries + $entry)
}

function Get-CoordinatedReleaseExpectedApprovalFingerprint {
    param(
        [Parameter(Mandatory = $true)]$App,
        [Parameter(Mandatory = $true)][string]$Platform
    )
    $identity = Get-CoordinatedReleaseCandidateIdentity $App $Platform
    $packet = [ordered]@{
        platform = $Platform
        release_id = $identity.release_id
        source_sha = $identity.source_sha
        generation = $identity.generation
        marketing_version = $identity.marketing_version
        build = $identity.build
        store_build_id = $identity.store_build_id
        artifact_sha256 = $identity.artifact_sha256
        tooling_sha = $identity.tooling_sha
        metadata_sha256 = $identity.metadata_sha256
        countries = @($identity.countries)
        rollout = $identity.rollout
    }
    $json = $packet | ConvertTo-Json -Depth 16 -Compress
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($json)))).Replace('-', '').ToLowerInvariant()
    } finally { $algorithm.Dispose() }
}

function Test-CoordinatedReleaseAppsSubmitted {
    param([Parameter(Mandatory = $true)]$Manifest)
    Assert-CoordinatedReleaseManifest $Manifest | Out-Null
    foreach ($platform in @(Get-CoordinatedReleaseAppPlatforms)) {
        $entry = Get-CoordinatedProperty $Manifest.apps $platform $null
        if (-not [bool](Get-CoordinatedProperty $entry 'submitted' $false)) { return $false }
        $status = [string](Get-CoordinatedProperty $entry 'store_status' '')
        if (-not $status -or $status -in @('draft', 'pending_submission', 'not_submitted')) { return $false }
    }
    return $true
}

function Test-CoordinatedReleaseAppReady {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)][string]$Platform
    )
    Assert-CoordinatedReleaseManifest $Manifest | Out-Null
    if ($Platform -notin @(Get-CoordinatedReleaseAppPlatforms)) {
        Stop-CoordinatedRelease "unsupported coordinated platform '$Platform'"
    }
    $entry = Get-CoordinatedProperty $Manifest.apps $Platform $null
    $identity = Assert-CoordinatedReleaseAppIdentity $entry $Platform `
        ([string]$Manifest.pinned.generation) ([string]$Manifest.pinned.server_sha)
    if ((Get-CoordinatedReleaseDeliveryMode $Manifest) -eq 'daily-testers') {
        $destination = Get-CoordinatedReleaseTesterDestination $entry $Platform
        if ($null -eq $destination -or -not [bool](Get-CoordinatedProperty $entry 'ready' $false)) {
            return $false
        }
        $manifestDestination = Get-CoordinatedProperty $identity 'tester_destination' $null
        if ($null -eq $manifestDestination) { return $false }
        Assert-CoordinatedReleaseTesterDestinationBinding $destination $manifestDestination $Platform | Out-Null
        return $true
    }
    $publicStatus = [string](Get-CoordinatedProperty $entry 'public_status' '')
    $publicAvailable = [bool](Get-CoordinatedProperty $entry 'public_available' $false)
    $publicState = if ($Platform -eq 'ios') {
        $publicStatus -in @('READY_FOR_SALE', 'READY_FOR_DISTRIBUTION')
    } else {
        $publicStatus -eq 'RELEASE_LIFECYCLE_STATE_PUBLISHED'
    }
    if ($publicAvailable -and $publicState -and
        [bool](Get-CoordinatedProperty $entry 'release_requested' $false)) {
        # Store state is monotonic.  A public candidate has already passed the
        # pre-publication readiness gate, so a later Resume must not require the
        # transient approval status again.
        return $true
    }
    $expectedStatus = if ($Platform -eq 'ios') { 'PENDING_DEVELOPER_RELEASE' } else {
        'RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED'
    }
    if (-not [bool](Get-CoordinatedProperty $entry 'submitted' $false) -or
        [string](Get-CoordinatedProperty $entry 'store_status' '') -cne $expectedStatus) {
        return $false
    }
    $approval = Get-CoordinatedProperty $entry 'approval' $null
    if ($null -eq $approval -or -not [bool](Get-CoordinatedProperty $approval 'approved' $false) -or
        [string](Get-CoordinatedProperty $approval 'metadata_sha256' '') -cne [string]$identity.metadata_sha256) {
        return $false
    }
    $approvalCountries = @(Get-CoordinatedProperty $approval 'countries' @()) | ForEach-Object { [string]$_ } | Sort-Object
    if (($approvalCountries -join ',') -ne (@($identity.countries | Sort-Object) -join ',')) { return $false }
    $approvalRollout = Get-CoordinatedProperty $approval 'rollout' $null
    if ($null -eq $approvalRollout -or
        ($approvalRollout | ConvertTo-Json -Depth 16 -Compress) -cne
        ($identity.rollout | ConvertTo-Json -Depth 16 -Compress)) { return $false }
    $expectedFingerprint = Get-CoordinatedReleaseExpectedApprovalFingerprint $entry $Platform
    $approvalFingerprint = [string](Get-CoordinatedProperty $approval 'fingerprint' '')
    $candidateFingerprint = [string](Get-CoordinatedProperty $approval 'candidate_fingerprint' '')
    if ($approvalFingerprint -cne $expectedFingerprint -and $candidateFingerprint -cne $expectedFingerprint) {
        return $false
    }
    if ($approvalFingerprint -and $approvalFingerprint -cne $expectedFingerprint) {
        return $false
    }
    if ($candidateFingerprint -and $candidateFingerprint -cne $expectedFingerprint) {
        return $false
    }
    if ($Platform -eq 'android' -and -not [bool](Get-CoordinatedProperty $entry 'managed_publishing' $false)) {
        return $false
    }
    if ([bool](Get-CoordinatedProperty $entry 'first_publish' $false) -and
        -not [bool](Get-CoordinatedProperty $entry 'first_publication_bootstrap_verified' $false)) {
        return $false
    }
    return $true
}

function Test-CoordinatedReleaseAppsReady {
    param([Parameter(Mandatory = $true)]$Manifest)
    return (Test-CoordinatedReleaseAppReady $Manifest 'ios') -and
        (Test-CoordinatedReleaseAppReady $Manifest 'android')
}

function Test-CoordinatedReleasePrePublicationAppReady {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)][string]$Platform
    )
    Assert-CoordinatedReleaseManifest $Manifest | Out-Null
    $entry = Get-CoordinatedProperty $Manifest.apps $Platform $null
    if ((Get-CoordinatedReleaseDeliveryMode $Manifest) -eq 'daily-testers' -and
        [bool](Get-CoordinatedProperty $entry 'tester_available' $false)) {
        # Tester availability observed before server health is preparation data;
        # it cannot authorize a post-health activation or completion.
        return $false
    }
    $publicStatus = [string](Get-CoordinatedProperty $entry 'public_status' '')
    $publicAvailable = [bool](Get-CoordinatedProperty $entry 'public_available' $false)
    $publicState = if ($Platform -eq 'ios') {
        $publicStatus -in @('READY_FOR_SALE', 'READY_FOR_DISTRIBUTION')
    } else {
        $publicStatus -eq 'RELEASE_LIFECYCLE_STATE_PUBLISHED'
    }
    if ($publicAvailable -or $publicState -or
        [bool](Get-CoordinatedProperty $entry 'release_requested' $false)) {
        return $false
    }
    return Test-CoordinatedReleaseAppReady $Manifest $Platform
}

function Test-CoordinatedReleasePrePublicationAppsReady {
    param([Parameter(Mandatory = $true)]$Manifest)
    return (Test-CoordinatedReleasePrePublicationAppReady $Manifest 'ios') -and
        (Test-CoordinatedReleasePrePublicationAppReady $Manifest 'android')
}

function Assert-CoordinatedReleaseActivationReadiness {
    param([Parameter(Mandatory = $true)]$Manifest)
    Assert-CoordinatedReleaseManifest $Manifest | Out-Null
    $serverPublished = [bool](Get-CoordinatedProperty $Manifest.server 'published' $false)
    $serverActivated = [bool](Get-CoordinatedProperty $Manifest.server 'activated' $false)
    if ($serverPublished -and -not $serverActivated -and
        -not (Test-CoordinatedReleaseAppsReady $Manifest)) {
        Stop-CoordinatedRelease 'new server activation requires current exact Apple and Google readiness evidence'
    }
    return $Manifest
}

function Test-CoordinatedReleaseAppsPublic {
    param([Parameter(Mandatory = $true)]$Manifest)
    Assert-CoordinatedReleaseManifest $Manifest | Out-Null
    if ((Get-CoordinatedReleaseDeliveryMode $Manifest) -eq 'daily-testers') {
        foreach ($platform in @(Get-CoordinatedReleaseAppPlatforms)) {
            $entry = Get-CoordinatedProperty $Manifest.apps $platform $null
            $destination = Get-CoordinatedReleaseTesterDestination $entry $platform
            if ($null -eq $destination -or
                -not [bool](Get-CoordinatedProperty $entry 'tester_available' $false) -or
                -not [bool](Get-CoordinatedProperty $entry 'tester_observed_after_server_health' $false) -or
                -not [bool](Get-CoordinatedProperty $entry 'release_requested' $false) -or
                [bool](Get-CoordinatedProperty $entry 'public_available' $false)) {
                return $false
            }
            $manifestDestination = Get-CoordinatedProperty $entry.candidate 'tester_destination' $null
            Assert-CoordinatedReleaseTesterDestinationBinding $destination $manifestDestination $platform | Out-Null
            $testerStatus = [string](Get-CoordinatedProperty $entry 'tester_status' '')
            if (-not $testerStatus -or ($platform -eq 'android' -and $testerStatus -cne 'completed')) {
                return $false
            }
        }
        return $true
    }
    $ios = Get-CoordinatedProperty $Manifest.apps 'ios' $null
    $android = Get-CoordinatedProperty $Manifest.apps 'android' $null
    $iosPublic = [bool](Get-CoordinatedProperty $ios 'public_available' $false) -and
        [string](Get-CoordinatedProperty $ios 'public_status' '') -in @('READY_FOR_SALE', 'READY_FOR_DISTRIBUTION')
    $androidPublic = [bool](Get-CoordinatedProperty $android 'public_available' $false) -and
        [string](Get-CoordinatedProperty $android 'public_status' '') -eq 'RELEASE_LIFECYCLE_STATE_PUBLISHED'
    return $iosPublic -and $androidPublic
}

function Get-CoordinatedReleaseGate {
    param([Parameter(Mandatory = $true)]$Manifest)
    Assert-CoordinatedReleaseManifest $Manifest | Out-Null
    $phase = [string]$Manifest.current_phase
    $deliveryMode = Get-CoordinatedReleaseDeliveryMode $Manifest
    $prePublication = (Get-CoordinatedReleasePhaseIndex $phase) -lt
        (Get-CoordinatedReleasePhaseIndex 'server_published')
    $appsSubmitted = Test-CoordinatedReleaseAppsSubmitted $Manifest
    $appsReady = if ($prePublication) {
        Test-CoordinatedReleasePrePublicationAppsReady $Manifest
    } else {
        Test-CoordinatedReleaseAppsReady $Manifest
    }
    $appsPublic = Test-CoordinatedReleaseAppsPublic $Manifest
    $serverPublished = [bool](Get-CoordinatedProperty $Manifest.server 'published' $false)
    $serverActivated = [bool](Get-CoordinatedProperty $Manifest.server 'activated' $false)
    $serverHealthy = [bool](Get-CoordinatedProperty $Manifest.server 'healthy' $false)
    $releaseRequestedCount = @(@('ios', 'android') | Where-Object {
            [bool](Get-CoordinatedProperty (Get-CoordinatedProperty $Manifest.apps $_ $null) 'release_requested' $false)
        }).Count
    $releaseRequested = $releaseRequestedCount -eq 2
    $next = if ($prePublication -and -not $appsSubmitted) { 'apps_submitted' }
        elseif ($prePublication -and -not $appsReady) { 'apps_ready' }
        elseif (-not $serverPublished) { 'server_published' }
        elseif (-not $serverActivated) { 'server_activated' }
        elseif (-not $serverHealthy) { 'server_healthy' }
        elseif (-not $releaseRequested) { 'apps_release_requested' }
        elseif (-not $appsPublic) { 'completed' }
        else { 'completed' }
    $reason = if ($prePublication -and -not $appsSubmitted) {
        'both exact mobile child operations must be submitted'
    } elseif ($prePublication -and -not $appsReady) {
        if ($deliveryMode -eq 'daily-testers') {
            'both exact mobile candidates must be prepared and ready for their configured TestFlight group and Google Play qa track'
        } else {
            'Apple must be PENDING_DEVELOPER_RELEASE and Google must be APPROVED_NOT_PUBLISHED with managed publishing'
        }
    } elseif (-not $serverPublished) {
        'pinned server generation is eligible for publication'
    } elseif (-not $serverActivated) {
        'pinned server generation must be activated'
    } elseif (-not $serverHealthy) {
        'server health gate must pass before app release requests'
    } elseif (-not $releaseRequested) {
        'both mobile child operations must record release requests'
    } elseif (-not $appsPublic) {
        if ($deliveryMode -eq 'daily-testers') {
            'both exact TestFlight group and Google Play qa tester availability receipts are required after server health'
        } else {
            'both exact mobile releases must be publicly available'
        }
    } else { 'coordinated release is complete' }
    return [pscustomobject][ordered]@{
        phase = $phase
        delivery_mode = $deliveryMode
        next_phase = $next
        apps_submitted = $appsSubmitted
        apps_ready = $appsReady
        server_published = $serverPublished
        server_activated = $serverActivated
        server_healthy = $serverHealthy
        apps_release_requested = $releaseRequested
        apps_public = $appsPublic
        tester_available = if ($deliveryMode -eq 'daily-testers') { $appsPublic } else { $false }
        allowed = if ($prePublication) { $appsSubmitted -and $appsReady } else { $true }
        reason = $reason
    }
}

function New-CoordinatedServerEvidencePayload {
    param(
        [Parameter(Mandatory = $true)]$State,
        [string]$ExistingNonce,
        [string]$ExistingObservedAtUtc
    )
    $manifest = Get-CoordinatedProperty $State 'coordinated_manifest' $null
    if ($null -eq $manifest) { Stop-CoordinatedRelease 'server evidence requires a coordinated manifest' }
    Assert-CoordinatedReleaseManifest $manifest | Out-Null
    $phase = [string]$manifest.current_phase
    if ((Get-CoordinatedReleasePhaseIndex $phase) -lt
        (Get-CoordinatedReleasePhaseIndex 'server_healthy')) {
        Stop-CoordinatedRelease 'server evidence requires the server_healthy phase'
    }
    $candidates = [ordered]@{}
    foreach ($platform in @(Get-CoordinatedReleaseAppPlatforms)) {
        $entry = Get-CoordinatedProperty $manifest.apps $platform $null
        $candidate = Get-CoordinatedProperty $entry 'candidate' $entry
        $null = $candidates[$platform] = [ordered]@{
            child_operation_id = [string](Get-CoordinatedProperty $entry 'child_operation_id' '')
            candidate = $candidate
            approval_fingerprint = Get-CoordinatedReleaseExpectedApprovalFingerprint $entry $platform
            managed_publishing = [bool](Get-CoordinatedProperty $entry 'managed_publishing' $false)
            first_publication_bootstrap_verified = [bool](Get-CoordinatedProperty $entry 'first_publication_bootstrap_verified' $false)
        }
    }
    $remoteReceipt = Get-CoordinatedProperty $State 'remote_deployment_receipt' $null
    $receiptSha = if ($null -ne $remoteReceipt) {
        Get-CoordinatedSha256Text (ConvertTo-CoordinatedCanonicalJson $remoteReceipt)
    } else { '' }
    $observedAt = if ($ExistingObservedAtUtc) { $ExistingObservedAtUtc } else {
        (Get-Date).ToUniversalTime().ToString('o')
    }
    return [pscustomobject][ordered]@{
        schemaVersion = 1
        kind = 'ash-atlas-coordinated-server-evidence'
        coordinated_operation_id = [string]$manifest.operation_id
        phase = $phase
        source_sha = [string]$manifest.pinned.server_sha
        server_sha = [string]$manifest.pinned.server_sha
        accepted_master_sha = [string]$manifest.pinned.accepted_master_sha
        generation = [string]$manifest.pinned.generation
        published = [bool](Get-CoordinatedProperty $manifest.server 'published' $false)
        activated = [bool](Get-CoordinatedProperty $manifest.server 'activated' $false)
        healthy = [bool](Get-CoordinatedProperty $manifest.server 'healthy' $false)
        authenticated = $false
        authoritative = $false
        hmac_algorithm = 'HMAC-SHA256'
        nonce = if ($ExistingNonce) { $ExistingNonce } else { [guid]::NewGuid().ToString('N') }
        candidates = [pscustomobject]$candidates
        health = [pscustomobject][ordered]@{
            public_release_sha = [string](Get-CoordinatedProperty $manifest.server 'public_release_sha' '')
            deployment_receipt_sha256 = $receiptSha
            verification_result = [string](Get-CoordinatedProperty $State 'deployment_verification_result' '')
        }
        observed_at_utc = $observedAt
    }
}

function Assert-CoordinatedServerEvidencePayload {
    param(
        [Parameter(Mandatory = $true)]$Evidence,
        [Parameter(Mandatory = $true)]$Manifest
    )
    Assert-CoordinatedReleaseManifest $Manifest | Out-Null
    if ([int](Get-CoordinatedProperty $Evidence 'schemaVersion' 0) -ne 1 -or
        [string](Get-CoordinatedProperty $Evidence 'kind' '') -cne 'ash-atlas-coordinated-server-evidence' -or
        [string](Get-CoordinatedProperty $Evidence 'coordinated_operation_id' '') -cne [string]$Manifest.operation_id -or
        [string](Get-CoordinatedProperty $Evidence 'phase' '') -notin @(Get-CoordinatedReleasePhaseOrder | Where-Object {
                (Get-CoordinatedReleasePhaseIndex $_) -ge (Get-CoordinatedReleasePhaseIndex 'server_healthy')
            }) -or
        [string](Get-CoordinatedProperty $Evidence 'source_sha' '') -cne [string]$Manifest.pinned.server_sha -or
        [string](Get-CoordinatedProperty $Evidence 'server_sha' '') -cne [string]$Manifest.pinned.server_sha -or
        [string](Get-CoordinatedProperty $Evidence 'accepted_master_sha' '') -cne [string]$Manifest.pinned.accepted_master_sha -or
        [string](Get-CoordinatedProperty $Evidence 'generation' '') -cne [string]$Manifest.pinned.generation -or
        -not [bool](Get-CoordinatedProperty $Evidence 'published' $false) -or
        -not [bool](Get-CoordinatedProperty $Evidence 'activated' $false) -or
        -not [bool](Get-CoordinatedProperty $Evidence 'healthy' $false)) {
        Stop-CoordinatedRelease 'coordinated server evidence is not bound to the healthy pinned manifest'
    }
    $health = Get-CoordinatedProperty $Evidence 'health' $null
    $expectedPublicSha = [string](Get-CoordinatedProperty $Manifest.server 'public_release_sha' '')
    if ($null -eq $health -or
        [string](Get-CoordinatedProperty $health 'public_release_sha' '') -cne $expectedPublicSha -or
        [string](Get-CoordinatedProperty $health 'public_release_sha' '') -notmatch '^[0-9a-f]{40}$' -or
        [string](Get-CoordinatedProperty $health 'deployment_receipt_sha256' '') -notmatch '^[0-9a-f]{64}$' -or
        -not [string](Get-CoordinatedProperty $health 'verification_result' '')) {
        Stop-CoordinatedRelease 'coordinated server evidence has incomplete public health proof'
    }
    $evidenceCandidates = Get-CoordinatedProperty $Evidence 'candidates' $null
    foreach ($platform in @(Get-CoordinatedReleaseAppPlatforms)) {
        $evidenceEntry = Get-CoordinatedProperty $evidenceCandidates $platform $null
        $manifestEntry = Get-CoordinatedProperty $Manifest.apps $platform $null
        if ($null -eq $evidenceEntry -or
            [string](Get-CoordinatedProperty $evidenceEntry 'child_operation_id' '') -cne
                [string](Get-CoordinatedProperty $manifestEntry 'child_operation_id' '') -or
            (Get-CoordinatedProperty $evidenceEntry 'approval_fingerprint' '') -cne
                (Get-CoordinatedReleaseExpectedApprovalFingerprint $manifestEntry $platform)) {
            Stop-CoordinatedRelease "$platform server evidence candidate binding is invalid"
        }
    }
    return $Evidence
}

function Set-CoordinatedReleaseAppEvidence {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)][string]$Platform,
        [Parameter(Mandatory = $true)]$Evidence
    )
    Assert-CoordinatedReleaseManifest $Manifest | Out-Null
    if ($Platform -notin @(Get-CoordinatedReleaseAppPlatforms)) {
        Stop-CoordinatedRelease "unsupported coordinated platform '$Platform'"
    }
    $entry = Get-CoordinatedProperty $Manifest.apps $Platform $null
    $childId = [string](Get-CoordinatedProperty $Evidence 'operation_id' '')
    if (-not $childId) { $childId = [string](Get-CoordinatedProperty $Evidence 'operationId' '') }
    if ($childId -cne [string]$entry.child_operation_id) {
        Stop-CoordinatedRelease "$Platform child operation ID does not match the manifest"
    }
    $candidate = Get-CoordinatedProperty $Evidence 'candidate' $Evidence
    $candidatePlatform = [string](Get-CoordinatedProperty $candidate 'platform' '')
    if ($candidatePlatform -and $candidatePlatform -cne $Platform) {
        Stop-CoordinatedRelease "$Platform child candidate platform does not match the manifest"
    }
    $manifestCandidate = $entry.candidate
    foreach ($field in @('release_id', 'source_sha', 'generation', 'marketing_version', 'build',
            'store_build_id', 'artifact_sha256', 'tooling_sha', 'metadata_sha256')) {
        $value = Get-CoordinatedProperty $candidate $field $null
        if ($null -eq $value) {
            $camel = switch ($field) {
                'release_id' { 'releaseId' }
                'source_sha' { 'sourceSha' }
                'marketing_version' { 'marketingVersion' }
                'store_build_id' { 'storeBuildId' }
                'artifact_sha256' { 'artifactSha256' }
                'tooling_sha' { 'toolSha' }
                'metadata_sha256' { 'metadataHash' }
                default { $field }
            }
            $value = Get-CoordinatedProperty $candidate $camel $null
        }
        if ([string]$value -cne [string](Get-CoordinatedProperty $manifestCandidate $field '')) {
            Stop-CoordinatedRelease "$Platform child candidate identity changed for $field"
        }
    }
    $deliveryMode = Get-CoordinatedReleaseDeliveryMode $Manifest
    if ($deliveryMode -eq 'daily-testers') {
        $manifestDestination = Get-CoordinatedReleaseTesterDestination $manifestCandidate $Platform
        $candidateDestination = Get-CoordinatedReleaseTesterDestination $candidate $Platform
        if ($null -eq $candidateDestination) {
            $candidateDestination = Get-CoordinatedReleaseTesterDestination $Evidence $Platform
        }
        Assert-CoordinatedReleaseTesterDestinationBinding $candidateDestination $manifestDestination $Platform | Out-Null
        $entryDestination = Get-CoordinatedReleaseTesterDestination $entry $Platform
        Assert-CoordinatedReleaseTesterDestinationBinding $entryDestination $manifestDestination $Platform | Out-Null
        $evidenceDestination = Get-CoordinatedReleaseTesterDestination $Evidence $Platform
        if ($null -ne $evidenceDestination) {
            Assert-CoordinatedReleaseTesterDestinationBinding $evidenceDestination $manifestDestination $Platform | Out-Null
        }
        if ([bool](Get-CoordinatedProperty $Evidence 'public_available' $false)) {
            Stop-CoordinatedRelease "$Platform daily tester receipt cannot claim public availability"
        }
    }
    $incomingSubmitted = [bool](Get-CoordinatedProperty $Evidence 'submitted' `
        (Get-CoordinatedProperty $Evidence 'upload_submitted' $false))
    $entry.submitted = [bool]$entry.submitted -or $incomingSubmitted
    if ($deliveryMode -eq 'daily-testers' -and [bool](Get-CoordinatedProperty $Evidence 'ready' $false)) {
        $entry.ready = $true
        $entry.submitted = $true
    }
    $entry.store_status = [string](Get-CoordinatedProperty $Evidence 'store_status' (Get-CoordinatedProperty $Evidence 'storeStatus' ''))
    $entry.managed_publishing = [bool](Get-CoordinatedProperty $Evidence 'managed_publishing' (Get-CoordinatedProperty $Evidence 'managedPublishing' $entry.managed_publishing))
    $entry.first_publication_bootstrap_verified = [bool](Get-CoordinatedProperty $Evidence 'first_publication_bootstrap_verified' $entry.first_publication_bootstrap_verified)
    $approval = Get-CoordinatedProperty $Evidence 'approval' $null
    if ($null -ne $approval) {
        $entry.approval.approved = [bool](Get-CoordinatedProperty $approval 'approved' $entry.approval.approved)
        $entry.approval.fingerprint = [string](Get-CoordinatedProperty $approval 'fingerprint' $entry.approval.fingerprint)
        $entry.approval.candidate_fingerprint = [string](Get-CoordinatedProperty $approval 'candidate_fingerprint' $entry.approval.candidate_fingerprint)
        $entry.approval.metadata_sha256 = [string](Get-CoordinatedProperty $approval 'metadata_sha256' $entry.approval.metadata_sha256)
        $suppliedCountries = Get-CoordinatedProperty $approval 'countries' $null
        if ($null -ne $suppliedCountries -and
            ((@($suppliedCountries | ForEach-Object { [string]$_ } | Sort-Object) -join ',') -ne
                (@($manifestCandidate.countries | Sort-Object) -join ','))) {
            Stop-CoordinatedRelease "$Platform approval country policy is not bound to the exact candidate"
        }
        $suppliedRollout = Get-CoordinatedProperty $approval 'rollout' $null
        if ($null -ne $suppliedRollout -and
            ($suppliedRollout | ConvertTo-Json -Depth 16 -Compress) -cne
                ($manifestCandidate.rollout | ConvertTo-Json -Depth 16 -Compress)) {
            Stop-CoordinatedRelease "$Platform approval rollout policy is not bound to the exact candidate"
        }
    }
    $candidateFingerprint = [string](Get-CoordinatedProperty $Evidence 'candidate_fingerprint' '')
    if (-not $candidateFingerprint) { $candidateFingerprint = [string](Get-CoordinatedProperty $Evidence 'candidateFingerprint' '') }
    if ($candidateFingerprint) { $entry.approval.candidate_fingerprint = $candidateFingerprint }
    $expectedFingerprint = Get-CoordinatedReleaseExpectedApprovalFingerprint $entry $Platform
    foreach ($suppliedFingerprint in @(
            [string](Get-CoordinatedProperty $entry.approval 'fingerprint' ''),
            [string](Get-CoordinatedProperty $entry.approval 'candidate_fingerprint' ''))) {
        if ($suppliedFingerprint -and $suppliedFingerprint -cne $expectedFingerprint) {
            Stop-CoordinatedRelease "$Platform approval fingerprint is not bound to the exact candidate"
        }
    }
    $incomingReleaseRequested = [bool](Get-CoordinatedProperty $Evidence 'release_requested' $entry.release_requested)
    $incomingPublicAvailable = [bool](Get-CoordinatedProperty $Evidence 'public_available' $entry.public_available)
    $serverHealthy = [bool](Get-CoordinatedProperty $Manifest.server 'healthy' $false) -or
        (Get-CoordinatedReleasePhaseIndex ([string]$Manifest.current_phase)) -ge
            (Get-CoordinatedReleasePhaseIndex 'server_healthy')
    if ($deliveryMode -eq 'daily-testers') {
        $entry.public_available = $false
        # Daily tester activation is a post-health action.  A pre-health
        # receipt may describe preparation, but it cannot become the durable
        # completion observation or release request.
        $testerAvailableValue = Get-CoordinatedProperty $Evidence 'tester_available' $null
        if ($null -ne $testerAvailableValue -and [bool]$testerAvailableValue) {
            $entry.ready = $true
            $entry.submitted = $true
        }
        if ($serverHealthy) {
            $entry.release_requested = [bool]$entry.release_requested -or $incomingReleaseRequested
        } else {
            $entry.release_requested = $false
        }
        if ($null -ne $testerAvailableValue -and [bool]$testerAvailableValue -and $serverHealthy) {
            $entry.tester_available = $true
            $entry.tester_observed_after_server_health = $true
            $entry.tester_status = [string](Get-CoordinatedProperty $Evidence 'tester_status' $entry.tester_status)
        } elseif ($null -ne $testerAvailableValue -and -not [bool]$testerAvailableValue -and $serverHealthy) {
            $entry.tester_status = [string](Get-CoordinatedProperty $Evidence 'tester_status' $entry.tester_status)
        }
        if ($entry.tester_available -and -not $entry.tester_status) {
            Stop-CoordinatedRelease "$Platform daily tester receipt omitted tester status"
        }
    } else {
        $entry.release_requested = $incomingReleaseRequested
        $entry.public_available = $incomingPublicAvailable
    }
    $entry.public_status = [string](Get-CoordinatedProperty $Evidence 'public_status' $entry.public_status)
    $entry.last_observed_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    $entry.last_evidence_fingerprint = [string](Get-CoordinatedProperty $Evidence 'receipt_sha256' '')
    if ($entry.last_evidence_fingerprint -notmatch '^[0-9a-f]{64}$') {
        $json = $Evidence | ConvertTo-Json -Depth 20 -Compress
        $algorithm = [Security.Cryptography.SHA256]::Create()
        try {
            $entry.last_evidence_fingerprint = ([BitConverter]::ToString(
                $algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($json)))).Replace('-', '').ToLowerInvariant()
        } finally { $algorithm.Dispose() }
    }
    Assert-CoordinatedReleaseManifest $Manifest | Out-Null
    return $Manifest
}

function Advance-CoordinatedReleasePhase {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)][string]$NextPhase
    )
    Assert-CoordinatedReleaseManifest $Manifest | Out-Null
    $currentIndex = Get-CoordinatedReleasePhaseIndex ([string]$Manifest.current_phase)
    $nextIndex = Get-CoordinatedReleasePhaseIndex $NextPhase
    if ($nextIndex -lt $currentIndex) {
        Stop-CoordinatedRelease "coordinated release phase cannot move backwards from $($Manifest.current_phase) to $NextPhase"
    }
    if ($nextIndex -eq $currentIndex) { return $Manifest }
    if ($nextIndex -ne ($currentIndex + 1)) {
        Stop-CoordinatedRelease "coordinated release phase cannot skip from $($Manifest.current_phase) to $NextPhase"
    }
    switch ($NextPhase) {
        'apps_submitted' {
            if (-not (Test-CoordinatedReleaseAppsSubmitted $Manifest)) {
                Stop-CoordinatedRelease 'both exact app preparations are required before advancing to apps_submitted'
            }
        }
        'apps_ready' {
            if (-not (Test-CoordinatedReleasePrePublicationAppsReady $Manifest)) {
                Stop-CoordinatedRelease 'both exact app readiness states are required before server publication'
            }
        }
        'server_published' {
            if (-not (Test-CoordinatedReleasePrePublicationAppsReady $Manifest) -or
                -not [bool](Get-CoordinatedProperty $Manifest.server 'published' $false)) {
                Stop-CoordinatedRelease 'server publication requires both exact app readiness and an exact pinned candidate'
            }
        }
        'server_activated' {
            if (-not [bool](Get-CoordinatedProperty $Manifest.server 'activated' $false)) {
                Stop-CoordinatedRelease 'server activation evidence is required before advancing'
            }
        }
        'server_healthy' {
            if (-not [bool](Get-CoordinatedProperty $Manifest.server 'healthy' $false)) {
                Stop-CoordinatedRelease 'server health evidence is required before app release requests'
            }
        }
        'apps_release_requested' {
            foreach ($platform in @(Get-CoordinatedReleaseAppPlatforms)) {
                if (-not [bool](Get-CoordinatedProperty (Get-CoordinatedProperty $Manifest.apps $platform $null) 'release_requested' $false)) {
                    Stop-CoordinatedRelease "both app release requests are required before waiting for public availability ($platform missing)"
                }
            }
        }
        'completed' {
            if (-not (Test-CoordinatedReleaseAppsPublic $Manifest)) {
                if ((Get-CoordinatedReleaseDeliveryMode $Manifest) -eq 'daily-testers') {
                    Stop-CoordinatedRelease 'both exact post-health TestFlight group and Google Play qa tester availability receipts are required before completion'
                }
                Stop-CoordinatedRelease 'both exact app public availability receipts are required before completion'
            }
        }
    }
    $Manifest.current_phase = $NextPhase
    if ($NextPhase -eq 'completed') {
        $Manifest.completion.status = 'completed'
        $Manifest.completion.waiting_reason = ''
        $Manifest.completion.completed_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    }
    return $Manifest
}
