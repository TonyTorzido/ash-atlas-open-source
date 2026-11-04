-- Buoys and Atlas Shrines (the Atlas Shrine) are attackable.
--   Buoy:          220 max HP, 50% burn threshold, 14 s burn (the soft flag profile).
--   Atlas Shrine:  3,300 max HP, 50% burn threshold, 27 h burn.
-- Both used to be immune (NULL health).
--
-- flags_health_valid requires maximum_health = flag_warfare_maximum_health(...),
-- so the seven-argument overload is recreated first (1156 is not edited). It
-- calls only built-ins, so nothing needs schema-qualifying for pg_restore; the
-- 8- and 9-argument overloads (0942) delegate to it unchanged. Mirrors
-- structureWarfareProfileForFlag in packages/shared/src/structureWarfare.ts.
CREATE OR REPLACE FUNCTION public.flag_warfare_maximum_health(
  p_anchor_kind text,
  p_control_type text,
  p_system_controlled boolean,
  p_city_id uuid,
  p_kingdom_id uuid,
  p_reinforcement_level smallint,
  p_tower_level smallint
) RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_system_controlled OR p_anchor_kind IS NULL OR p_anchor_kind NOT IN ('flag', 'buoy') THEN NULL
    WHEN p_anchor_kind = 'buoy' THEN
      CASE
        WHEN p_control_type = 'personal' AND p_city_id IS NULL AND p_kingdom_id IS NULL
          AND p_reinforcement_level = 0 THEN 220
        ELSE NULL
      END
    WHEN p_control_type = 'personal' AND p_city_id IS NULL AND p_kingdom_id IS NULL THEN
      CASE p_reinforcement_level
        WHEN 0 THEN 220
        WHEN 1 THEN 220
        WHEN 2 THEN 3300
        WHEN 3 THEN CASE
          WHEN COALESCE(p_tower_level, 1) BETWEEN 1 AND 25
            THEN 2700 + 440 * (COALESCE(p_tower_level, 1) - 1)
          ELSE NULL
        END
        ELSE NULL
      END
    WHEN p_control_type = 'city' AND p_city_id IS NOT NULL AND p_kingdom_id IS NULL THEN
      CASE WHEN p_tower_level IS NULL THEN 4500 WHEN p_tower_level = 1 THEN 36500 ELSE NULL END
    WHEN p_control_type = 'city_seat' AND p_city_id IS NOT NULL AND p_kingdom_id IS NULL
      AND p_tower_level IS NULL THEN 230000
    WHEN p_control_type = 'kingdom' AND p_kingdom_id IS NOT NULL AND p_city_id IS NULL THEN
      CASE WHEN p_tower_level IS NULL THEN 220
           WHEN p_tower_level BETWEEN 1 AND 5 THEN 11500 * p_tower_level
           ELSE NULL END
    WHEN p_control_type = 'kingdom_seat' AND p_kingdom_id IS NOT NULL AND p_city_id IS NULL
      AND p_tower_level IS NULL THEN 230000
    ELSE NULL
  END
$$;

-- Existing Buoys and Atlas Shrines start at full health. Writing health fires
-- flags_sync_health_defaults, which fills both columns from the function
-- above. Idempotent: only rows that still have no health are touched.
UPDATE flags
SET health = public.flag_warfare_maximum_health(
      anchor_kind, control_type, system_controlled, city_id, kingdom_id,
      reinforcement_level, tower_level, obelisk_level, war_structure_kind
    ),
    maximum_health = public.flag_warfare_maximum_health(
      anchor_kind, control_type, system_controlled, city_id, kingdom_id,
      reinforcement_level, tower_level, obelisk_level, war_structure_kind
    )
WHERE maximum_health IS NULL
  AND system_controlled = false
  AND control_type = 'personal'
  AND city_id IS NULL
  AND kingdom_id IS NULL
  AND (
    (anchor_kind = 'buoy' AND reinforcement_level = 0)
    OR (anchor_kind = 'flag' AND reinforcement_level = 2)
  );

-- Flush deferred flag-control trigger events before altering other tables.
SET CONSTRAINTS ALL IMMEDIATE;

-- An Atlas Shrine (reinforcement level 2) can now be burned.
ALTER TABLE flag_burn_operations
  DROP CONSTRAINT IF EXISTS flag_burn_operations_reinforcement_check;
ALTER TABLE flag_burn_operations
  ADD CONSTRAINT flag_burn_operations_reinforcement_check CHECK (reinforcement_level IN (0, 1, 2, 3));
