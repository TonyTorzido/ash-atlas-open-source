function ConvertTo-AshAtlasWorldIdentity {
    param([Parameter(Mandatory = $true)]$Lock)

    $waterNameIndexLock = Get-AshAtlasObjectPropertyValue $Lock 'water_name_index' $null
    $identity = [pscustomobject][ordered]@{
        schema_version = [int]$Lock.schema_version
        pipeline = [pscustomobject][ordered]@{
            repository = [string]$Lock.pipeline.repository
            protected_branch = [string]$Lock.pipeline.protected_branch
            sha = ([string]$Lock.pipeline.sha).ToLowerInvariant()
        }
        release = [pscustomobject][ordered]@{
            release_id = [string]$Lock.release.release_id
            profile_set_fingerprint = ([string]$Lock.release.profile_set_fingerprint).ToLowerInvariant()
            build_contract_fingerprint = ([string]$Lock.release.build_contract_fingerprint).ToLowerInvariant()
            boundary_release_id = [string]$Lock.release.boundary_release_id
            manifest_sha256 = ([string]$Lock.release.manifest_sha256).ToLowerInvariant()
            package_count = [int]$Lock.release.package_count
            artifact_count = [int](Get-AshAtlasObjectPropertyValue $Lock.release 'artifact_count' 0)
        }
        river_surface = [pscustomobject][ordered]@{
            release_id = [string]$Lock.river_surface.release_id
            manifest_sha256 = ([string]$Lock.river_surface.manifest_sha256).ToLowerInvariant()
            policy = [string]$Lock.river_surface.policy
            cell_size_m = [int]$Lock.river_surface.cell_size_m
            package_count = [int]$Lock.river_surface.package_count
            cell_count = [int64]$Lock.river_surface.cell_count
            span_count = [int64]$Lock.river_surface.span_count
        }
        lake_surface = [pscustomobject][ordered]@{
            release_id = [string]$Lock.lake_surface.release_id
            manifest_sha256 = ([string]$Lock.lake_surface.manifest_sha256).ToLowerInvariant()
            policy = [string]$Lock.lake_surface.policy
            membership_policy = [string]$Lock.lake_surface.membership_policy
            overlap_policy = [string]$Lock.lake_surface.overlap_policy
            grid_fingerprint = ([string]$Lock.lake_surface.grid_fingerprint).ToLowerInvariant()
            cell_size_m = [int]$Lock.lake_surface.cell_size_m
            package_count = [int]$Lock.lake_surface.package_count
            lake_count = [int]$Lock.lake_surface.lake_count
            cell_count = [int64]$Lock.lake_surface.cell_count
            span_count = [int64]$Lock.lake_surface.span_count
        }
        ocean_coast_surface = [pscustomobject][ordered]@{
            release_id = [string]$Lock.ocean_coast_surface.release_id
            manifest_sha256 = ([string]$Lock.ocean_coast_surface.manifest_sha256).ToLowerInvariant()
            policy = [string]$Lock.ocean_coast_surface.policy
            selection_policy = [string]$Lock.ocean_coast_surface.selection_policy
            band_morphology = [string]$Lock.ocean_coast_surface.band_morphology
            band_cells = [int]$Lock.ocean_coast_surface.band_cells
            overlap_policy = [string]$Lock.ocean_coast_surface.overlap_policy
            precedence_policy = [string]$Lock.ocean_coast_surface.precedence_policy
            deep_ocean_policy = [string]$Lock.ocean_coast_surface.deep_ocean_policy
            grid_fingerprint = ([string]$Lock.ocean_coast_surface.grid_fingerprint).ToLowerInvariant()
            cell_size_m = [int]$Lock.ocean_coast_surface.cell_size_m
            package_count = [int]$Lock.ocean_coast_surface.package_count
            cell_count = [int64]$Lock.ocean_coast_surface.cell_count
            span_count = [int64]$Lock.ocean_coast_surface.span_count
        }
        riverbank_lakeshore = [pscustomobject][ordered]@{
            release_id = [string]$Lock.riverbank_lakeshore.release_id
            manifest_sha256 = ([string]$Lock.riverbank_lakeshore.manifest_sha256).ToLowerInvariant()
            schema = [string]$Lock.riverbank_lakeshore.schema
            policy = [string]$Lock.riverbank_lakeshore.policy
            pipeline_sha = ([string]$Lock.riverbank_lakeshore.pipeline_sha).ToLowerInvariant()
            contract_fingerprint = ([string]$Lock.riverbank_lakeshore.contract_fingerprint).ToLowerInvariant()
            distance_m = [double]$Lock.riverbank_lakeshore.distance_m
            cell_size_m = [int]$Lock.riverbank_lakeshore.cell_size_m
            grid_fingerprint = ([string]$Lock.riverbank_lakeshore.grid_fingerprint).ToLowerInvariant()
            inventory_sha256 = ([string]$Lock.riverbank_lakeshore.inventory_sha256).ToLowerInvariant()
            package_count = [int]$Lock.riverbank_lakeshore.package_count
            selected_package_count = [int]$Lock.riverbank_lakeshore.selected_package_count
            positive_package_count = [int]$Lock.riverbank_lakeshore.positive_package_count
            empty_package_count = [int]$Lock.riverbank_lakeshore.empty_package_count
            source_package_count = [int]$Lock.riverbank_lakeshore.source_package_count
            span_count = [int64]$Lock.riverbank_lakeshore.span_count
            membership_cell_count = [int64]$Lock.riverbank_lakeshore.membership_cell_count
            source_package_fingerprint = ([string]$Lock.riverbank_lakeshore.source_package_fingerprint).ToLowerInvariant()
            selected_package_fingerprint = ([string]$Lock.riverbank_lakeshore.selected_package_fingerprint).ToLowerInvariant()
            deterministic_fingerprint = ([string]$Lock.riverbank_lakeshore.deterministic_fingerprint).ToLowerInvariant()
            source = [pscustomobject][ordered]@{
                river = [pscustomobject][ordered]@{
                    release_id = [string]$Lock.riverbank_lakeshore.source.river.release_id
                    manifest_sha256 = ([string]$Lock.riverbank_lakeshore.source.river.manifest_sha256).ToLowerInvariant()
                    policy = [string]$Lock.riverbank_lakeshore.source.river.policy
                }
                lake = [pscustomobject][ordered]@{
                    release_id = [string]$Lock.riverbank_lakeshore.source.lake.release_id
                    manifest_sha256 = ([string]$Lock.riverbank_lakeshore.source.lake.manifest_sha256).ToLowerInvariant()
                    policy = [string]$Lock.riverbank_lakeshore.source.lake.policy
                }
                world = [pscustomobject][ordered]@{
                    release_id = [string]$Lock.riverbank_lakeshore.source.world.release_id
                    manifest_sha256 = ([string]$Lock.riverbank_lakeshore.source.world.manifest_sha256).ToLowerInvariant()
                }
            }
        }
        waterbody_identity_overlay = [pscustomobject][ordered]@{
            release_id = [string]$Lock.waterbody_identity_overlay.release_id
            manifest_sha256 = ([string]$Lock.waterbody_identity_overlay.manifest_sha256).ToLowerInvariant()
            schema = [string]$Lock.waterbody_identity_overlay.schema
            schema_version = [string](Get-AshAtlasObjectPropertyValue $Lock.waterbody_identity_overlay 'schema_version' '')
            policy = [string]$Lock.waterbody_identity_overlay.policy
            policy_version = [string](Get-AshAtlasObjectPropertyValue $Lock.waterbody_identity_overlay 'policy_version' '')
            package_count = [int]$Lock.waterbody_identity_overlay.package_count
            source_cell_count = [int64]$Lock.waterbody_identity_overlay.source_cell_count
            source_span_count = [int64]$Lock.waterbody_identity_overlay.source_span_count
            final_cell_count = [int64]$Lock.waterbody_identity_overlay.final_cell_count
            final_span_count = [int64]$Lock.waterbody_identity_overlay.final_span_count
            identity_registry_fingerprint = ([string]$Lock.waterbody_identity_overlay.identity_registry_fingerprint).ToLowerInvariant()
            deterministic_fingerprint = ([string]$Lock.waterbody_identity_overlay.deterministic_fingerprint).ToLowerInvariant()
            input_release_ids = [pscustomobject][ordered]@{
                river = [string]$Lock.waterbody_identity_overlay.input_release_ids.river
                lake = [string]$Lock.waterbody_identity_overlay.input_release_ids.lake
                ocean = [string]$Lock.waterbody_identity_overlay.input_release_ids.ocean
            }
            input_manifests = [pscustomobject][ordered]@{
                river = ([string]$Lock.waterbody_identity_overlay.input_manifests.river).ToLowerInvariant()
                lake = ([string]$Lock.waterbody_identity_overlay.input_manifests.lake).ToLowerInvariant()
                ocean = ([string]$Lock.waterbody_identity_overlay.input_manifests.ocean).ToLowerInvariant()
            }
        }
        water_name_index = [pscustomobject][ordered]@{
            release_id = [string](Get-AshAtlasObjectPropertyValue $waterNameIndexLock 'release_id' '')
            manifest_sha256 = ([string](Get-AshAtlasObjectPropertyValue $waterNameIndexLock 'manifest_sha256' '')).ToLowerInvariant()
            schema = [string](Get-AshAtlasObjectPropertyValue $waterNameIndexLock 'schema' '')
            policy = [string](Get-AshAtlasObjectPropertyValue $waterNameIndexLock 'policy' '')
            entries_filename = [string](Get-AshAtlasObjectPropertyValue $waterNameIndexLock 'entries_filename' '')
            entries_format = [string](Get-AshAtlasObjectPropertyValue $waterNameIndexLock 'entries_format' '')
            entries_sha256 = ([string](Get-AshAtlasObjectPropertyValue $waterNameIndexLock 'entries_sha256' '')).ToLowerInvariant()
            entries_size_bytes = [int64](Get-AshAtlasObjectPropertyValue $waterNameIndexLock 'entries_size_bytes' 0)
            index_hash = ([string](Get-AshAtlasObjectPropertyValue $waterNameIndexLock 'index_hash' '')).ToLowerInvariant()
            deterministic_fingerprint = ([string](Get-AshAtlasObjectPropertyValue $waterNameIndexLock 'deterministic_fingerprint' '')).ToLowerInvariant()
            entry_count = [int](Get-AshAtlasObjectPropertyValue $waterNameIndexLock 'entry_count' 0)
            classes = [pscustomobject][ordered]@{
                river = [int](Get-AshAtlasObjectPropertyValue (Get-AshAtlasObjectPropertyValue $waterNameIndexLock 'classes' $null) 'river' 0)
                lake = [int](Get-AshAtlasObjectPropertyValue (Get-AshAtlasObjectPropertyValue $waterNameIndexLock 'classes' $null) 'lake' 0)
                ocean = [int](Get-AshAtlasObjectPropertyValue (Get-AshAtlasObjectPropertyValue $waterNameIndexLock 'classes' $null) 'ocean' 0)
            }
            max_distance_m = [pscustomobject][ordered]@{
                river = [double](Get-AshAtlasObjectPropertyValue (Get-AshAtlasObjectPropertyValue $waterNameIndexLock 'max_distance_m' $null) 'river' 0)
                lake = [double](Get-AshAtlasObjectPropertyValue (Get-AshAtlasObjectPropertyValue $waterNameIndexLock 'max_distance_m' $null) 'lake' 0)
                ocean = [double](Get-AshAtlasObjectPropertyValue (Get-AshAtlasObjectPropertyValue $waterNameIndexLock 'max_distance_m' $null) 'ocean' 0)
            }
        }
        water_visual_tiles = [pscustomobject][ordered]@{
            release_id = [string]$Lock.water_visual_tiles.release_id
            manifest_sha256 = ([string]$Lock.water_visual_tiles.manifest_sha256).ToLowerInvariant()
            policy = [string]$Lock.water_visual_tiles.policy
            precedence = [string]$Lock.water_visual_tiles.precedence
            surface_policy = [string]$Lock.water_visual_tiles.surface_policy
            freshwater_perimeter_policy = [string]$Lock.water_visual_tiles.freshwater_perimeter_policy
            ocean_coastline_policy = [string]$Lock.water_visual_tiles.ocean_coastline_policy
            deep_ocean_policy = [string]$Lock.water_visual_tiles.deep_ocean_policy
            layers = @($Lock.water_visual_tiles.layers | ForEach-Object { [string]$_ })
            min_zoom = [int]$Lock.water_visual_tiles.min_zoom
            max_zoom = [int]$Lock.water_visual_tiles.max_zoom
            artifact_file = [string]$Lock.water_visual_tiles.artifact_file
            artifact_sha256 = ([string]$Lock.water_visual_tiles.artifact_sha256).ToLowerInvariant()
            artifact_size_bytes = [int64]$Lock.water_visual_tiles.artifact_size_bytes
            tile_count = [int]$Lock.water_visual_tiles.tile_count
        }
    }
    if ($identity.schema_version -ne 1) { throw "Unsupported world runtime lock schema $($identity.schema_version)." }
    foreach ($required in @(
        $identity.pipeline.repository, $identity.pipeline.protected_branch, $identity.release.release_id,
        $identity.release.profile_set_fingerprint, $identity.release.build_contract_fingerprint,
        $identity.release.boundary_release_id, $identity.release.manifest_sha256,
        $identity.river_surface.release_id, $identity.river_surface.manifest_sha256,
        $identity.river_surface.policy, $identity.lake_surface.release_id,
        $identity.lake_surface.manifest_sha256, $identity.lake_surface.policy,
        $identity.lake_surface.membership_policy, $identity.lake_surface.overlap_policy,
        $identity.ocean_coast_surface.release_id, $identity.ocean_coast_surface.manifest_sha256,
        $identity.ocean_coast_surface.policy, $identity.ocean_coast_surface.selection_policy,
        $identity.ocean_coast_surface.band_morphology, $identity.ocean_coast_surface.overlap_policy,
        $identity.ocean_coast_surface.precedence_policy, $identity.ocean_coast_surface.deep_ocean_policy,
        $identity.riverbank_lakeshore.release_id, $identity.riverbank_lakeshore.manifest_sha256,
        $identity.riverbank_lakeshore.schema, $identity.riverbank_lakeshore.policy,
        $identity.riverbank_lakeshore.pipeline_sha, $identity.riverbank_lakeshore.contract_fingerprint,
        $identity.riverbank_lakeshore.grid_fingerprint, $identity.riverbank_lakeshore.inventory_sha256,
        $identity.riverbank_lakeshore.source_package_fingerprint, $identity.riverbank_lakeshore.selected_package_fingerprint,
        $identity.riverbank_lakeshore.deterministic_fingerprint,
        $identity.riverbank_lakeshore.source.river.release_id, $identity.riverbank_lakeshore.source.river.manifest_sha256,
        $identity.riverbank_lakeshore.source.river.policy, $identity.riverbank_lakeshore.source.lake.release_id,
        $identity.riverbank_lakeshore.source.lake.manifest_sha256, $identity.riverbank_lakeshore.source.lake.policy,
        $identity.riverbank_lakeshore.source.world.release_id, $identity.riverbank_lakeshore.source.world.manifest_sha256,
        $identity.waterbody_identity_overlay.release_id, $identity.waterbody_identity_overlay.manifest_sha256,
        $identity.waterbody_identity_overlay.schema, $identity.waterbody_identity_overlay.schema_version,
        $identity.waterbody_identity_overlay.policy, $identity.waterbody_identity_overlay.policy_version,
        $identity.waterbody_identity_overlay.identity_registry_fingerprint,
        $identity.waterbody_identity_overlay.deterministic_fingerprint,
        $identity.waterbody_identity_overlay.input_release_ids.river,
        $identity.waterbody_identity_overlay.input_release_ids.lake,
        $identity.waterbody_identity_overlay.input_release_ids.ocean,
        $identity.waterbody_identity_overlay.input_manifests.river,
        $identity.waterbody_identity_overlay.input_manifests.lake,
        $identity.waterbody_identity_overlay.input_manifests.ocean,
        $identity.water_name_index.release_id, $identity.water_name_index.manifest_sha256,
        $identity.water_name_index.schema, $identity.water_name_index.policy,
        $identity.water_name_index.entries_filename, $identity.water_name_index.entries_format,
        $identity.water_name_index.entries_sha256, $identity.water_name_index.index_hash,
        $identity.water_name_index.deterministic_fingerprint,
        $identity.water_visual_tiles.release_id, $identity.water_visual_tiles.manifest_sha256,
        $identity.water_visual_tiles.policy, $identity.water_visual_tiles.precedence,
        $identity.water_visual_tiles.surface_policy, $identity.water_visual_tiles.freshwater_perimeter_policy,
        $identity.water_visual_tiles.ocean_coastline_policy, $identity.water_visual_tiles.deep_ocean_policy,
        $identity.water_visual_tiles.artifact_file, $identity.water_visual_tiles.artifact_sha256
    )) {
        if (-not $required) { throw 'World runtime lock contains an empty identity field.' }
    }
    if ($identity.pipeline.sha -notmatch '^[0-9a-f]{40}$') { throw 'World runtime pipeline SHA must be a lowercase 40-character Git SHA.' }
    foreach ($fingerprint in @(
        $identity.release.profile_set_fingerprint,
        $identity.release.build_contract_fingerprint,
        $identity.release.manifest_sha256,
        $identity.river_surface.manifest_sha256,
        $identity.lake_surface.manifest_sha256, $identity.lake_surface.grid_fingerprint,
        $identity.ocean_coast_surface.manifest_sha256, $identity.ocean_coast_surface.grid_fingerprint,
        $identity.riverbank_lakeshore.manifest_sha256, $identity.riverbank_lakeshore.contract_fingerprint,
        $identity.riverbank_lakeshore.grid_fingerprint, $identity.riverbank_lakeshore.inventory_sha256,
        $identity.riverbank_lakeshore.source_package_fingerprint, $identity.riverbank_lakeshore.selected_package_fingerprint,
        $identity.riverbank_lakeshore.deterministic_fingerprint,
        $identity.riverbank_lakeshore.source.river.manifest_sha256,
        $identity.riverbank_lakeshore.source.lake.manifest_sha256,
        $identity.riverbank_lakeshore.source.world.manifest_sha256,
        $identity.waterbody_identity_overlay.manifest_sha256,
        $identity.waterbody_identity_overlay.identity_registry_fingerprint,
        $identity.waterbody_identity_overlay.deterministic_fingerprint,
        $identity.waterbody_identity_overlay.input_manifests.river,
        $identity.waterbody_identity_overlay.input_manifests.lake,
        $identity.waterbody_identity_overlay.input_manifests.ocean,
        $identity.water_name_index.manifest_sha256, $identity.water_name_index.entries_sha256,
        $identity.water_name_index.index_hash, $identity.water_name_index.deterministic_fingerprint,
        $identity.water_visual_tiles.manifest_sha256, $identity.water_visual_tiles.artifact_sha256
    )) {
        if ($fingerprint -notmatch '^[0-9a-f]{64}$') { throw 'World runtime release fingerprints must be lowercase SHA-256 values.' }
    }
    if ($identity.release.package_count -lt 1 -or $identity.release.artifact_count -lt 1) {
        throw 'World runtime package and artifact counts must be positive.'
    }
    if ($identity.river_surface.cell_size_m -ne 125 -or $identity.river_surface.package_count -lt 1 -or
        $identity.river_surface.cell_count -lt 1 -or $identity.river_surface.span_count -lt 1) {
        throw 'River surface lock counts and 125 m cell size must be positive and exact.'
    }
    if ($identity.lake_surface.cell_size_m -ne 125 -or $identity.lake_surface.package_count -lt 1 -or
        $identity.lake_surface.lake_count -lt 1 -or $identity.lake_surface.cell_count -lt 1 -or
        $identity.lake_surface.span_count -lt 1) {
        throw 'Lake surface lock counts and 125 m cell size must be positive and exact.'
    }
    if ($identity.ocean_coast_surface.cell_size_m -ne 125 -or $identity.ocean_coast_surface.band_cells -ne 3 -or
        $identity.ocean_coast_surface.package_count -lt 1 -or $identity.ocean_coast_surface.cell_count -lt 1 -or
        $identity.ocean_coast_surface.span_count -lt 1) {
        throw 'Ocean coast surface lock counts, three-cell band, and 125 m cell size must be positive and exact.'
    }
    if ($identity.riverbank_lakeshore.pipeline_sha -notmatch '^[0-9a-f]{40}$' -or
        $identity.riverbank_lakeshore.distance_m -ne 500 -or
        $identity.riverbank_lakeshore.cell_size_m -ne 125 -or
        $identity.riverbank_lakeshore.package_count -ne 14627 -or
        $identity.riverbank_lakeshore.selected_package_count -ne 20542 -or
        $identity.riverbank_lakeshore.positive_package_count -ne 14627 -or
        $identity.riverbank_lakeshore.empty_package_count -ne 5915 -or
        $identity.riverbank_lakeshore.source_package_count -ne 14598 -or
        $identity.riverbank_lakeshore.span_count -ne 59122237 -or
        $identity.riverbank_lakeshore.membership_cell_count -ne 391536663) {
        throw 'Riverbank/lakeshore release counts, 500 m distance, 125 m cell size, and pipeline identity must be exact.'
    }
    if ($identity.waterbody_identity_overlay.package_count -lt 1 -or
        $identity.waterbody_identity_overlay.source_cell_count -lt 1 -or
        $identity.waterbody_identity_overlay.source_span_count -lt 1 -or
        $identity.waterbody_identity_overlay.final_cell_count -lt 1 -or
        $identity.waterbody_identity_overlay.final_span_count -lt 1) {
        throw 'Waterbody identity overlay lock counts must be positive and exact.'
    }
    if ($identity.water_name_index.entries_size_bytes -lt 1 -or
        $identity.water_name_index.entry_count -lt 1 -or
        $identity.water_name_index.classes.river -lt 1 -or
        $identity.water_name_index.classes.lake -lt 1 -or
        $identity.water_name_index.classes.ocean -lt 1 -or
        ($identity.water_name_index.classes.river + $identity.water_name_index.classes.lake + $identity.water_name_index.classes.ocean) -ne $identity.water_name_index.entry_count -or
        $identity.water_name_index.max_distance_m.river -le 0 -or
        $identity.water_name_index.max_distance_m.lake -le 0 -or
        $identity.water_name_index.max_distance_m.ocean -le 0) {
        throw 'Water-name index lock counts, class counts, and distance bounds must be positive and exact.'
    }
    if ($identity.water_visual_tiles.min_zoom -ne 12 -or $identity.water_visual_tiles.max_zoom -ne 14 -or
        $identity.water_visual_tiles.artifact_size_bytes -lt 1 -or $identity.water_visual_tiles.tile_count -lt 1 -or
        $identity.water_visual_tiles.precedence -cne 'river>lake>ocean>land' -or
        $identity.water_visual_tiles.layers.Count -ne 6) {
        throw 'Combined water visual identity, precedence, layers, zooms, artifact size, and tile count must be positive and exact.'
    }
    return $identity
}

