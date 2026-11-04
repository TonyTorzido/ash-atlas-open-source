Set-StrictMode -Version Latest

function Get-AshAtlasMainResetDockerInspection {
    param([Parameter(Mandatory = $true)][string]$Name)

    $raw = @(& docker inspect $Name 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "Could not inspect protected Main Docker resource '$Name': $($raw -join [Environment]::NewLine)" }
    $parsed = @((($raw -join [Environment]::NewLine) | ConvertFrom-Json))
    if ($parsed.Count -ne 1) { throw "Expected exactly one protected Main Docker resource named '$Name'." }
    return $parsed[0]
}

function Get-AshAtlasMainGameplayResetManifest {
    return [ordered]@{
        identity_auth_social = @(
            'account_device_links', 'account_identities', 'account_risk_events', 'accounts',
            'auth_events', 'auth_google_credential_uses', 'auth_sessions', 'device_installations',
            'friend_requests', 'friendships', 'player_blocks', 'player_profiles'
        )
        players_progression_inventory = @(
            'archived_class_technique_unlocks', 'class_operations', 'class_progression_operations',
            'dev_progression_operations', 'equipment_instances', 'equipment_operations',
            'inventory_events', 'inventory_operations', 'player_class_legacy_unlocks',
            'player_class_loadouts', 'player_class_profiles', 'player_class_progress',
            'player_class_resources', 'player_class_runtime', 'player_class_technique_unlocks',
            'player_combat_profiles', 'player_inventory', 'player_progression_profiles',
            'player_subclass_loadouts', 'player_subclass_progress', 'players', 'xp_events',
            'xp_operations'
        )
        flags_cities_kingdoms_manors_parties_travel = @(
            'cities', 'city_memberships', 'flags', 'kingdom_audit_events',
            'kingdom_chat_messages', 'kingdom_chat_mutes', 'kingdom_construction_jobs',
            'kingdom_cots', 'kingdom_decorations', 'kingdom_donations',
            'kingdom_flag_affiliation_history', 'kingdom_invitations', 'kingdom_memberships',
            'kingdom_requests', 'kingdom_seats', 'kingdom_treasury_balances',
            'kingdom_xp_ledger', 'kingdoms', 'manor_build_operations',
            'manor_placement_events', 'manor_placement_operations', 'manor_storage_events',
            'manor_storage_stacks', 'manor_transfer_operations', 'parties', 'party_invites',
            'party_members', 'party_operations', 'player_inbox_entries', 'player_manor_presence',
            'player_manors', 'travel_invite_operations', 'travel_invites'
        )
        chat_direct_messages_recent_players = @(
            'chat_channel_read_states', 'chat_channel_sequences', 'chat_channels', 'chat_messages',
            'chat_moderation_decisions', 'chat_mutes', 'direct_conversation_participants',
            'direct_conversations', 'direct_message_event_cursors', 'direct_message_events',
            'direct_message_rate_windows', 'player_direct_message_preferences',
            'recent_player_pair_suppressions', 'recent_players'
        )
        markets_wallets_economy = @(
            'market_audit_events', 'market_claims', 'market_collections', 'market_ledger_entries',
            'market_ledger_groups', 'market_order_escrows', 'market_orders',
            'market_player_controls', 'market_quote_requests', 'market_quotes',
            'market_rate_windows', 'market_requests', 'market_trades', 'player_wallets',
            'wallet_events'
        )
        world_resources_and_runtime = @(
            'collectible_nodes', 'combat_balance_summaries', 'combat_reward_participants',
            'combat_reward_settlements', 'flag_resource_visions', 'generated_world_mobs',
            'harvest_sessions', 'permanent_mine_allocation_buckets', 'population_entity_state_v2',
            'population_plan_permanent_stones_v2',
            'population_permanent_stone_authority_v2',
            'population_runtime_entity_leases_v2', 'population_spawn_slots_v2',
            'population_stone_conflict_repair_receipts_v2',
            'population_zone_cutovers_v2', 'population_zone_generations_v2',
            'population_zones_v2',
            'player_enemy_marks', 'player_water_collection_cadence',
            'repeatable_resource_harvests', 'repeatable_resource_nodes',
            'repeatable_resource_sessions', 'resource_vision_jobs', 'spawn_cells',
            'water_collection_operations', 'world_item_drop_requests', 'world_item_drops',
            'world_item_movements', 'world_item_pickups'
        )
    }
}

