ALTER TABLE flags
  DROP CONSTRAINT IF EXISTS flags_health_valid;

UPDATE flags
SET health = CASE
      WHEN anchor_kind = 'flag' AND control_type = 'personal'
        AND city_id IS NULL AND kingdom_id IS NULL
        AND reinforcement_level = 0 THEN 100
      WHEN anchor_kind = 'flag' AND control_type = 'personal'
        AND city_id IS NULL AND kingdom_id IS NULL
        AND reinforcement_level IN (1, 3)
        THEN LEAST(COALESCE(health, 200), 200)
      ELSE NULL
    END,
    maximum_health = CASE
      WHEN anchor_kind = 'flag' AND control_type = 'personal'
        AND city_id IS NULL AND kingdom_id IS NULL
        AND reinforcement_level = 0 THEN 100
      WHEN anchor_kind = 'flag' AND control_type = 'personal'
        AND city_id IS NULL AND kingdom_id IS NULL
        AND reinforcement_level IN (1, 3) THEN 200
      ELSE NULL
    END;

-- Existing flag rows can schedule deferred geometry/control trigger events.
-- Flush those events before changing the table definition below so populated
-- upgrades are safe as well as empty installs.
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
      AND maximum_health = CASE WHEN reinforcement_level = 0 THEN 100 ELSE 200 END
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

COMMENT ON COLUMN flags.health IS
  'Current durability for ordinary personal flags (100) and bastion Flags/Towers (200); NULL for buoys, Atlas Shrines, and controlled structures.';
COMMENT ON COLUMN flags.maximum_health IS
  'Maximum durability for ordinary personal flags (100) and bastion Flags/Towers (200); NULL for buoys, Atlas Shrines, and controlled structures.';

-- Keep direct data/import paths aligned with the same durability invariant as
-- the application placement and affiliation paths. Existing test/admin tools
-- often omit optional health columns when creating a flag, so ordinary
-- personal flags receive their authoritative full value here while controlled
-- and non-flag anchors remain healthless.
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
    NEW.maximum_health := CASE WHEN NEW.reinforcement_level = 0 THEN 100 ELSE 200 END;
    NEW.health := COALESCE(NEW.health, NEW.maximum_health);
  ELSE
    NEW.health := NULL;
    NEW.maximum_health := NULL;
    NEW.burning_started_at := NULL;
    NEW.burning_until := NULL;
    NEW.burning_reason := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS flags_sync_health_defaults ON flags;
CREATE TRIGGER flags_sync_health_defaults
BEFORE INSERT OR UPDATE OF anchor_kind, control_type, city_id, kingdom_id,
  reinforcement_level, health, maximum_health
ON flags
FOR EACH ROW
EXECUTE FUNCTION sync_flag_health_defaults();

ALTER TABLE flag_burn_operations
  ADD COLUMN IF NOT EXISTS reinforcement_level smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS burn_duration_ms bigint NOT NULL DEFAULT 25000;

DO $$
DECLARE
  constraint_row record;
BEGIN
  FOR constraint_row IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'flag_burn_operations'::regclass
      AND pg_get_constraintdef(oid) LIKE '%completes_at%'
      AND pg_get_constraintdef(oid) LIKE '%started_at%'
  LOOP
    EXECUTE format(
      'ALTER TABLE flag_burn_operations DROP CONSTRAINT %I',
      constraint_row.conname
    );
  END LOOP;
END $$;

ALTER TABLE flag_burn_operations
  DROP CONSTRAINT IF EXISTS flag_burn_operations_completes_at_check,
  DROP CONSTRAINT IF EXISTS flag_burn_operations_check,
  DROP CONSTRAINT IF EXISTS flag_burn_operations_duration_check;

-- Reconcile any V1 operation that was still active when this contract was
-- installed. V1 only admitted soft flags, but deriving the tier from the
-- retained target keeps this migration safe if a future compatible writer
-- had already persisted a hardened operation.
UPDATE flag_burn_operations operation
SET reinforcement_level = CASE
      WHEN flag.reinforcement_level IN (1, 3) THEN flag.reinforcement_level
      ELSE 0
    END,
    burn_duration_ms = CASE
      WHEN flag.reinforcement_level IN (1, 3) THEN 43200000
      ELSE 25000
    END,
    completes_at = operation.started_at + CASE
      WHEN flag.reinforcement_level IN (1, 3) THEN interval '12 hours'
      ELSE interval '25 seconds'
    END
FROM flags flag
WHERE flag.id = operation.flag_id;

UPDATE flags flag
SET health = 100,
    burning_started_at = operation.started_at,
    burning_until = operation.completes_at,
    burning_reason = 'flag_burn'
FROM flag_burn_operations operation
WHERE operation.flag_id = flag.id
  AND operation.status = 'active'
  AND operation.completes_at > operation.started_at
  AND flag.anchor_kind = 'flag'
  AND flag.control_type = 'personal'
  AND flag.city_id IS NULL
  AND flag.kingdom_id IS NULL
  AND flag.reinforcement_level IN (0, 1, 3);

ALTER TABLE flag_burn_operations
  ADD CONSTRAINT flag_burn_operations_duration_check CHECK (
    burn_duration_ms IN (25000, 43200000)
    AND completes_at = started_at + (burn_duration_ms * interval '1 millisecond')
  );

ALTER TABLE flag_burn_operations
  DROP CONSTRAINT IF EXISTS flag_burn_operations_reinforcement_check;
ALTER TABLE flag_burn_operations
  ADD CONSTRAINT flag_burn_operations_reinforcement_check CHECK (reinforcement_level IN (0, 1, 3));

COMMENT ON TABLE flag_burn_operations IS
  'Durable soft (25-second) and hardened (12-hour) player Flag burning operations. The operation is authoritative; flags.burning_* is a presentation mirror.';

CREATE TABLE IF NOT EXISTS flag_attack_cooldowns (
  flag_id uuid NOT NULL REFERENCES flags(id) ON DELETE CASCADE,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  attacked_at timestamptz NOT NULL,
  PRIMARY KEY (flag_id, player_id)
);

CREATE INDEX IF NOT EXISTS flag_attack_cooldowns_recent_idx
  ON flag_attack_cooldowns (player_id, attacked_at DESC);

CREATE TABLE IF NOT EXISTS flag_attack_operations (
  operation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_id uuid NOT NULL REFERENCES flags(id) ON DELETE CASCADE,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL,
  damage smallint NOT NULL CHECK (damage > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (player_id, request_id)
);

CREATE INDEX IF NOT EXISTS flag_attack_operations_flag_idx
  ON flag_attack_operations (flag_id, created_at DESC);