function ConvertTo-AshAtlasCanonicalWorldIdentity {
    param([Parameter(Mandatory = $true)]$Identity)

    $canonical = [ordered]@{
        schema_version = [int]$Identity.schema_version
        pipeline = [ordered]@{
            repository = [string]$Identity.pipeline.repository
            protected_branch = [string]$Identity.pipeline.protected_branch
            sha = [string]$Identity.pipeline.sha
        }
        release = [ordered]@{
            release_id = [string]$Identity.release.release_id
            profile_set_fingerprint = [string]$Identity.release.profile_set_fingerprint
            build_contract_fingerprint = [string]$Identity.release.build_contract_fingerprint
            boundary_release_id = [string]$Identity.release.boundary_release_id
            manifest_sha256 = [string]$Identity.release.manifest_sha256
            package_count = [int]$Identity.release.package_count
            artifact_count = [int]$Identity.release.artifact_count
        }
        river_surface = [ordered]@{
            release_id = [string]$Identity.river_surface.release_id
            manifest_sha256 = [string]$Identity.river_surface.manifest_sha256
            policy = [string]$Identity.river_surface.policy
            cell_size_m = [int]$Identity.river_surface.cell_size_m
            package_count = [int]$Identity.river_surface.package_count
            cell_count = [int64]$Identity.river_surface.cell_count
            span_count = [int64]$Identity.river_surface.span_count
        }
        lake_surface = [ordered]@{
            release_id = [string]$Identity.lake_surface.release_id
            manifest_sha256 = [string]$Identity.lake_surface.manifest_sha256
            policy = [string]$Identity.lake_surface.policy
            membership_policy = [string]$Identity.lake_surface.membership_policy
            overlap_policy = [string]$Identity.lake_surface.overlap_policy
            grid_fingerprint = [string]$Identity.lake_surface.grid_fingerprint
            cell_size_m = [int]$Identity.lake_surface.cell_size_m
            package_count = [int]$Identity.lake_surface.package_count
            lake_count = [int]$Identity.lake_surface.lake_count
            cell_count = [int64]$Identity.lake_surface.cell_count
            span_count = [int64]$Identity.lake_surface.span_count
        }
        ocean_coast_surface = [ordered]@{
            release_id = [string]$Identity.ocean_coast_surface.release_id
            manifest_sha256 = [string]$Identity.ocean_coast_surface.manifest_sha256
            policy = [string]$Identity.ocean_coast_surface.policy
            selection_policy = [string]$Identity.ocean_coast_surface.selection_policy
            band_morphology = [string]$Identity.ocean_coast_surface.band_morphology
            band_cells = [int]$Identity.ocean_coast_surface.band_cells
            overlap_policy = [string]$Identity.ocean_coast_surface.overlap_policy
            precedence_policy = [string]$Identity.ocean_coast_surface.precedence_policy
            deep_ocean_policy = [string]$Identity.ocean_coast_surface.deep_ocean_policy
            grid_fingerprint = [string]$Identity.ocean_coast_surface.grid_fingerprint
            cell_size_m = [int]$Identity.ocean_coast_surface.cell_size_m
            package_count = [int]$Identity.ocean_coast_surface.package_count
            cell_count = [int64]$Identity.ocean_coast_surface.cell_count
            span_count = [int64]$Identity.ocean_coast_surface.span_count
        }
        riverbank_lakeshore = [ordered]@{
            release_id = [string]$Identity.riverbank_lakeshore.release_id
            manifest_sha256 = [string]$Identity.riverbank_lakeshore.manifest_sha256
            schema = [string]$Identity.riverbank_lakeshore.schema
            policy = [string]$Identity.riverbank_lakeshore.policy
            pipeline_sha = [string]$Identity.riverbank_lakeshore.pipeline_sha
            contract_fingerprint = [string]$Identity.riverbank_lakeshore.contract_fingerprint
            distance_m = [double]$Identity.riverbank_lakeshore.distance_m
            cell_size_m = [int]$Identity.riverbank_lakeshore.cell_size_m
            grid_fingerprint = [string]$Identity.riverbank_lakeshore.grid_fingerprint
            inventory_sha256 = [string]$Identity.riverbank_lakeshore.inventory_sha256
            package_count = [int]$Identity.riverbank_lakeshore.package_count
            selected_package_count = [int]$Identity.riverbank_lakeshore.selected_package_count
            positive_package_count = [int]$Identity.riverbank_lakeshore.positive_package_count
            empty_package_count = [int]$Identity.riverbank_lakeshore.empty_package_count
            source_package_count = [int]$Identity.riverbank_lakeshore.source_package_count
            span_count = [int64]$Identity.riverbank_lakeshore.span_count
            membership_cell_count = [int64]$Identity.riverbank_lakeshore.membership_cell_count
            source_package_fingerprint = [string]$Identity.riverbank_lakeshore.source_package_fingerprint
            selected_package_fingerprint = [string]$Identity.riverbank_lakeshore.selected_package_fingerprint
            deterministic_fingerprint = [string]$Identity.riverbank_lakeshore.deterministic_fingerprint
            source = [ordered]@{
                river = [ordered]@{
                    release_id = [string]$Identity.riverbank_lakeshore.source.river.release_id
                    manifest_sha256 = [string]$Identity.riverbank_lakeshore.source.river.manifest_sha256
                    policy = [string]$Identity.riverbank_lakeshore.source.river.policy
                }
                lake = [ordered]@{
                    release_id = [string]$Identity.riverbank_lakeshore.source.lake.release_id
                    manifest_sha256 = [string]$Identity.riverbank_lakeshore.source.lake.manifest_sha256
                    policy = [string]$Identity.riverbank_lakeshore.source.lake.policy
                }
                world = [ordered]@{
                    release_id = [string]$Identity.riverbank_lakeshore.source.world.release_id
                    manifest_sha256 = [string]$Identity.riverbank_lakeshore.source.world.manifest_sha256
                }
            }
        }
        waterbody_identity_overlay = [ordered]@{
            release_id = [string]$Identity.waterbody_identity_overlay.release_id
            manifest_sha256 = [string]$Identity.waterbody_identity_overlay.manifest_sha256
            schema = [string]$Identity.waterbody_identity_overlay.schema
            schema_version = [string]$Identity.waterbody_identity_overlay.schema_version
            policy = [string]$Identity.waterbody_identity_overlay.policy
            policy_version = [string]$Identity.waterbody_identity_overlay.policy_version
            package_count = [int]$Identity.waterbody_identity_overlay.package_count
            source_cell_count = [int64]$Identity.waterbody_identity_overlay.source_cell_count
            source_span_count = [int64]$Identity.waterbody_identity_overlay.source_span_count
            final_cell_count = [int64]$Identity.waterbody_identity_overlay.final_cell_count
            final_span_count = [int64]$Identity.waterbody_identity_overlay.final_span_count
            identity_registry_fingerprint = [string]$Identity.waterbody_identity_overlay.identity_registry_fingerprint
            deterministic_fingerprint = [string]$Identity.waterbody_identity_overlay.deterministic_fingerprint
            input_release_ids = [ordered]@{
                river = [string]$Identity.waterbody_identity_overlay.input_release_ids.river
                lake = [string]$Identity.waterbody_identity_overlay.input_release_ids.lake
                ocean = [string]$Identity.waterbody_identity_overlay.input_release_ids.ocean
            }
            input_manifests = [ordered]@{
                river = [string]$Identity.waterbody_identity_overlay.input_manifests.river
                lake = [string]$Identity.waterbody_identity_overlay.input_manifests.lake
                ocean = [string]$Identity.waterbody_identity_overlay.input_manifests.ocean
            }
        }
        water_name_index = [ordered]@{
            release_id = [string]$Identity.water_name_index.release_id
            manifest_sha256 = [string]$Identity.water_name_index.manifest_sha256
            schema = [string]$Identity.water_name_index.schema
            policy = [string]$Identity.water_name_index.policy
            entries_filename = [string]$Identity.water_name_index.entries_filename
            entries_format = [string]$Identity.water_name_index.entries_format
            entries_sha256 = [string]$Identity.water_name_index.entries_sha256
            entries_size_bytes = [int64]$Identity.water_name_index.entries_size_bytes
            index_hash = [string]$Identity.water_name_index.index_hash
            deterministic_fingerprint = [string]$Identity.water_name_index.deterministic_fingerprint
            entry_count = [int]$Identity.water_name_index.entry_count
            classes = [ordered]@{
                river = [int]$Identity.water_name_index.classes.river
                lake = [int]$Identity.water_name_index.classes.lake
                ocean = [int]$Identity.water_name_index.classes.ocean
            }
            max_distance_m = [ordered]@{
                river = [double]$Identity.water_name_index.max_distance_m.river
                lake = [double]$Identity.water_name_index.max_distance_m.lake
                ocean = [double]$Identity.water_name_index.max_distance_m.ocean
            }
        }
        water_visual_tiles = [ordered]@{
            release_id = [string]$Identity.water_visual_tiles.release_id
            manifest_sha256 = [string]$Identity.water_visual_tiles.manifest_sha256
            policy = [string]$Identity.water_visual_tiles.policy
            precedence = [string]$Identity.water_visual_tiles.precedence
            surface_policy = [string]$Identity.water_visual_tiles.surface_policy
            freshwater_perimeter_policy = [string]$Identity.water_visual_tiles.freshwater_perimeter_policy
            ocean_coastline_policy = [string]$Identity.water_visual_tiles.ocean_coastline_policy
            deep_ocean_policy = [string]$Identity.water_visual_tiles.deep_ocean_policy
            layers = @($Identity.water_visual_tiles.layers | ForEach-Object { [string]$_ })
            min_zoom = [int]$Identity.water_visual_tiles.min_zoom
            max_zoom = [int]$Identity.water_visual_tiles.max_zoom
            artifact_file = [string]$Identity.water_visual_tiles.artifact_file
            artifact_sha256 = [string]$Identity.water_visual_tiles.artifact_sha256
            artifact_size_bytes = [int64]$Identity.water_visual_tiles.artifact_size_bytes
            tile_count = [int]$Identity.water_visual_tiles.tile_count
        }
    }
    return ($canonical | ConvertTo-Json -Depth 6 -Compress)
}

