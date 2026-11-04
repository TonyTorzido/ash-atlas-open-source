-- Personal City military facilities.
--
-- Barracks and Demolition Factories are now player-owned, one of each per
-- player. Armory and any duplicate legacy military rows are retired or
-- consolidated in place so their durable jobs and invested structure value
-- are not silently detached from the City record.

CREATE TABLE IF NOT EXISTS military_personal_facility_migrations (
  migration_id bigserial PRIMARY KEY,
  city_id uuid NOT NULL REFERENCES cities(id) ON DELETE RESTRICT,
  source_structure_id uuid NOT NULL UNIQUE REFERENCES city_structures(structure_id) ON DELETE RESTRICT,
  source_type text NOT NULL CHECK (source_type IN (
    'armory', 'siege_workshop', 'powder_works', 'barracks', 'demolition_factory'
  )),
  action text NOT NULL CHECK (action IN (
    'converted_to_demolition_factory', 'retired_duplicate', 'assigned_owner'
  )),
  target_structure_id uuid NULL REFERENCES city_structures(structure_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE city_structures
  DROP CONSTRAINT IF EXISTS city_structures_owner_shape_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'city_structures'::regclass
      AND conname = 'city_structures_owner_shape_check'
  ) THEN
    ALTER TABLE city_structures
      ADD CONSTRAINT city_structures_owner_shape_check CHECK (
        (structure_type IN ('city_house', 'mayor_house', 'oil_well') AND owner_player_id IS NOT NULL)
        OR
        (structure_type IN ('barracks', 'demolition_factory') AND owner_player_id IS NOT NULL)
        OR
        (structure_type IN (
          'warehouse', 'cistern_warrens', 'salon', 'city_kennel', 'market', 'monument',
          'weaponsmith', 'armory', 'barracks', 'demolition_factory',
          'siege_workshop', 'powder_works'
        ) AND owner_player_id IS NULL)
      );
  END IF;
END $$;

-- The old city-wide facility reservation covered military rows. Personal
-- facilities use the owner index below; civic services remain one per City.
DROP INDEX IF EXISTS city_structures_one_active_facility_type_idx;
DROP INDEX IF EXISTS city_structures_one_reserved_facility_type_idx;
CREATE UNIQUE INDEX IF NOT EXISTS city_structures_one_reserved_civic_facility_type_idx
  ON city_structures (city_id, structure_type)
  WHERE state IN ('constructing', 'active')
    AND structure_type IN ('warehouse', 'cistern_warrens', 'salon', 'city_kennel');

-- Move every open Armory job to an existing factory before retiring the old
-- structure. If the City has no factory, preserve the structure identity and
-- location by converting the Armory in place.
DO $$
DECLARE
  legacy record;
  target record;
BEGIN
  FOR legacy IN
    SELECT structure_id, city_id, structure_type
    FROM city_structures
    WHERE structure_type = 'armory'
      AND state IN ('constructing', 'active')
    ORDER BY city_id,
      CASE WHEN state = 'active' THEN 0 ELSE 1 END,
      created_at, structure_id
  LOOP
    SELECT structure_id
    INTO target
    FROM city_structures
    WHERE city_id = legacy.city_id
      AND structure_type = 'demolition_factory'
      AND state IN ('constructing', 'active')
    ORDER BY CASE WHEN state = 'active' THEN 0 ELSE 1 END,
      created_at, structure_id
    LIMIT 1;

    IF target.structure_id IS NULL THEN
      UPDATE city_structures
      SET structure_type = 'demolition_factory',
          owner_player_id = COALESCE(
            owner_player_id,
            (SELECT COALESCE(mayor_player_id, founder_player_id)
             FROM cities WHERE id = legacy.city_id)
          ),
          footprint_radius_m = 22,
          footprint_geom = ST_Buffer(
            ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography,
            22
          )::geometry,
          updated_at = clock_timestamp()
      WHERE structure_id = legacy.structure_id
        AND structure_type = legacy.structure_type
        AND state IN ('constructing', 'active');

      INSERT INTO military_personal_facility_migrations (
        city_id, source_structure_id, source_type, action, target_structure_id
      ) VALUES (
        legacy.city_id, legacy.structure_id, legacy.structure_type,
        'converted_to_demolition_factory', legacy.structure_id
      ) ON CONFLICT (source_structure_id) DO NOTHING;
    ELSE
      UPDATE military_facility_jobs
      SET facility_structure_id = target.structure_id,
          updated_at = clock_timestamp()
      WHERE facility_structure_id = legacy.structure_id
        AND cleared_at IS NULL;

      UPDATE city_structures
      SET state = 'destroyed',
          built_at = COALESCE(built_at, construction_started_at, clock_timestamp()),
          destroyed_at = COALESCE(destroyed_at, clock_timestamp()),
          placement_revision = placement_revision + 1,
          updated_at = clock_timestamp()
      WHERE structure_id = legacy.structure_id
        AND state IN ('constructing', 'active');

      INSERT INTO military_personal_facility_migrations (
        city_id, source_structure_id, source_type, action, target_structure_id
      ) VALUES (
        legacy.city_id, legacy.structure_id, legacy.structure_type,
        'retired_duplicate', target.structure_id
      ) ON CONFLICT (source_structure_id) DO NOTHING;
    END IF;
  END LOOP;
END $$;

-- 0824 already converts one Siege Workshop or Powder Works when needed. Any
-- additional live legacy row is now inert compatibility history; move its
-- jobs to the consolidated factory and retire the duplicate row.
DO $$
DECLARE
  legacy record;
  target record;
BEGIN
  FOR legacy IN
    SELECT structure_id, city_id, structure_type
    FROM city_structures
    WHERE structure_type IN ('siege_workshop', 'powder_works')
      AND state IN ('constructing', 'active')
    ORDER BY city_id, created_at, structure_id
  LOOP
    SELECT structure_id
    INTO target
    FROM city_structures
    WHERE city_id = legacy.city_id
      AND structure_type = 'demolition_factory'
      AND state IN ('constructing', 'active')
    ORDER BY CASE WHEN state = 'active' THEN 0 ELSE 1 END,
      created_at, structure_id
    LIMIT 1;

    IF target.structure_id IS NULL THEN
      UPDATE city_structures
      SET structure_type = 'demolition_factory',
          owner_player_id = COALESCE(
            owner_player_id,
            (SELECT COALESCE(mayor_player_id, founder_player_id)
             FROM cities WHERE id = legacy.city_id)
          ),
          footprint_radius_m = 22,
          footprint_geom = ST_Buffer(
            ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography,
            22
          )::geometry,
          updated_at = clock_timestamp()
      WHERE structure_id = legacy.structure_id
        AND structure_type = legacy.structure_type
        AND state IN ('constructing', 'active');
      target.structure_id := legacy.structure_id;
      INSERT INTO military_personal_facility_migrations (
        city_id, source_structure_id, source_type, action, target_structure_id
      ) VALUES (
        legacy.city_id, legacy.structure_id, legacy.structure_type,
        'converted_to_demolition_factory', legacy.structure_id
      ) ON CONFLICT (source_structure_id) DO NOTHING;
    ELSE
      UPDATE military_facility_jobs
      SET facility_structure_id = target.structure_id,
          updated_at = clock_timestamp()
      WHERE facility_structure_id = legacy.structure_id
        AND cleared_at IS NULL;
      UPDATE city_structures
      SET state = 'destroyed',
          built_at = COALESCE(built_at, construction_started_at, clock_timestamp()),
          destroyed_at = COALESCE(destroyed_at, clock_timestamp()),
          placement_revision = placement_revision + 1,
          updated_at = clock_timestamp()
      WHERE structure_id = legacy.structure_id
        AND state IN ('constructing', 'active');
      INSERT INTO military_personal_facility_migrations (
        city_id, source_structure_id, source_type, action, target_structure_id
      ) VALUES (
        legacy.city_id, legacy.structure_id, legacy.structure_type,
        'retired_duplicate', target.structure_id
      ) ON CONFLICT (source_structure_id) DO NOTHING;
    END IF;
  END LOOP;
END $$;

-- Existing City-funded military structures receive deterministic ownership
-- from the City's current Mayor or founder. Newly built rows use the actor.
UPDATE city_structures structure
SET owner_player_id = COALESCE(city.mayor_player_id, city.founder_player_id),
    updated_at = clock_timestamp()
FROM cities city
WHERE city.id = structure.city_id
  AND structure.structure_type IN ('barracks', 'demolition_factory')
  AND structure.state IN ('constructing', 'active')
  AND structure.owner_player_id IS NULL;

INSERT INTO military_personal_facility_migrations (
  city_id, source_structure_id, source_type, action, target_structure_id
)
SELECT structure.city_id, structure.structure_id, structure.structure_type,
       'assigned_owner', structure.structure_id
FROM city_structures structure
WHERE structure.structure_type IN ('barracks', 'demolition_factory')
  AND structure.state IN ('constructing', 'active')
  AND structure.owner_player_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM military_personal_facility_migrations migration
    WHERE migration.source_structure_id = structure.structure_id
  )
