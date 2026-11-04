-- A soft (unhardened) personal flag has 220 max HP (was 100) and
-- burns for 14 s (was 25 s). The 50% burn budget scales with it (110 HP).
--
-- flags_health_valid requires maximum_health = flag_warfare_maximum_health(...),
-- so the function is recreated first (0942 is not edited). This overload calls
-- only built-ins, so nothing needs schema-qualifying for pg_restore; the
-- overloads that call each other were already qualified by 0942 and are
-- unchanged. Atlas shrines, buoys and every other tier keep their values.
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
    WHEN p_anchor_kind IS DISTINCT FROM 'flag' OR p_system_controlled THEN NULL
    WHEN p_control_type = 'personal' AND p_city_id IS NULL AND p_kingdom_id IS NULL THEN
      CASE p_reinforcement_level
        WHEN 0 THEN 220
        WHEN 1 THEN 220
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

-- Existing soft flags: raise the maximum to 220 and scale the current health (cap 220).
-- Idempotent: only rows still at the old maximum of 100 are touched.
UPDATE flags
SET maximum_health = 220,
    health = LEAST(220, ceil(COALESCE(health, 100) * 2.2)::int)
WHERE anchor_kind = 'flag'
  AND control_type = 'personal'
  AND city_id IS NULL
  AND kingdom_id IS NULL
  AND reinforcement_level = 0
  AND maximum_health = 100;

-- Stone flags and kingdom flags that were at the older 200 maximum move to 220.
UPDATE flags
SET maximum_health = 220,
    health = LEAST(220, ceil(COALESCE(health, 200) * 1.1)::int)
WHERE anchor_kind = 'flag'
  AND maximum_health = 200
  AND (
    (control_type = 'personal' AND city_id IS NULL AND kingdom_id IS NULL AND reinforcement_level = 1)
    OR (control_type = 'kingdom' AND kingdom_id IS NOT NULL AND city_id IS NULL AND tower_level IS NULL)
  );

-- Flush deferred flag-control trigger events before altering other tables.
SET CONSTRAINTS ALL IMMEDIATE;

-- 14 s soft burn; 25 s stays valid for retained historical operations.
ALTER TABLE flag_burn_operations
  DROP CONSTRAINT IF EXISTS flag_burn_operations_duration_check,
  DROP CONSTRAINT IF EXISTS flag_burn_operations_lifecycle_check;
ALTER TABLE flag_burn_operations
  ADD CONSTRAINT flag_burn_operations_duration_check CHECK (
    burn_duration_ms IN (14000, 25000, 79200000, 97200000, 324000000)
    AND completes_at > started_at
  ),
  ADD CONSTRAINT flag_burn_operations_lifecycle_check CHECK (
    burn_duration_ms IN (14000, 25000, 79200000, 97200000, 324000000)
    AND remaining_duration_ms >= 0
    AND (paused_at IS NULL OR status = 'active')
  );
ALTER TABLE flag_burn_operations ALTER COLUMN burn_duration_ms SET DEFAULT 14000;