function Get-AshAtlasWorldGroupId {
    param([Parameter(Mandatory = $true)]$Identity)
    return 'world-' + (Get-AshAtlasStableHash (ConvertTo-AshAtlasCanonicalWorldIdentity $Identity) 16)
}

function Get-AshAtlasWorldRuntimeDescriptor {
    param([Parameter(Mandatory = $true)][string]$LockPath)

    if (-not (Test-Path -LiteralPath $LockPath -PathType Leaf)) { throw "World runtime lock is missing: $LockPath" }
    try { $lock = Get-Content -Raw -LiteralPath $LockPath | ConvertFrom-Json }
    catch { throw "World runtime lock is unreadable: $LockPath. $($_.Exception.Message)" }
    $identity = ConvertTo-AshAtlasWorldIdentity $lock
    return [pscustomobject][ordered]@{
        group_id = Get-AshAtlasWorldGroupId $identity
        canonical_identity = ConvertTo-AshAtlasCanonicalWorldIdentity $identity
        identity = $identity
        port = 0
    }
}

function Test-AshAtlasWorldIdentityEqual {
    param([Parameter(Mandatory = $true)]$Left, [Parameter(Mandatory = $true)]$Right)
    return (ConvertTo-AshAtlasCanonicalWorldIdentity $Left) -ceq (ConvertTo-AshAtlasCanonicalWorldIdentity $Right)
}