ON CONFLICT (source_structure_id) DO NOTHING;

-- A player may retain at most one active or constructing facility of each
-- type. Keep the oldest active row, then the oldest construction, and move
-- any pending production jobs to that retained facility before retiring the
-- duplicate structure. The loop makes the retirement and its audit row
-- idempotent when this SQL is replayed manually.
DO $$
DECLARE
  duplicate_row record;
BEGIN
  FOR duplicate_row IN
    SELECT ranked.structure_id,
           ranked.retained_structure_id,
           structure.city_id,
           structure.structure_type
    FROM (
      SELECT structure_id,
             first_value(structure_id) OVER (
               PARTITION BY owner_player_id, structure_type
               ORDER BY CASE WHEN state = 'active' THEN 0 ELSE 1 END,
                 created_at, structure_id
             ) AS retained_structure_id
      FROM city_structures
      WHERE owner_player_id IS NOT NULL
        AND structure_type IN ('barracks', 'demolition_factory')
        AND state IN ('constructing', 'active')
    ) ranked
    JOIN city_structures structure ON structure.structure_id = ranked.structure_id
    WHERE ranked.structure_id <> ranked.retained_structure_id
    ORDER BY structure.city_id, structure.structure_type, structure.created_at,
      structure.structure_id
  LOOP
    UPDATE military_facility_jobs
    SET facility_structure_id = duplicate_row.retained_structure_id,
        updated_at = clock_timestamp()
    WHERE facility_structure_id = duplicate_row.structure_id
      AND cleared_at IS NULL;

    UPDATE city_structures
    SET state = 'destroyed',
        built_at = COALESCE(
          built_at, construction_completes_at, construction_started_at,
          created_at, clock_timestamp()
        ),
        destroyed_at = COALESCE(destroyed_at, clock_timestamp()),
        placement_revision = placement_revision + 1,
        updated_at = clock_timestamp()
    WHERE structure_id = duplicate_row.structure_id
      AND state IN ('constructing', 'active');

    INSERT INTO military_personal_facility_migrations (
      city_id, source_structure_id, source_type, action, target_structure_id
    ) VALUES (
      duplicate_row.city_id, duplicate_row.structure_id,
      duplicate_row.structure_type, 'retired_duplicate',
      duplicate_row.retained_structure_id
    ) ON CONFLICT (source_structure_id) DO NOTHING;
  END LOOP;
