-- The house-backed city feature (12024e9a, admitted by 205cbb45) treated a
-- founder as a provisional Mayor and built the founder's first house as a
-- Mayor House. Founding and confirmed Mayor control are separate authorities.
--
-- Explicit Mayor claims are durably distinguishable by a claim_mayor
-- operation and/or promoted_to_mayor_house event. Automatic construction
-- completion has neither record, so those rows can be repaired without
-- changing legitimate explicit Mayors.

UPDATE cities
SET mayor_player_id = NULL,
    mayor_house_deadline = CASE
      WHEN mayor_player_id = founder_player_id
       AND mayor_house_deadline > clock_timestamp()
        THEN mayor_house_deadline
      ELSE NULL
    END,
    spatial_revision = spatial_revision + 1
WHERE mayor_player_id IS NOT NULL
  AND mayor_confirmed_at IS NULL;

DO $$
DECLARE
  candidate record;
BEGIN
  FOR candidate IN
    SELECT structure.structure_id,
           structure.city_id,
           structure.owner_player_id,
           city.created_at
    FROM city_structures structure
    JOIN cities city ON city.id = structure.city_id
    WHERE structure.structure_type = 'mayor_house'
      AND structure.state = 'active'
      AND structure.owner_player_id = city.founder_player_id
      AND city.mayor_player_id = city.founder_player_id
      AND city.mayor_confirmed_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM city_structure_operations operation
        WHERE operation.city_id = structure.city_id
          AND operation.structure_id = structure.structure_id
          AND operation.action = 'claim_mayor'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM city_structure_events event
        WHERE event.city_id = structure.city_id
          AND event.structure_id = structure.structure_id
          AND event.event_type = 'promoted_to_mayor_house'
      )
  LOOP
    UPDATE city_memberships
    SET role = 'member'
    WHERE city_id = candidate.city_id
      AND player_id = candidate.owner_player_id
      AND house_structure_id = candidate.structure_id
      AND left_at IS NULL
      AND role = 'mayor';

    UPDATE city_structures
    SET structure_type = 'city_house',
        placement_revision = placement_revision + 1,
        updated_at = clock_timestamp()
    WHERE structure_id = candidate.structure_id
      AND structure_type = 'mayor_house'
      AND state = 'active';

    UPDATE cities
    SET mayor_player_id = NULL,
        mayor_confirmed_at = NULL,
        mayor_house_deadline = CASE
          WHEN candidate.created_at + interval '15 minutes' > clock_timestamp()
            THEN candidate.created_at + interval '15 minutes'
          ELSE NULL
        END,
        spatial_revision = spatial_revision + 1
    WHERE id = candidate.city_id
      AND mayor_player_id = candidate.owner_player_id
      AND mayor_confirmed_at IS NOT NULL;
  END LOOP;
END
$$;

UPDATE city_structures structure
SET structure_type = 'city_house',
    placement_revision = placement_revision + 1,
    updated_at = clock_timestamp()
FROM cities city
WHERE city.id = structure.city_id
  AND structure.structure_type = 'mayor_house'
  AND structure.state = 'constructing'
  AND structure.owner_player_id = city.founder_player_id
  AND NOT EXISTS (
    SELECT 1
    FROM city_structure_operations operation
    WHERE operation.city_id = structure.city_id
      AND operation.structure_id = structure.structure_id
      AND operation.action = 'claim_mayor'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM city_structure_events event
    WHERE event.city_id = structure.city_id
      AND event.structure_id = structure.structure_id
      AND event.event_type = 'promoted_to_mayor_house'
  );

UPDATE cities
SET mayor_house_deadline = NULL,
    spatial_revision = spatial_revision + 1
WHERE mayor_house_deadline IS NOT NULL
  AND mayor_house_deadline <= clock_timestamp();