function Get-AshAtlasMainGameplayPreservedTables {
    return @(
        'item_definitions', 'kingdom_decoration_definitions', 'market_fee_policies',
        'market_global_controls', 'market_order_books', 'market_venue_controls',
        'market_venues', 'schema_migrations', 'spatial_ref_sys'
    )
}

function Test-AshAtlasMainResetContainerIdentity {
    param(
        [Parameter(Mandatory = $true)]$Config,
        [Parameter(Mandatory = $true)]$Inspection
    )

    $labels = $Inspection.Config.Labels
    $mounts = @($Inspection.Mounts | Where-Object { [string]$_.Type -eq 'volume' })
    $ports = $Inspection.NetworkSettings.Ports.'5432/tcp'
    return (
        [string]$Inspection.Name -eq "/$($Config.main.postgres_container)" -and
        [string]$labels.'com.ash-atlas.owner' -eq [string]$Config.owner_label -and
        [string]$labels.'com.ash-atlas.runtime-id' -eq [string]$Config.main.runtime_id -and
        [string]$labels.'com.ash-atlas.runtime-mode' -eq 'main' -and
        [string]$labels.'com.ash-atlas.database-disposition' -eq 'retained' -and
        $mounts.Count -eq 1 -and
        [string]$mounts[0].Name -eq [string]$Config.main.database.volume -and
        $null -ne $ports -and @($ports).Count -eq 1 -and
        [string]$ports[0].HostIp -eq '127.0.0.1' -and
        [int]$ports[0].HostPort -eq [int]$Config.main.ports.postgres
    )
}

function Assert-AshAtlasMainResetTableClassification {
    param(
        [Parameter(Mandatory = $true)][string[]]$ActualTables,
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)][string[]]$PreservedTables
    )

    $resetTables = @($Manifest.Values | ForEach-Object { @($_) })
    $duplicates = @($resetTables | Group-Object | Where-Object Count -gt 1 | ForEach-Object Name)
    if ($duplicates.Count -gt 0) { throw "Reset manifest contains duplicate tables: $($duplicates -join ', ')." }
    $classified = @($resetTables + $PreservedTables | Sort-Object -Unique)
    $unknown = @($ActualTables | Where-Object { $classified -notcontains $_ })
    $missing = @($classified | Where-Object { $ActualTables -notcontains $_ })
    if ($unknown.Count -gt 0) { throw "REFUSED: unclassified public tables: $($unknown -join ', ')." }
    if ($missing.Count -gt 0) { throw "REFUSED: classified public tables are missing: $($missing -join ', ')." }
}

function Assert-AshAtlasMainResetCascadeClosure {
    param(
        [Parameter(Mandatory = $true)][object[]]$ForeignKeys,
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)][string[]]$PreservedTables
    )

    $resetTables = @($Manifest.Values | ForEach-Object { @($_) })
    $unsafe = @()
    foreach ($foreignKey in $ForeignKeys) {
        $parentSchema = [string]$foreignKey.parent_schema
        $parentTable = [string]$foreignKey.parent_table
        $childSchema = [string]$foreignKey.child_schema
        $childTable = [string]$foreignKey.child_table
        if ($parentSchema -ne 'public' -or $resetTables -notcontains $parentTable) { continue }
        if ($childSchema -ne 'public' -or $resetTables -notcontains $childTable) {
            $unsafe += "$childSchema.$childTable -> $parentSchema.$parentTable"
        }
    }
    if ($unsafe.Count -gt 0) {
        throw "REFUSED: TRUNCATE CASCADE would reach tables outside the reset manifest: $($unsafe -join ', ')."
    }
    $preservedOverlap = @($resetTables | Where-Object { $PreservedTables -contains $_ })
    if ($preservedOverlap.Count -gt 0) {
        throw "REFUSED: reset and preserved table manifests overlap: $($preservedOverlap -join ', ')."
    }
}

function ConvertTo-AshAtlasQuotedSqlIdentifier([string]$Value) {
    if ($Value -notmatch '^[a-z][a-z0-9_]*$') { throw "Unsafe SQL identifier '$Value'." }
    return '"' + $Value + '"'
}
