WITH retired AS (
  UPDATE city_structures
  SET state = 'destroyed',
      built_at = COALESCE(
        built_at,
        construction_completes_at,
        construction_started_at,
        created_at,
        clock_timestamp()
      ),
      destroyed_at = clock_timestamp(),
      placement_revision = placement_revision + 1,
      updated_at = clock_timestamp()
  WHERE structure_type IN ('weaponsmith', 'armory')
    AND state IN ('constructing', 'active')
  RETURNING structure_id
)
SELECT count(*) FROM retired;

UPDATE city_structure_operations operation
SET result = CASE operation.action
      WHEN 'destroy_facility' THEN jsonb_build_object(
        'structure', jsonb_build_object(
          'structureId', structure.structure_id::text,
          'cityId', structure.city_id::text,
          'type', structure.structure_type,
          'tier', structure.tier,
          'ownerPlayerId', structure.owner_player_id,
          'worldId', structure.world_id,
          'regionCode', structure.region_code,
          'lat', structure.lat,
          'lon', structure.lon,
          'footprintRadiusM', structure.footprint_radius_m,
          'placementRevision', structure.placement_revision::text,
          'state', structure.state,
          'constructionStartedAt', to_jsonb(structure.construction_started_at),
          'constructionCompletesAt', to_jsonb(structure.construction_completes_at),
          'builtAt', to_jsonb(structure.built_at),
          'upgradedAt', to_jsonb(structure.upgraded_at),
          'destroyedAt', to_jsonb(structure.destroyed_at)
        ),
        'droppedItems', '[]'::jsonb
      )
      ELSE jsonb_build_object(
        'structure', jsonb_build_object(
          'structureId', structure.structure_id::text,
          'cityId', structure.city_id::text,
          'type', structure.structure_type,
          'tier', structure.tier,
          'ownerPlayerId', structure.owner_player_id,
          'worldId', structure.world_id,
          'regionCode', structure.region_code,
          'lat', structure.lat,
          'lon', structure.lon,
          'footprintRadiusM', structure.footprint_radius_m,
          'placementRevision', structure.placement_revision::text,
          'state', structure.state,
          'constructionStartedAt', to_jsonb(structure.construction_started_at),
          'constructionCompletesAt', to_jsonb(structure.construction_completes_at),
          'builtAt', to_jsonb(structure.built_at),
          'upgradedAt', to_jsonb(structure.upgraded_at),
          'destroyedAt', to_jsonb(structure.destroyed_at)
        )
      )
    END,
    completed_at = COALESCE(structure.destroyed_at, clock_timestamp())
FROM city_structures structure
WHERE operation.structure_id = structure.structure_id
  AND operation.completed_at IS NULL
  AND operation.action IN ('build_facility', 'upgrade_facility', 'destroy_facility')
  AND structure.structure_type IN ('weaponsmith', 'armory')
  AND structure.state = 'destroyed';
