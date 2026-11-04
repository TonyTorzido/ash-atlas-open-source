-- Forward-only personal Flag durability balance.
-- Base Flags are soft 100-health anchors, Stone is the hardened 200-health
-- tier, and Towers use the 2,700-health maximum.  Existing Tower rows keep
-- their retained health percentage (rescaled onto a 2,700-point base, never
-- above it) before the new invariant is installed.

ALTER TABLE flags
  DROP CONSTRAINT IF EXISTS flags_health_valid;

ALTER TABLE flag_burn_operations
  DROP CONSTRAINT IF EXISTS flag_burn_operations_duration_check,
  DROP CONSTRAINT IF EXISTS flag_burn_operations_lifecycle_check;

CREATE OR REPLACE FUNCTION sync_flag_health_defaults()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.anchor_kind = 'flag'
     AND NEW.control_type = 'personal'
     AND NEW.city_id IS NULL
     AND NEW.kingdom_id IS NULL
     AND NEW.reinforcement_level IN (0, 1, 3) THEN
    NEW.maximum_health := CASE NEW.reinforcement_level
      WHEN 0 THEN 100
      WHEN 1 THEN 200
      WHEN 3 THEN 2700
    END;
    NEW.health := COALESCE(NEW.health, NEW.maximum_health);
  ELSE
    NEW.health := NULL;
    NEW.maximum_health := NULL;
    NEW.burning_started_at := NULL;
    NEW.burning_until := NULL;
    NEW.burning_reason := NULL;
    NEW.damage_cycle_id := NULL;
  END IF;
  RETURN NEW;
END;
$$;

-- Preserve the old percentage for existing Towers while correcting their
-- maximum.  A legacy Base that was still carrying 200/200 is normalized to
-- the soft 100/100 contract; Stone remains 200/200.
UPDATE flags
SET maximum_health = CASE reinforcement_level
      WHEN 0 THEN 100
      WHEN 1 THEN 200
      WHEN 3 THEN 2700
    END,
    health = CASE
      WHEN reinforcement_level = 0 THEN LEAST(COALESCE(health, 100), 100)
      WHEN reinforcement_level = 1 THEN LEAST(COALESCE(health, 200), 200)
      WHEN reinforcement_level = 3 THEN LEAST(
        2700,
        GREATEST(
          0,
          ROUND(
            COALESCE(health, maximum_health, 200)::numeric * 2700 /
              NULLIF(COALESCE(maximum_health, 200), 0)
          )::integer
        )
      )
    END
WHERE anchor_kind = 'flag'
  AND control_type = 'personal'
  AND city_id IS NULL
  AND kingdom_id IS NULL
  AND reinforcement_level IN (0, 1, 3);

-- Every retained burn operation uses the tier's exact current duration.  The
-- operation remains the source of truth; active flag mirrors are reconciled
-- below after their completion deadlines are corrected.
UPDATE flag_burn_operations
SET burn_duration_ms = CASE reinforcement_level
      WHEN 0 THEN 25000
      WHEN 1 THEN 79200000
      WHEN 3 THEN 79200000
      ELSE burn_duration_ms
    END,
    completes_at = started_at + CASE reinforcement_level
      WHEN 0 THEN interval '25 seconds'
      WHEN 1 THEN interval '22 hours'
      WHEN 3 THEN interval '22 hours'
      ELSE (completes_at - started_at)
    END
WHERE reinforcement_level IN (0, 1, 3);

-- 0820 made the remaining-duration column durable for paused repairs.  Keep
-- that captured value for paused rows, but refresh active unpaused rows from
-- the corrected database-clock deadline before reinstating the lifecycle
-- invariant below.
UPDATE flag_burn_operations
SET remaining_duration_ms = CASE
      WHEN status = 'active' AND paused_at IS NULL THEN GREATEST(
        0,
        FLOOR(EXTRACT(EPOCH FROM (completes_at - clock_timestamp())) * 1000)
      )::bigint
      WHEN status = 'active' THEN LEAST(
        GREATEST(COALESCE(remaining_duration_ms, 0), 0),
        burn_duration_ms
      )
      ELSE 0
    END
WHERE reinforcement_level IN (0, 1, 3);

UPDATE flags flag
SET health = CASE flag.reinforcement_level
      WHEN 0 THEN 100
      WHEN 1 THEN 100
      WHEN 3 THEN 1350
    END,
    burning_until = operation.completes_at,
    burning_started_at = operation.started_at,
    burning_reason = 'flag_burn'
FROM flag_burn_operations operation
WHERE operation.flag_id = flag.id
  AND operation.status = 'active'
  AND flag.anchor_kind = 'flag'
  AND flag.control_type = 'personal'
  AND flag.city_id IS NULL
  AND flag.kingdom_id IS NULL
  AND flag.reinforcement_level IN (0, 1, 3);

-- The populated upgrade may have queued deferred flag-control trigger events
-- while rewriting durability. Flush them before altering the table definition.
SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE flags
  ADD CONSTRAINT flags_health_valid CHECK (
    (
      anchor_kind = 'flag' AND control_type = 'personal'
      AND city_id IS NULL AND kingdom_id IS NULL
      AND reinforcement_level IN (0, 1, 3)
      AND health IS NOT NULL
      AND maximum_health IS NOT NULL
      AND health BETWEEN 0 AND maximum_health
      AND maximum_health = CASE reinforcement_level
        WHEN 0 THEN 100
        WHEN 1 THEN 200
        WHEN 3 THEN 2700
      END
    )
    OR
    (
      NOT (
        anchor_kind = 'flag' AND control_type = 'personal'
        AND city_id IS NULL AND kingdom_id IS NULL
        AND reinforcement_level IN (0, 1, 3)
      )
      AND health IS NULL
      AND maximum_health IS NULL
    )
  );

ALTER TABLE flag_burn_operations
  ADD CONSTRAINT flag_burn_operations_duration_check CHECK (
    burn_duration_ms IN (25000, 79200000)
    AND completes_at = started_at + (burn_duration_ms * interval '1 millisecond')
  ),
  ADD CONSTRAINT flag_burn_operations_lifecycle_check CHECK (
    burn_duration_ms IN (25000, 79200000)
    AND remaining_duration_ms >= 0
    AND (paused_at IS NULL OR status = 'active')
  );

COMMENT ON COLUMN flags.health IS
  'Current durability for ordinary personal Flags (100), hardened Stone Flags (200), and Towers (2700); NULL for buoys, Atlas Shrines, and controlled structures.';
COMMENT ON COLUMN flags.maximum_health IS
  'Maximum durability for ordinary personal Flags (100), hardened Stone Flags (200), and Towers (2700); NULL for buoys, Atlas Shrines, and controlled structures.';
COMMENT ON TABLE flag_burn_operations IS
  'Durable soft (25-second) and hardened (22-hour) player Flag burning operations. The operation is authoritative; flags.burning_* is a presentation mirror.';