function Get-AshAtlasWorldRuntimeRoot {
    if ($env:ASH_ATLAS_WORLD_RUNTIME_ROOT) {
        if ($env:ASH_ATLAS_RUNTIME_TEST_MODE -ne '1') { throw 'World runtime root override is allowed only for isolated acceptance tests.' }
        return [IO.Path]::GetFullPath($env:ASH_ATLAS_WORLD_RUNTIME_ROOT).TrimEnd('\')
    }
    $local = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
    if (-not $local) { $local = $env:LOCALAPPDATA }
    if (-not $local) { throw 'LOCALAPPDATA is unavailable; World API group leases cannot be stored safely.' }
    return Join-Path $local 'AshAtlas\world-runtimes'
}

function Get-AshAtlasWorldGroupPaths {
    param([Parameter(Mandatory = $true)][string]$GroupId)

    if ($GroupId -notmatch '^world-[0-9a-f]{16}$') { throw "Unsafe World API group ID '$GroupId'." }
    $root = Join-Path (Get-AshAtlasWorldRuntimeRoot) $GroupId
    return [pscustomobject][ordered]@{
        root = $root
        state = Join-Path $root 'lease.json'
        logs = Join-Path $root 'logs'
        stdout = Join-Path $root 'logs\world-api.out.log'
        stderr = Join-Path $root 'logs\world-api.err.log'
        source = Join-Path $root 'source'
    }
}

function Enter-AshAtlasWorldRuntimeMutex {
    $mutex = [Threading.Mutex]::new($false, 'Global\AshAtlas_WorldRuntimeGroups')
    $owned = $false
    try {
        try { $owned = $mutex.WaitOne([TimeSpan]::FromMinutes(10)) }
        catch [Threading.AbandonedMutexException] { $owned = $true }
        if (-not $owned) { throw 'Timed out waiting for the machine-wide Ash Atlas World API group lock.' }
        return $mutex
    } catch {
        $mutex.Dispose()
        throw
    }
}

function Exit-AshAtlasWorldRuntimeMutex {
    param([Parameter(Mandatory = $true)]$Mutex)
    $Mutex.ReleaseMutex() | Out-Null
    $Mutex.Dispose()
}

function Read-AshAtlasWorldGroupState {
    param([Parameter(Mandatory = $true)][string]$GroupId)

    $paths = Get-AshAtlasWorldGroupPaths $GroupId
    if (-not (Test-Path -LiteralPath $paths.state -PathType Leaf)) { return $null }
    try { $state = Get-Content -Raw -LiteralPath $paths.state | ConvertFrom-Json }
    catch { throw "REFUSED: World API group lease is unreadable: $($paths.state). $($_.Exception.Message)" }
    if ([int]$state.schema_version -ne 1 -or [string]$state.group_id -ne $GroupId) {
        throw "REFUSED: World API group lease does not match directory $GroupId."
    }
    return $state
}

function Write-AshAtlasWorldGroupState {
    param([Parameter(Mandatory = $true)]$State)

    $paths = Get-AshAtlasWorldGroupPaths ([string]$State.group_id)
    New-Item -ItemType Directory -Path $paths.root -Force | Out-Null
    $temporary = "$($paths.state).$PID.tmp"
    try {
        $State.updated_at_utc = (Get-Date).ToUniversalTime().ToString('o')
        $State | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $temporary -Encoding utf8
        Move-Item -LiteralPath $temporary -Destination $paths.state -Force
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Get-AshAtlasWorldGroupStates {
    $root = Get-AshAtlasWorldRuntimeRoot
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { return @() }
    $states = @()
    foreach ($directory in @(Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue)) {
        if ($directory.Name -notmatch '^world-[0-9a-f]{16}$') { continue }
        $state = Read-AshAtlasWorldGroupState $directory.Name
        if ($null -ne $state) { $states += $state }
    }
    return $states
}

function Test-AshAtlasWorldGroupPortAvailable {
    param(
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][string]$GroupId,
        [Parameter(Mandatory = $true)]$Config,
        [object[]]$ExcludedRanges = @(),
        [int[]]$ListeningPorts = @(),
        [object[]]$DockerMappings = @(),
        [object[]]$GroupStates = @(),
        [int[]]$OwnedListeningPorts = @()
    )

    if ($Port -eq [int]$Config.main.ports.world_api -or $Port -eq 8765) { throw 'Feature World API groups may never use protected Main port 8765.' }
    $start = [int]$Config.feature.world_api_group_port_pool.start
    $end = [int]$Config.feature.world_api_group_port_pool.end
    if ($Port -lt $start -or $Port -gt $end) { throw "World API group port $Port is outside $start-$end." }
    if (Test-AshAtlasPortExcluded $Port $ExcludedRanges) { throw "World API group port $Port is in a Windows excluded TCP range." }
    if (($ListeningPorts -contains $Port) -and ($OwnedListeningPorts -notcontains $Port)) { throw "World API group port $Port has an active TCP listener." }
    $docker = @($DockerMappings | Where-Object { [int]$_.port -eq $Port })
    if ($docker.Count -gt 0) { throw "World API group port $Port is published by Docker container $($docker[0].container)." }
    $other = @($GroupStates | Where-Object { [string]$_.group_id -ne $GroupId -and [int]$_.port -eq $Port })
    if ($other.Count -gt 0) { throw "World API group port $Port is leased to $($other[0].group_id)." }
    return $true
}

function Select-AshAtlasWorldGroupPort {
    param(
        [Parameter(Mandatory = $true)]$Config,
        [Parameter(Mandatory = $true)][string]$GroupId,
        [int]$ExistingPort = 0,
        [object[]]$ExcludedRanges = @(),
        [int[]]$ListeningPorts = @(),
        [object[]]$DockerMappings = @(),
        [object[]]$GroupStates = @(),
        [int[]]$OwnedListeningPorts = @()
    )

    if ($ExistingPort -gt 0) {
        try {
            Test-AshAtlasWorldGroupPortAvailable $ExistingPort $GroupId $Config $ExcludedRanges $ListeningPorts $DockerMappings $GroupStates $OwnedListeningPorts | Out-Null
            return $ExistingPort
        } catch { }
    }
    $start = [int]$Config.feature.world_api_group_port_pool.start
    $end = [int]$Config.feature.world_api_group_port_pool.end
    $count = $end - $start + 1
    $seed = [Convert]::ToUInt32((Get-AshAtlasStableHash $GroupId 8), 16)
    $first = [int]($seed % $count)
    $failures = @()
    foreach ($offset in 0..($count - 1)) {
        $candidate = $start + (($first + $offset) % $count)
        try {
            Test-AshAtlasWorldGroupPortAvailable $candidate $GroupId $Config $ExcludedRanges $ListeningPorts $DockerMappings $GroupStates $OwnedListeningPorts | Out-Null
            return $candidate
        } catch {
            if ($failures.Count -lt 3) { $failures += $_.Exception.Message }
        }
    }
    throw "No safe feature World API group port remains in $start-$end. Sample conflicts: $($failures -join '; ')"
}

function Resolve-AshAtlasRiverSurfaceReleaseRoot {
    param([Parameter(Mandatory = $true)]$Config, [Parameter(Mandatory = $true)]$RiverIdentity)

    $releaseId = [string]$RiverIdentity.release_id
    $expectedHash = [string]$RiverIdentity.manifest_sha256
    if ($releaseId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$' -or $expectedHash -notmatch '^[0-9a-f]{64}$') {
        throw 'REFUSED: river surface release ID or pinned manifest SHA-256 is invalid.'
    }
    $parent = [IO.Path]::GetFullPath((Split-Path -Parent ([string]$Config.release_root))).TrimEnd('\')
    $canonical = Join-Path $parent $releaseId
    $candidates = @($canonical)
    if (Test-Path -LiteralPath $parent -PathType Container) {
        $preservedPattern = '^' + [regex]::Escape($releaseId) + '\.previous-[0-9a-f]{8,64}$'
        $candidates += @(Get-ChildItem -LiteralPath $parent -Directory | Where-Object { $_.Name -cmatch $preservedPattern } |
            Sort-Object Name | ForEach-Object { $_.FullName })
    }
    $matches = @()
    foreach ($candidate in $candidates) {
        if (-not [string]::Equals((Split-Path -Parent $candidate), $parent, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'REFUSED: river surface release must remain directly inside the configured artifacts parent.'
        }
        if (-not (Test-Path -LiteralPath $candidate -PathType Container)) { continue }
        $directory = Get-Item -LiteralPath $candidate -Force
        $manifest = Join-Path $candidate 'manifest.json'
        if (($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'REFUSED: river surface release directory may not redirect outside the artifacts parent.'
        }
        if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { continue }
        if (((Get-Item -LiteralPath $manifest -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'REFUSED: river surface manifest may not be a redirected file.'
        }
        if ((Get-AshAtlasFileSha256 $manifest) -cne $expectedHash) { continue }
        if ($candidate -eq $canonical) { return $canonical }
        $matches += $candidate
    }
    if ($matches.Count -ne 1) {
        throw "REFUSED: expected one preserved river surface release with pinned manifest SHA-256 $expectedHash; found $($matches.Count)."
    }
    return $matches[0]
}

function New-AshAtlasWorldGroupState {
    param([Parameter(Mandatory = $true)]$Config, [Parameter(Mandatory = $true)]$Descriptor, [Parameter(Mandatory = $true)][int]$Port)

    $paths = Get-AshAtlasWorldGroupPaths ([string]$Descriptor.group_id)
    return [pscustomobject][ordered]@{
        schema_version = 1
        group_id = [string]$Descriptor.group_id
        canonical_identity = [string]$Descriptor.canonical_identity
        identity = $Descriptor.identity
        port = $Port
        pid = 0
        process_start_time_utc = ''
        python_executable = ''
        command_line = ''
        map_repository = [IO.Path]::GetFullPath([string]$Config.map_repository).TrimEnd('\')
        source_root = $paths.source
        release_root = [IO.Path]::GetFullPath([string]$Config.release_root).TrimEnd('\')
        river_surface_release_root = Resolve-AshAtlasRiverSurfaceReleaseRoot $Config $Descriptor.identity.river_surface
        lake_surface_release_root = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent ([string]$Config.release_root)) ([string]$Descriptor.identity.lake_surface.release_id))).TrimEnd('\')
        ocean_coast_surface_release_root = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent ([string]$Config.release_root)) ([string]$Descriptor.identity.ocean_coast_surface.release_id))).TrimEnd('\')
        riverbank_lakeshore_release_root = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent ([string]$Config.release_root)) ([string]$Descriptor.identity.riverbank_lakeshore.release_id))).TrimEnd('\')
        waterbody_identity_overlay_release_root = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent ([string]$Config.release_root)) ([string]$Descriptor.identity.waterbody_identity_overlay.release_id))).TrimEnd('\')
        water_name_index_release_root = [IO.Path]::GetFullPath([string]$Config.water_name_index_root).TrimEnd('\')
        members_registered = @()
        members_live = @()
        logs = [pscustomobject][ordered]@{ stdout = $paths.stdout; stderr = $paths.stderr }
        created_at_utc = (Get-Date).ToUniversalTime().ToString('o')
        updated_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    }
}

function Assert-AshAtlasWorldGroupStateIdentity {
    param([Parameter(Mandatory = $true)]$State, [Parameter(Mandatory = $true)]$Descriptor, [Parameter(Mandatory = $true)]$Config)

    if ([string]$State.group_id -ne [string]$Descriptor.group_id -or
        [string]$State.canonical_identity -cne [string]$Descriptor.canonical_identity -or
        -not (Test-AshAtlasWorldIdentityEqual $State.identity $Descriptor.identity)) {
        throw 'REFUSED: World API group lease identity differs from the selected world lock.'
    }
    foreach ($pair in @(
        @{ actual = [string]$State.map_repository; expected = [string]$Config.map_repository; label = 'map repository' },
        @{ actual = [string]$State.release_root; expected = [string]$Config.release_root; label = 'release root' },
        @{ actual = [string]$State.river_surface_release_root; expected = (Resolve-AshAtlasRiverSurfaceReleaseRoot $Config $Descriptor.identity.river_surface); label = 'river surface release root' },
        @{ actual = [string]$State.lake_surface_release_root; expected = (Join-Path (Split-Path -Parent ([string]$Config.release_root)) ([string]$Descriptor.identity.lake_surface.release_id)); label = 'lake surface release root' },
        @{ actual = [string]$State.ocean_coast_surface_release_root; expected = (Join-Path (Split-Path -Parent ([string]$Config.release_root)) ([string]$Descriptor.identity.ocean_coast_surface.release_id)); label = 'ocean coast surface release root' },
        @{ actual = [string]$State.riverbank_lakeshore_release_root; expected = (Join-Path (Split-Path -Parent ([string]$Config.release_root)) ([string]$Descriptor.identity.riverbank_lakeshore.release_id)); label = 'riverbank/lakeshore release root' },
        @{ actual = [string]$State.waterbody_identity_overlay_release_root; expected = (Join-Path (Split-Path -Parent ([string]$Config.release_root)) ([string]$Descriptor.identity.waterbody_identity_overlay.release_id)); label = 'waterbody identity overlay release root' },
        @{ actual = [string](Get-AshAtlasObjectPropertyValue $State 'water_name_index_release_root' ''); expected = [string]$Config.water_name_index_root; label = 'water-name index release root' }
    )) {
        if (-not [string]::Equals([IO.Path]::GetFullPath($pair.actual).TrimEnd('\'), [IO.Path]::GetFullPath($pair.expected).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
            throw "REFUSED: World API group $($pair.label) differs from protected runtime defaults."
        }
    }
}

function Repair-AshAtlasInactiveWorldGroupRiverRoot {
    param([Parameter(Mandatory = $true)]$State, [Parameter(Mandatory = $true)]$Descriptor, [Parameter(Mandatory = $true)]$Config)

    $selectedRoot = Resolve-AshAtlasRiverSurfaceReleaseRoot $Config $Descriptor.identity.river_surface
    if ([string]::Equals([string]$State.river_surface_release_root, $selectedRoot, [StringComparison]::OrdinalIgnoreCase)) { return }
    $canonicalRoot = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent ([string]$Config.release_root)) ([string]$Descriptor.identity.river_surface.release_id))).TrimEnd('\')
    if (-not [string]::Equals([string]$State.river_surface_release_root, $canonicalRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'REFUSED: only the canonical river surface path may be reconciled to its preserved pinned release.'
    }
    $candidate = $State | ConvertTo-Json -Depth 12 | ConvertFrom-Json
    $candidate.river_surface_release_root = $selectedRoot
    Assert-AshAtlasWorldGroupStateIdentity $candidate $Descriptor $Config
    # Called under the existing World group mutex. Never rewrite a live group's command identity.
    $liveProcess = @(if ([int]$State.pid -gt 0) { Get-Process -ErrorAction Stop | Where-Object { $_.Id -eq [int]$State.pid } })
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq [int]$State.port })
    if (@($State.members_live).Count -gt 0 -or $liveProcess.Count -gt 0 -or $listeners.Count -gt 0) {
        throw 'REFUSED: cannot reconcile the river surface path while the World API group is live.'
    }
    $State.river_surface_release_root = $selectedRoot
}

function Get-AshAtlasWorldGroupProcessStatus {
    param([Parameter(Mandatory = $true)]$State)

    if ([int]$State.pid -le 0 -or -not [string]$State.process_start_time_utc) {
        return [pscustomobject]@{ status = 'missing'; process = $null; native = $null }
    }
    $record = [pscustomobject]@{ pid = [int]$State.pid; start_time_utc = $State.process_start_time_utc }
    $identity = Assert-AshAtlasRecordedProcessIdentity $record "World API group $($State.group_id)"
    if ($identity.status -ne 'match') { return [pscustomobject]@{ status = $identity.status; process = $identity.process; native = $null } }
    $native = Get-CimInstance Win32_Process -Filter "ProcessId = $($State.pid)" -ErrorAction SilentlyContinue
    if ($null -eq $native -or -not [string]$native.CommandLine) {
        throw "REFUSED: cannot verify the exact command line for World API group PID $($State.pid)."
    }
    if (-not [string]::Equals([IO.Path]::GetFullPath([string]$native.ExecutablePath), [IO.Path]::GetFullPath([string]$State.python_executable), [StringComparison]::OrdinalIgnoreCase) -or
        [string]$native.CommandLine -cne [string]$State.command_line) {
        throw "REFUSED: World API group PID $($State.pid) no longer matches its recorded executable and command line."
    }
    foreach ($value in @(
        [string]$State.map_repository, [string]$State.source_root, [string]$State.release_root,
        [string]$State.river_surface_release_root, [string]$State.lake_surface_release_root,
        [string]$State.ocean_coast_surface_release_root,
        [string]$State.riverbank_lakeshore_release_root,
        [string](Get-AshAtlasObjectPropertyValue $State 'water_name_index_release_root' ''),
        [string]$State.port,
        [string]$State.identity.pipeline.protected_branch, [string]$State.identity.pipeline.sha,
        [string]$State.identity.river_surface.manifest_sha256,
        [string]$State.identity.river_surface.policy,
        [string]$State.identity.lake_surface.manifest_sha256,
        [string]$State.identity.lake_surface.policy,
        [string]$State.identity.ocean_coast_surface.manifest_sha256,
        [string]$State.identity.ocean_coast_surface.policy,
        [string]$State.identity.riverbank_lakeshore.manifest_sha256,
        [string]$State.identity.riverbank_lakeshore.policy
    )) {
        if ([string]$native.CommandLine -notmatch [regex]::Escape($value)) {
            throw "REFUSED: World API group PID $($State.pid) command line omits required identity '$value'."
        }
    }
    $overlayRoot = [string](Get-AshAtlasObjectPropertyValue $State 'waterbody_identity_overlay_release_root' '')
    $overlayIdentity = Get-AshAtlasObjectPropertyValue $State.identity 'waterbody_identity_overlay' $null
    if ($overlayRoot -and $null -ne $overlayIdentity) {
        foreach ($value in @(
            $overlayRoot,
            [string](Get-AshAtlasObjectPropertyValue $overlayIdentity 'manifest_sha256' '')
        )) {
            if ([string]$native.CommandLine -notmatch [regex]::Escape($value)) {
                throw "REFUSED: World API group PID $($State.pid) command line omits required waterbody identity overlay '$value'."
            }
        }
    }
    $waterNameIndexRoot = [string](Get-AshAtlasObjectPropertyValue $State 'water_name_index_release_root' '')
    $waterNameIndexIdentity = Get-AshAtlasObjectPropertyValue $State.identity 'water_name_index' $null
    if ($waterNameIndexRoot -and $null -ne $waterNameIndexIdentity) {
        foreach ($value in @(
            $waterNameIndexRoot,
            [string](Get-AshAtlasObjectPropertyValue $waterNameIndexIdentity 'manifest_sha256' '')
        )) {
            if ([string]$native.CommandLine -notmatch [regex]::Escape($value)) {
                throw "REFUSED: World API group PID $($State.pid) command line omits required water-name index identity '$value'."
            }
        }
    }
    $owners = @(Get-NetTCPConnection -LocalPort ([int]$State.port) -State Listen -ErrorAction SilentlyContinue)
    if ($owners.Count -ne 1 -or [int]$owners[0].OwningProcess -ne [int]$State.pid) {
        throw "REFUSED: World API group port $($State.port) is not owned only by recorded PID $($State.pid)."
    }
    return [pscustomobject]@{ status = 'match'; process = $identity.process; native = $native }
}

function Assert-AshAtlasWorldHealthIdentity {
    param(
        [Parameter(Mandatory = $true)]$Health,
        [Parameter(Mandatory = $true)]$Identity,
        [ValidateSet('full', 'manifest-only')][string]$ExpectedVerificationMode,
        [string]$ExpectedReleaseRoot
    )

    $problems = [System.Collections.Generic.List[string]]::new()
    if ($Health.ok -ne $true) { $problems.Add('health did not report ok=true') }
    if ([string]$Health.runtime.branch -cne [string]$Identity.pipeline.protected_branch) { $problems.Add('pipeline branch differs') }
    if ([string]$Health.runtime.sha -cne [string]$Identity.pipeline.sha) { $problems.Add('pipeline SHA differs') }
    if ([string]$Health.release.release_id -cne [string]$Identity.release.release_id) { $problems.Add('release ID differs') }
    if ([string]$Health.release.profile_set_fingerprint -cne [string]$Identity.release.profile_set_fingerprint) { $problems.Add('profile-set fingerprint differs') }
    if ([string]$Health.release.build_contract_fingerprint -cne [string]$Identity.release.build_contract_fingerprint) { $problems.Add('build-contract fingerprint differs') }
    if ([string]$Health.release.boundary_release_id -cne [string]$Identity.release.boundary_release_id) { $problems.Add('boundary release ID differs') }
    if ([int]$Health.release.package_count -ne [int]$Identity.release.package_count) { $problems.Add('package count differs') }
    if ([string]$Health.release_verification.release_manifest_sha256 -cne [string]$Identity.release.manifest_sha256) { $problems.Add('manifest SHA-256 differs') }
    if ([int]$Health.release_verification.package_count -ne [int]$Identity.release.package_count) { $problems.Add('verified package count differs') }
    if ([int]$Health.release_verification.artifact_count -ne [int]$Identity.release.artifact_count) { $problems.Add('artifact count differs') }
    if ([string]$Health.river_surface.mode -cne [string]$Identity.river_surface.release_id) { $problems.Add('river surface mode differs') }
    if ([string]$Health.river_surface.identity.release_id -cne [string]$Identity.river_surface.release_id) { $problems.Add('river surface release ID differs') }
    if ([string]$Health.river_surface.identity.manifest_sha256 -cne [string]$Identity.river_surface.manifest_sha256) { $problems.Add('river surface manifest SHA-256 differs') }
    if ([string]$Health.river_surface.identity.policy -cne [string]$Identity.river_surface.policy) { $problems.Add('river surface policy differs') }
    if ([int]$Health.river_surface.cell_size_m -ne [int]$Identity.river_surface.cell_size_m) { $problems.Add('river surface cell size differs') }
    if ([int]$Health.river_surface.cache.max_packages -ne 12) { $problems.Add('river surface cache bound differs') }
    if ([string]$Health.lake_surface.mode -cne [string]$Identity.lake_surface.release_id) { $problems.Add('lake surface mode differs') }
    if ([string]$Health.lake_surface.identity.release_id -cne [string]$Identity.lake_surface.release_id) { $problems.Add('lake surface release ID differs') }
    if ([string]$Health.lake_surface.identity.manifest_sha256 -cne [string]$Identity.lake_surface.manifest_sha256) { $problems.Add('lake surface manifest SHA-256 differs') }
    if ([string]$Health.lake_surface.identity.policy -cne [string]$Identity.lake_surface.policy) { $problems.Add('lake surface policy differs') }
    if ([int]$Health.lake_surface.identity.cell_size_m -ne [int]$Identity.lake_surface.cell_size_m) { $problems.Add('lake surface cell size differs') }
    if ([int]$Health.lake_surface.cache.max_packages -ne 12) { $problems.Add('lake surface cache bound differs') }
    if ([string]$Health.ocean_coast_surface.mode -cne [string]$Identity.ocean_coast_surface.release_id) { $problems.Add('ocean coast surface mode differs') }
    if ([string]$Health.ocean_coast_surface.identity.release_id -cne [string]$Identity.ocean_coast_surface.release_id) { $problems.Add('ocean coast surface release ID differs') }
    if ([string]$Health.ocean_coast_surface.identity.manifest_sha256 -cne [string]$Identity.ocean_coast_surface.manifest_sha256) { $problems.Add('ocean coast surface manifest SHA-256 differs') }
    if ([string]$Health.ocean_coast_surface.identity.policy -cne [string]$Identity.ocean_coast_surface.policy) { $problems.Add('ocean coast surface policy differs') }
    if ([int]$Health.ocean_coast_surface.identity.cell_size_m -ne [int]$Identity.ocean_coast_surface.cell_size_m) { $problems.Add('ocean coast surface cell size differs') }
    if ([int]$Health.ocean_coast_surface.cache.max_packages -ne 12) { $problems.Add('ocean coast surface cache bound differs') }
    $expectedRiverbankLakeshore = Get-AshAtlasObjectPropertyValue $Identity 'riverbank_lakeshore' $null
    $reportedRiverbankLakeshore = Get-AshAtlasObjectPropertyValue $Health 'riverbank_lakeshore' $null
    if ($null -eq $reportedRiverbankLakeshore) {
        $problems.Add('riverbank/lakeshore authority is missing')
    } else {
        $reportedRiverbankLakeshoreIdentity = Get-AshAtlasObjectPropertyValue $reportedRiverbankLakeshore 'identity' $null
        if ([string](Get-AshAtlasObjectPropertyValue $reportedRiverbankLakeshore 'mode' '') -cne
            [string](Get-AshAtlasObjectPropertyValue $expectedRiverbankLakeshore 'release_id' '')) {
            $problems.Add('riverbank/lakeshore mode differs')
        }
        foreach ($field in @('release_id', 'manifest_sha256', 'schema', 'policy', 'pipeline_sha', 'contract_fingerprint', 'grid_fingerprint')) {
            $expectedValue = ConvertTo-Json -InputObject (Get-AshAtlasObjectPropertyValue $expectedRiverbankLakeshore $field '') -Depth 8 -Compress
            $reportedValue = ConvertTo-Json -InputObject (Get-AshAtlasObjectPropertyValue $reportedRiverbankLakeshoreIdentity $field '') -Depth 8 -Compress
            if ($reportedValue -cne $expectedValue) { $problems.Add("riverbank/lakeshore $field differs") }
        }
        foreach ($sourceClass in @('river', 'lake', 'world')) {
            $expectedSource = Get-AshAtlasObjectPropertyValue (Get-AshAtlasObjectPropertyValue $expectedRiverbankLakeshore 'source' $null) $sourceClass $null
            $reportedSource = Get-AshAtlasObjectPropertyValue (Get-AshAtlasObjectPropertyValue $reportedRiverbankLakeshoreIdentity 'source' $null) $sourceClass $null
            foreach ($field in @('release_id', 'manifest_sha256', 'policy')) {
                if ($sourceClass -eq 'world' -and $field -eq 'policy') { continue }
                $expectedValue = [string](Get-AshAtlasObjectPropertyValue $expectedSource $field '')
                $reportedValue = [string](Get-AshAtlasObjectPropertyValue $reportedSource $field '')
                if ($reportedValue -cne $expectedValue) { $problems.Add("riverbank/lakeshore source $sourceClass $field differs") }
            }
        }
        foreach ($field in @('distance_m', 'cell_size_m')) {
            if ([double](Get-AshAtlasObjectPropertyValue $reportedRiverbankLakeshoreIdentity $field -1) -ne
                [double](Get-AshAtlasObjectPropertyValue $expectedRiverbankLakeshore $field -1)) {
                $problems.Add("riverbank/lakeshore $field differs")
            }
        }
        if ([int](Get-AshAtlasObjectPropertyValue (Get-AshAtlasObjectPropertyValue $reportedRiverbankLakeshore 'cache' $null) 'max_packages' 0) -ne 12) {
            $problems.Add('riverbank/lakeshore cache bound differs')
        }
    }
    $expectedOverlay = $Identity.waterbody_identity_overlay
    $reportedOverlay = Get-AshAtlasObjectPropertyValue $Health 'waterbody_identity_overlay' $null
    if ($null -eq $reportedOverlay) {
        $problems.Add('waterbody identity overlay authority is missing')
    } else {
        foreach ($field in @('release_id', 'manifest_sha256', 'schema', 'schema_version', 'policy', 'policy_version')) {
            $expectedValue = [string](Get-AshAtlasObjectPropertyValue $expectedOverlay $field '')
            $reportedValue = [string](Get-AshAtlasObjectPropertyValue $reportedOverlay $field '')
            if ($reportedValue -cne $expectedValue) { $problems.Add("waterbody identity overlay $field differs") }
        }
    }
    $expectedWaterNameIndex = Get-AshAtlasObjectPropertyValue $Identity 'water_name_index' $null
    $reportedWaterNameIndex = Get-AshAtlasObjectPropertyValue $Health 'water_name_index' $null
    if ($null -eq $reportedWaterNameIndex) {
        $problems.Add('water-name index identity is missing')
    } else {
        foreach ($field in @('release_id', 'manifest_sha256', 'schema', 'policy', 'index_hash')) {
            $expectedValue = [string](Get-AshAtlasObjectPropertyValue $expectedWaterNameIndex $field '')
            $reportedValue = [string](Get-AshAtlasObjectPropertyValue $reportedWaterNameIndex $field '')
            if ($reportedValue -cne $expectedValue) { $problems.Add("water-name index $field differs") }
        }
        if ([int](Get-AshAtlasObjectPropertyValue $reportedWaterNameIndex 'entry_count' 0) -ne
            [int](Get-AshAtlasObjectPropertyValue $expectedWaterNameIndex 'entry_count' 0)) {
            $problems.Add('water-name index entry count differs')
        }
        foreach ($waterClass in @('river', 'lake', 'ocean')) {
            $expectedCount = [int](Get-AshAtlasObjectPropertyValue (Get-AshAtlasObjectPropertyValue $expectedWaterNameIndex 'classes' $null) $waterClass 0)
            $reportedCount = [int](Get-AshAtlasObjectPropertyValue (Get-AshAtlasObjectPropertyValue $reportedWaterNameIndex 'classes' $null) $waterClass 0)
            if ($reportedCount -ne $expectedCount) { $problems.Add("water-name index $waterClass class count differs") }
        }
    }
    $reportedReleaseRoot = [string](Get-AshAtlasObjectPropertyValue $Health.release_verification 'release_root' '')
    if ($ExpectedReleaseRoot -and (-not $reportedReleaseRoot -or -not [string]::Equals(
        [IO.Path]::GetFullPath($reportedReleaseRoot).TrimEnd('\'),
        [IO.Path]::GetFullPath($ExpectedReleaseRoot).TrimEnd('\'),
        [StringComparison]::OrdinalIgnoreCase
    ))) { $problems.Add('release root differs') }
    if ($ExpectedVerificationMode -eq 'manifest-only') {
        if ([string](Get-AshAtlasObjectPropertyValue $Health.release_verification 'verification_mode' '') -cne 'manifest-only') { $problems.Add('verification mode differs') }
        if ((Get-AshAtlasObjectPropertyValue $Health.release_verification 'package_artifacts_verified' $null) -ne $false) { $problems.Add('package artifacts were not explicitly reported as unverified') }
        if ([int64](Get-AshAtlasObjectPropertyValue $Health.release_verification 'verified_bytes' -1) -ne 0) { $problems.Add('manifest-only admission reported verified artifact bytes') }
        if ([string](Get-AshAtlasObjectPropertyValue $Health.release_verification 'contract_version' '') -cne 'world-release-manifest-admission-v1') { $problems.Add('manifest admission contract differs') }
    } elseif ($ExpectedVerificationMode -eq 'full') {
        if ([string](Get-AshAtlasObjectPropertyValue $Health.release_verification 'verification_mode' '') -ceq 'manifest-only' -or
            [string](Get-AshAtlasObjectPropertyValue $Health.release_verification 'contract_version' '') -cne 'world-release-whole-verification-v1') {
            $problems.Add('full verification contract differs')
        }
    }
    foreach ($capability in @('flagPlacementWater', 'waterNoBuildOverlay', 'unionedWaterSurface', 'riverWaterAuthorityV1', 'lakeWaterAuthorityV1', 'oceanCoastWaterAuthorityV1', 'riverbankLakeshoreV1', 'waterbodyIdentityV1', 'waterNameFallbackV1')) {
        if ($Health.capabilities.$capability -ne $true) { $problems.Add("missing capability $capability") }
    }
    if ($problems.Count -gt 0) { throw "World API identity check failed: $($problems -join '; ')." }
    return $true
}

function Repair-AshAtlasWorldGroupMembership {
    param(
        [Parameter(Mandatory = $true)]$State,
        [AllowNull()][string[]]$RegisteredRuntimeIds = $null,
        [AllowNull()][string[]]$ActiveRuntimeIds = $null
    )

    if ($null -ne $RegisteredRuntimeIds) {
        $State.members_registered = @($State.members_registered | Where-Object { $RegisteredRuntimeIds -contains [string]$_ } | Select-Object -Unique)
    }
    if ($null -ne $ActiveRuntimeIds) {
        $State.members_live = @($State.members_live | Where-Object { $ActiveRuntimeIds -contains [string]$_ } | Select-Object -Unique)
    }
    return $State
}

function Resolve-AshAtlasFeatureWorldRegistration {
    param(
        [Parameter(Mandatory = $true)]$Config,
        [Parameter(Mandatory = $true)]$Runtime,
        [Parameter(Mandatory = $true)]$Store,
        [switch]$Persist,
        $PreviousWorldRuntime = $null,
        [object[]]$ExcludedRanges = @(),
        [int[]]$ListeningPorts = @(),
        [object[]]$DockerMappings = @(),
        [AllowNull()][string[]]$RegisteredRuntimeIds = $null,
        [AllowNull()][string[]]$ActiveRuntimeIds = $null
    )

    $descriptor = Get-AshAtlasObjectPropertyValue $Runtime 'world_runtime' $null
    if ($null -eq $descriptor) { throw 'Feature runtime is missing its derived World API group identity.' }
    $mutex = Enter-AshAtlasWorldRuntimeMutex
    try {
        $states = @(Get-AshAtlasWorldGroupStates)
        $state = @($states | Where-Object { [string]$_.group_id -eq [string]$descriptor.group_id } | Select-Object -First 1)
        $existingState = if ($state.Count -eq 1) { $state[0] } else { $null }
        if ($Persist -and $null -ne $existingState) {
            Repair-AshAtlasWorldGroupMembership $existingState $RegisteredRuntimeIds $ActiveRuntimeIds | Out-Null
            Repair-AshAtlasInactiveWorldGroupRiverRoot $existingState $descriptor $Config
        }
        $existingPort = if ($null -ne $existingState) { [int]$existingState.port } else { 0 }
        $ownedPorts = @()
        if ($null -ne $existingState -and [int]$existingState.pid -gt 0) {
            try {
                if ((Get-AshAtlasWorldGroupProcessStatus $existingState).status -eq 'match') { $ownedPorts += [int]$existingState.port }
            } catch {
                if (@($existingState.members_live).Count -gt 0) { throw }
                # A stale/reused or foreign PID is never stopped. With no live members it is safe
                # to discard only the untrusted record and allocate around its listener.
                $existingState.pid = 0
                $existingState.process_start_time_utc = ''
                $existingState.python_executable = ''
                $existingState.command_line = ''
            }
        }
        $port = Select-AshAtlasWorldGroupPort $Config $descriptor.group_id $existingPort $ExcludedRanges $ListeningPorts $DockerMappings $states $ownedPorts
        if ($null -eq $existingState) { $existingState = New-AshAtlasWorldGroupState $Config $descriptor $port }
        else {
            Assert-AshAtlasWorldGroupStateIdentity $existingState $descriptor $Config
            if ([int]$existingState.port -ne $port) {
                if (@($existingState.members_live).Count -gt 0) { throw 'REFUSED: cannot reassign a World API group port while a live feature member remains.' }
                $existingState.port = $port
                $existingState.pid = 0
                $existingState.process_start_time_utc = ''
                $existingState.python_executable = ''
                $existingState.command_line = ''
            }
        }
        $descriptor.port = [int]$existingState.port
        $Runtime.ports.world_api = [int]$existingState.port
        $Runtime.world_runtime = $descriptor
        if ($Persist) {
            $existingState.members_registered = @(@($existingState.members_registered) + [string]$Runtime.runtime_id | Where-Object { $_ } | Select-Object -Unique)
            Write-AshAtlasWorldGroupState $existingState
            if ($null -ne $PreviousWorldRuntime -and [string]$PreviousWorldRuntime.group_id -and
                [string]$PreviousWorldRuntime.group_id -ne [string]$descriptor.group_id) {
                $oldState = Read-AshAtlasWorldGroupState ([string]$PreviousWorldRuntime.group_id)
                if ($null -ne $oldState) {
                    Repair-AshAtlasWorldGroupMembership $oldState $RegisteredRuntimeIds $ActiveRuntimeIds | Out-Null
                    Write-AshAtlasWorldGroupState $oldState
                }
                Remove-AshAtlasWorldGroupMember -GroupId ([string]$PreviousWorldRuntime.group_id) -RuntimeId ([string]$Runtime.runtime_id) -Registered
            }
        }
        return $Runtime
    } finally {
        Exit-AshAtlasWorldRuntimeMutex $mutex
    }
}

function Initialize-AshAtlasWorldGroupSource {
    param([Parameter(Mandatory = $true)]$State)

    $paths = Get-AshAtlasWorldGroupPaths ([string]$State.group_id)
    $marker = Join-Path $paths.source '.ash-atlas-world-source.json'
    if (Test-Path -LiteralPath $marker -PathType Leaf) {
        $record = Get-Content -Raw -LiteralPath $marker | ConvertFrom-Json
        if ([string]$record.pipeline_sha -eq [string]$State.identity.pipeline.sha -and
            (Test-Path -LiteralPath (Join-Path $paths.source 'src\map_world_pipeline\__main__.py') -PathType Leaf)) {
            return $paths.source
        }
        throw 'REFUSED: materialized World API source marker differs from the group identity.'
    }
    if (Test-Path -LiteralPath $paths.source) { throw 'REFUSED: World API group source directory exists without its ownership marker.' }
    New-Item -ItemType Directory -Path $paths.root -Force | Out-Null
    $temporarySource = "$($paths.source).$PID.tmp"
    $temporaryArchive = Join-Path $paths.root "source.$PID.tar.tmp"
    try {
        New-Item -ItemType Directory -Path $temporarySource -Force | Out-Null
        $commitCheck = Invoke-AshAtlasNative git @('-C', [string]$State.map_repository, 'cat-file', '-e', "$($State.identity.pipeline.sha)^{commit}")
        if ($commitCheck.ExitCode -ne 0) { throw "Map repository does not contain locked commit $($State.identity.pipeline.sha)." }
        $protectedRef = "refs/remotes/origin/$($State.identity.pipeline.protected_branch)"
        $refCheck = Invoke-AshAtlasNative git @('-C', [string]$State.map_repository, 'show-ref', '--verify', '--quiet', $protectedRef)
        if ($refCheck.ExitCode -ne 0) { throw "Map repository is missing protected remote ref $protectedRef; fetch it before starting the group." }
        $ancestry = Invoke-AshAtlasNative git @('-C', [string]$State.map_repository, 'merge-base', '--is-ancestor', [string]$State.identity.pipeline.sha, $protectedRef)
        if ($ancestry.ExitCode -ne 0) { throw "Locked map commit $($State.identity.pipeline.sha) is not contained by $protectedRef." }
        $archive = Invoke-AshAtlasNative git @('-C', [string]$State.map_repository, 'archive', '--format=tar', "--output=$temporaryArchive", [string]$State.identity.pipeline.sha)
        if ($archive.ExitCode -ne 0) { throw "Could not archive locked map source: $($archive.StdErr.Trim())" }
        $extract = Invoke-AshAtlasNative tar @('-xf', $temporaryArchive, '-C', $temporarySource)
        if ($extract.ExitCode -ne 0) { throw "Could not materialize locked map source: $($extract.StdErr.Trim())" }
        [ordered]@{
            schema_version = 1
            pipeline_repository = [string]$State.identity.pipeline.repository
            pipeline_branch = [string]$State.identity.pipeline.protected_branch
            pipeline_sha = [string]$State.identity.pipeline.sha
            created_at_utc = (Get-Date).ToUniversalTime().ToString('o')
        } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $temporarySource '.ash-atlas-world-source.json') -Encoding utf8
        Move-Item -LiteralPath $temporarySource -Destination $paths.source
    } finally {
        if (Test-Path -LiteralPath $temporaryArchive) { Remove-Item -LiteralPath $temporaryArchive -Force }
        if (Test-Path -LiteralPath $temporarySource) { Remove-Item -LiteralPath $temporarySource -Recurse -Force }
    }
    return $paths.source
}

function Get-AshAtlasWorldGroupAdmissionBudget {
    <#
    World API admission budget contract. Manifest-only startup remains at 600 seconds.
    The exhaustive proof measured a 605.532 second peak wall time and
    3,251,499,008 private bytes (3.028 GiB), so full startup receives 720 seconds.
    Full verification remains exhaustive; the map verifier's existing 4 GiB private-memory
    hard cap is unchanged.
    #>
    return [pscustomobject][ordered]@{
        manifest_only_health_timeout_seconds = 600
        full_health_timeout_seconds = 720
        full_observed_peak_wall_seconds = 605.532
        full_observed_peak_private_memory_bytes = [int64]3251499008
        private_memory_hard_cap_bytes = [int64]4294967296
        full_verification_mode = 'exhaustive'
    }
}

function Get-AshAtlasWorldGroupHealthTimeoutSeconds {
    param([switch]$FullWorldVerify)

    $budget = Get-AshAtlasWorldGroupAdmissionBudget
    if ($FullWorldVerify) { return [int]$budget.full_health_timeout_seconds }
    return [int]$budget.manifest_only_health_timeout_seconds
}

function Wait-AshAtlasWorldGroupHealth {
    param([Parameter(Mandatory = $true)]$State, [int]$TimeoutSeconds = 600)

    $uri = "http://127.0.0.1:$($State.port)/api/health"
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $health = Invoke-RestMethod -Uri $uri -TimeoutSec 5
            $expectedMode = if ([string]$State.command_line -match '--artifact-verification-mode[ =]full(?:\s|$)') { 'full' } else { 'manifest-only' }
            Assert-AshAtlasWorldHealthIdentity $health $State.identity $expectedMode ([string]$State.release_root) | Out-Null
            return $health
        } catch { Start-Sleep -Milliseconds 500 }
    }
    throw "Timed out waiting for compatible World API group $($State.group_id) at $uri."
}