END $$;

-- Complete any pre-migration build/upgrade operation attached to a retired
-- or converted structure so the construction supervisor cannot strand an
-- incomplete replay record. The structure row and its immutable history stay.
UPDATE city_structure_operations operation
SET result = jsonb_build_object(
      'structure', jsonb_build_object(
        'structureId', structure.structure_id::text,
        'cityId', structure.city_id::text,
        'type', structure.structure_type,
        'tier', structure.tier,
        'ownerPlayerId', structure.owner_player_id,
        'state', structure.state,
        'placementRevision', structure.placement_revision::text
      ),
      'migration', '0825'
    ),
    completed_at = COALESCE(structure.destroyed_at, structure.updated_at, clock_timestamp())
FROM military_personal_facility_migrations migration
JOIN city_structures structure
  ON structure.structure_id = migration.source_structure_id
WHERE operation.structure_id = structure.structure_id
  AND operation.completed_at IS NULL
  AND operation.action IN ('build_facility', 'upgrade_facility', 'destroy_facility')
  AND migration.action IN ('converted_to_demolition_factory', 'retired_duplicate');

CREATE UNIQUE INDEX IF NOT EXISTS city_structures_one_reserved_personal_military_type_idx
  ON city_structures (owner_player_id, structure_type)
  WHERE owner_player_id IS NOT NULL
    AND state IN ('constructing', 'active')
    AND structure_type IN ('barracks', 'demolition_factory');

COMMENT ON TABLE military_personal_facility_migrations IS
  'Forward-only ownership, consolidation, and duplicate-retirement audit for personal military facilities.';