function Get-AshAtlasWorldModuleRoot {
    param([Parameter(Mandatory = $true)][string]$SourceRoot)

    $canonicalSource = [IO.Path]::GetFullPath($SourceRoot).TrimEnd('\')
    $moduleRoot = [IO.Path]::GetFullPath((Join-Path $canonicalSource 'src')).TrimEnd('\')
    $entryPoint = Join-Path $moduleRoot 'map_world_pipeline\__main__.py'
    if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) {
        throw "REFUSED: materialized World API source is missing its src-layout entry point: $entryPoint"
    }
    return $moduleRoot
}

function Start-AshAtlasWorldGroupProcess {
    param(
        [Parameter(Mandatory = $true)]$State,
        [switch]$FullWorldVerify
    )

    $paths = Get-AshAtlasWorldGroupPaths ([string]$State.group_id)
    New-Item -ItemType Directory -Path $paths.logs -Force | Out-Null
    $sourceRoot = Initialize-AshAtlasWorldGroupSource $State
    $moduleRoot = Get-AshAtlasWorldModuleRoot $sourceRoot
    $python = (Get-Command python -ErrorAction Stop).Source
    $bootstrap = "import runpy,sys;sys.path.insert(0,sys.argv.pop(1));sys.argv.pop(1);runpy.run_module('map_world_pipeline',run_name='__main__')"
    $verificationMode = if ($FullWorldVerify) { 'full' } else { 'manifest-only' }
    if ($FullWorldVerify) {
        Write-Host 'Full World verification requested: verifying all 64,800 packages.' -ForegroundColor DarkGray
    }
    $arguments = @(
        '-c', $bootstrap, $moduleRoot, [string]$State.map_repository, 'serve-world-release', '--release-root', [string]$State.release_root,
        '--host', '127.0.0.1', '--port', [string]$State.port, '--cache-packages', '12',
        '--overlay-max-features', '2000', '--overlay-max-packages', '64',
        '--runtime-branch', [string]$State.identity.pipeline.protected_branch,
        '--runtime-sha', [string]$State.identity.pipeline.sha,
        '--artifact-verification-mode', $verificationMode,
        '--expected-manifest-sha256', [string]$State.identity.release.manifest_sha256,
        '--expected-release-root', [string]$State.release_root,
        '--river-surface-mode', [string]$State.identity.river_surface.release_id,
        '--river-surface-release-root', [string]$State.river_surface_release_root,
        '--river-surface-manifest-sha256', [string]$State.identity.river_surface.manifest_sha256,
        '--river-surface-policy', [string]$State.identity.river_surface.policy,
        '--river-surface-cache-packages', '12',
        '--lake-surface-release-root', [string]$State.lake_surface_release_root,
        '--lake-surface-manifest-sha256', [string]$State.identity.lake_surface.manifest_sha256,
        '--lake-surface-policy', [string]$State.identity.lake_surface.policy,
        '--lake-surface-cache-packages', '12',
        '--ocean-coast-surface-release-root', [string]$State.ocean_coast_surface_release_root,
        '--ocean-coast-surface-manifest-sha256', [string]$State.identity.ocean_coast_surface.manifest_sha256,
        '--ocean-coast-surface-policy', [string]$State.identity.ocean_coast_surface.policy,
        '--ocean-coast-surface-cache-packages', '12',
        '--riverbank-lakeshore-release-root', [string]$State.riverbank_lakeshore_release_root,
        '--riverbank-lakeshore-manifest-sha256', [string]$State.identity.riverbank_lakeshore.manifest_sha256,
        '--riverbank-lakeshore-policy', [string]$State.identity.riverbank_lakeshore.policy,
        '--riverbank-lakeshore-cache-packages', '12',
        '--waterbody-identity-overlay-release-root', [string]$State.waterbody_identity_overlay_release_root,
        '--waterbody-identity-overlay-manifest-sha256', [string]$State.identity.waterbody_identity_overlay.manifest_sha256,
        '--waterbody-identity-overlay-cache-packages', '12',
        '--water-name-index-root', [string](Get-AshAtlasObjectPropertyValue $State 'water_name_index_release_root' ''),
        '--water-name-index-manifest-sha256', [string]$State.identity.water_name_index.manifest_sha256
    )
    $argumentLine = (@($arguments | ForEach-Object { ConvertTo-AshAtlasNativeArgument ([string]$_) }) -join ' ')
    $process = Start-Process -FilePath $python -ArgumentList $argumentLine -WorkingDirectory $sourceRoot `
        -WindowStyle Hidden -PassThru -RedirectStandardOutput $paths.stdout -RedirectStandardError $paths.stderr
    try {
        $deadline = (Get-Date).AddSeconds(10)
        $native = $null
        while ((Get-Date) -lt $deadline -and ($null -eq $native -or -not [string]$native.CommandLine)) {
            Start-Sleep -Milliseconds 50
            $native = Get-CimInstance Win32_Process -Filter "ProcessId = $($process.Id)" -ErrorAction SilentlyContinue
        }
        if ($null -eq $native -or -not [string]$native.CommandLine) { throw 'Could not capture the new World API process command line.' }
        $State.pid = [int]$process.Id
        $State.process_start_time_utc = $process.StartTime.ToUniversalTime().ToString('o')
        $State.python_executable = [IO.Path]::GetFullPath([string]$native.ExecutablePath)
        $State.command_line = [string]$native.CommandLine
        Write-AshAtlasWorldGroupState $State
        $healthTimeoutSeconds = Get-AshAtlasWorldGroupHealthTimeoutSeconds -FullWorldVerify:$FullWorldVerify
        Wait-AshAtlasWorldGroupHealth $State $healthTimeoutSeconds | Out-Null
        if ($FullWorldVerify) {
            Write-Host "Full World verification completed for $($State.group_id)." -ForegroundColor DarkGray
        } else {
            Write-Host 'Fast local World admission: manifest and identity verified; exhaustive package scan skipped.' -ForegroundColor DarkGray
        }
        return $State
    } catch {
        $current = Get-Process -Id $process.Id -ErrorAction SilentlyContinue
        if ($null -ne $current -and $current.StartTime.ToUniversalTime().ToString('o') -eq $process.StartTime.ToUniversalTime().ToString('o')) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
        $State.pid = 0
        $State.process_start_time_utc = ''
        $State.python_executable = ''
        $State.command_line = ''
        Write-AshAtlasWorldGroupState $State
        throw
    }
}

function Ensure-AshAtlasFeatureWorldRuntime {
    param(
        [Parameter(Mandatory = $true)]$Config,
        [Parameter(Mandatory = $true)]$Runtime,
        [switch]$FullWorldVerify
    )

    $descriptor = Get-AshAtlasObjectPropertyValue $Runtime 'world_runtime' $null
    if ($null -eq $descriptor -or [int]$Runtime.ports.world_api -eq 8765) { throw 'Feature runtime has no safe World API group assignment.' }
    $mutex = Enter-AshAtlasWorldRuntimeMutex
    try {
        $state = Read-AshAtlasWorldGroupState ([string]$descriptor.group_id)
        if ($null -eq $state) { throw 'Feature World API group lease is missing; run feature-runtime.ps1 sync.' }
        Assert-AshAtlasWorldGroupStateIdentity $state $descriptor $Config
        if ([int]$state.port -ne [int]$Runtime.ports.world_api) { throw 'Feature World API group port differs from the runtime lease.' }
        $listeners = @(Get-NetTCPConnection -LocalPort ([int]$state.port) -State Listen -ErrorAction SilentlyContinue)
        if ($listeners.Count -gt 0) {
            $processStatus = Get-AshAtlasWorldGroupProcessStatus $state
            if ($processStatus.status -ne 'match') { throw 'REFUSED: World API group listener is not exactly owned.' }
            $existingIsFull = [string]$state.command_line -match '--artifact-verification-mode[ =]full(?:\s|$)'
            if ($FullWorldVerify -and -not $existingIsFull) {
                Stop-AshAtlasWorldGroupProcess $state
                Write-AshAtlasWorldGroupState $state
                $state = Start-AshAtlasWorldGroupProcess $state -FullWorldVerify:$FullWorldVerify
            } else {
                Wait-AshAtlasWorldGroupHealth $state 30 | Out-Null
                Write-Host "Reusing World API $($state.group_id) on port $($state.port)." -ForegroundColor DarkGray
            }
        } else {
            if ([int]$state.pid -gt 0) {
                $record = [pscustomobject]@{ pid = [int]$state.pid; start_time_utc = $state.process_start_time_utc }
                $status = Assert-AshAtlasRecordedProcessIdentity $record "World API group $($state.group_id)"
                if ($status.status -eq 'match') { throw 'REFUSED: recorded World API group process is live but does not own its assigned port.' }
                $state.pid = 0
                $state.process_start_time_utc = ''
                $state.python_executable = ''
                $state.command_line = ''
            }
            $state = Start-AshAtlasWorldGroupProcess $state -FullWorldVerify:$FullWorldVerify
        }
        $state.members_live = @(@($state.members_live) + [string]$Runtime.runtime_id | Where-Object { $_ } | Select-Object -Unique)
        Write-AshAtlasWorldGroupState $state
        return $state
    } finally {
        Exit-AshAtlasWorldRuntimeMutex $mutex
    }
}

function Stop-AshAtlasWorldGroupProcess {
    param([Parameter(Mandatory = $true)]$State)

    if ([int]$State.pid -le 0) { return }
    $status = Get-AshAtlasWorldGroupProcessStatus $State
    if ($status.status -eq 'match') {
        Wait-AshAtlasWorldGroupHealth $State 5 | Out-Null
        Stop-Process -Id ([int]$State.pid) -ErrorAction Stop
        Wait-AshAtlasBoundedCondition -Condition {
            (Get-Process -Id ([int]$State.pid) -ErrorAction SilentlyContinue) -eq $null
        } -TimeoutSeconds 30 -PollMilliseconds 100 -TimeoutMessage "Timed out stopping exact World API group PID $($State.pid)."
    }
    $State.pid = 0
    $State.process_start_time_utc = ''
    $State.python_executable = ''
    $State.command_line = ''
}

function Remove-AshAtlasWorldGroupMember {
    param(
        [Parameter(Mandatory = $true)][string]$GroupId,
        [Parameter(Mandatory = $true)][string]$RuntimeId,
        [switch]$Registered,
        [switch]$Live
    )

    $state = Read-AshAtlasWorldGroupState $GroupId
    if ($null -eq $state) { return }
    if ($Registered) { $state.members_registered = @($state.members_registered | Where-Object { [string]$_ -ne $RuntimeId }) }
    if ($Live) { $state.members_live = @($state.members_live | Where-Object { [string]$_ -ne $RuntimeId }) }
    if (@($state.members_live).Count -eq 0 -and [int]$state.pid -gt 0) { Stop-AshAtlasWorldGroupProcess $state }
    if (@($state.members_registered).Count -eq 0 -and @($state.members_live).Count -eq 0) {
        $paths = Get-AshAtlasWorldGroupPaths $GroupId
        if ([int]$state.pid -gt 0) { throw 'REFUSED: cannot remove a World API group lease while its exact process remains.' }
        if (Test-Path -LiteralPath $paths.root -PathType Container) { Remove-Item -LiteralPath $paths.root -Recurse -Force }
    } else { Write-AshAtlasWorldGroupState $state }
}

function Release-AshAtlasFeatureWorldRuntime {
    param([Parameter(Mandatory = $true)]$Runtime, [switch]$Unregister)

    $descriptor = Get-AshAtlasObjectPropertyValue $Runtime 'world_runtime' $null
    if ($null -eq $descriptor -or -not [string]$descriptor.group_id) { return }
    $mutex = Enter-AshAtlasWorldRuntimeMutex
    try {
        Remove-AshAtlasWorldGroupMember -GroupId ([string]$descriptor.group_id) -RuntimeId ([string]$Runtime.runtime_id) -Live -Registered:$Unregister
    } finally {
        Exit-AshAtlasWorldRuntimeMutex $mutex
    }
}

function Get-AshAtlasWorldGroupStatus {
    param([Parameter(Mandatory = $true)]$Runtime)

    $descriptor = Get-AshAtlasObjectPropertyValue $Runtime 'world_runtime' $null
    if ($null -eq $descriptor) { return $null }
    $state = Read-AshAtlasWorldGroupState ([string]$descriptor.group_id)
    if ($null -eq $state) { return [pscustomobject]@{ compatible = $false; message = 'group lease missing'; state = $null; health = $null } }
    try {
        $process = Get-AshAtlasWorldGroupProcessStatus $state
        $health = if ($process.status -eq 'match') { Wait-AshAtlasWorldGroupHealth $state 5 } else { $null }
        return [pscustomobject]@{ compatible = ($process.status -eq 'match'); message = $process.status; state = $state; health = $health }
    } catch {
        return [pscustomobject]@{ compatible = $false; message = $_.Exception.Message; state = $state; health = $null }
    }
}
