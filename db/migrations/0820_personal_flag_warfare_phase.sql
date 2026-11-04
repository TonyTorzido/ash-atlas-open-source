-- Personal Flag warfare phase: one 200 durability track, durable damage cycles,
-- and restart-safe contested repair/disruption.  This migration intentionally
-- stays personal-Flag specific; it does not create generalized siege state.

ALTER TABLE flags
  ADD COLUMN IF NOT EXISTS damage_cycle_id uuid;

ALTER TABLE flag_attack_operations
  ADD COLUMN IF NOT EXISTS damage_cycle_id uuid;

ALTER TABLE flag_burn_operations
  ADD COLUMN IF NOT EXISTS damage_cycle_id uuid,
  ADD COLUMN IF NOT EXISTS remaining_duration_ms bigint,
  ADD COLUMN IF NOT EXISTS paused_at timestamptz;

DO $$
DECLARE
  constraint_row record;
BEGIN
  FOR constraint_row IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'flag_burn_operations'::regclass
      AND (
        pg_get_constraintdef(oid) LIKE '%completes_at%'
        OR conname IN (
          'flag_burn_operations_duration_check',
          'flag_burn_operations_status_check',
          'flag_burn_operations_lifecycle_check'
        )
      )
  LOOP
    EXECUTE format(
      'ALTER TABLE flag_burn_operations DROP CONSTRAINT %I',
      constraint_row.conname
    );
  END LOOP;
END $$;

-- Replace the old default trigger before rewriting populated rows.  The
-- trigger is also the guard for direct import/admin paths after the upgrade.
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
    NEW.maximum_health := 200;
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

ALTER TABLE flags
  DROP CONSTRAINT IF EXISTS flags_health_valid,
  DROP CONSTRAINT IF EXISTS flags_burning_state_valid;

-- Preserve every active burn and give each damaged/active flag one durable
-- cycle.  Historical attack contributors remain unassigned because they did
-- not carry cycle identity in the prior schema.
UPDATE flags flag
SET damage_cycle_id = COALESCE(flag.damage_cycle_id, gen_random_uuid())
FROM flag_burn_operations operation
WHERE operation.flag_id = flag.id
  AND operation.status = 'active'
  AND flag.anchor_kind = 'flag'
  AND flag.control_type = 'personal'
  AND flag.city_id IS NULL
  AND flag.kingdom_id IS NULL
  AND flag.reinforcement_level IN (0, 1, 3);

UPDATE flags
SET damage_cycle_id = gen_random_uuid()
WHERE damage_cycle_id IS NULL
  AND anchor_kind = 'flag'
  AND control_type = 'personal'
  AND city_id IS NULL
  AND kingdom_id IS NULL
  AND reinforcement_level IN (0, 1, 3)
  AND (
    COALESCE(health, 200) < 200
    OR COALESCE(maximum_health, 200) <> 200
  )
  -- A legacy Base at 100/100 (or an omitted legacy health value) was a
  -- healthy flag, not evidence of hostile damage.  Preserve synthetic
  -- cycles only for genuinely damaged rows; active burns were assigned a
  -- cycle above regardless of their current presentation health.
  AND NOT (
    reinforcement_level = 0
    AND COALESCE(maximum_health, 100) = 100
    AND COALESCE(health, 100) >= 100
  );

UPDATE flag_burn_operations operation
SET damage_cycle_id = COALESCE(operation.damage_cycle_id, flag.damage_cycle_id, gen_random_uuid())
FROM flags flag
WHERE operation.flag_id = flag.id;

UPDATE flags flag
SET damage_cycle_id = operation.damage_cycle_id
FROM flag_burn_operations operation
WHERE operation.flag_id = flag.id
  AND operation.status = 'active'
  AND operation.damage_cycle_id IS NOT NULL
  AND flag.damage_cycle_id IS NULL;

UPDATE flags flag
SET maximum_health = 200,
    health = CASE
      WHEN EXISTS (
        SELECT 1
        FROM flag_burn_operations operation
        WHERE operation.flag_id = flag.id AND operation.status = 'active'
      ) THEN LEAST(COALESCE(flag.health, 100), 100)
      WHEN flag.reinforcement_level = 0
           AND COALESCE(flag.maximum_health, 100) = 100 THEN 200
      ELSE LEAST(COALESCE(flag.health, 200), 200)
    END
WHERE flag.anchor_kind = 'flag'
  AND flag.control_type = 'personal'
  AND flag.city_id IS NULL
  AND flag.kingdom_id IS NULL
  AND flag.reinforcement_level IN (0, 1, 3);

-- The populated upgrade may have queued deferred flag-control trigger events
-- while rewriting health.  Flush them before altering the table definition.
SET CONSTRAINTS ALL IMMEDIATE;

UPDATE flag_burn_operations
SET remaining_duration_ms = CASE
  WHEN status = 'active'
    THEN GREATEST(
      0,
      FLOOR(EXTRACT(EPOCH FROM (completes_at - clock_timestamp())) * 1000)
    )::bigint
  ELSE 0
END
WHERE remaining_duration_ms IS NULL;

ALTER TABLE flag_burn_operations
  ALTER COLUMN remaining_duration_ms SET DEFAULT 0,
  ALTER COLUMN remaining_duration_ms SET NOT NULL;

ALTER TABLE flags
  ADD CONSTRAINT flags_health_valid CHECK (
    (
      anchor_kind = 'flag' AND control_type = 'personal'
      AND city_id IS NULL AND kingdom_id IS NULL
      AND reinforcement_level IN (0, 1, 3)
      AND health IS NOT NULL
      AND maximum_health IS NOT NULL
      AND health BETWEEN 0 AND maximum_health
      AND maximum_health = 200
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

ALTER TABLE flags
  ADD CONSTRAINT flags_burning_state_valid CHECK (
    (burning_started_at IS NULL AND burning_until IS NULL AND burning_reason IS NULL)
    OR
    (burning_started_at IS NOT NULL AND burning_until IS NOT NULL
     AND burning_until > burning_started_at
     AND burning_reason IN ('legendary_event', 'flag_burn'))
  );

ALTER TABLE flag_burn_operations
  ADD CONSTRAINT flag_burn_operations_status_check CHECK (
    (status = 'active' AND completed_at IS NULL)
    OR (status IN ('cancelled', 'completed') AND completed_at IS NOT NULL)
  ),
  ADD CONSTRAINT flag_burn_operations_lifecycle_check CHECK (
    burn_duration_ms IN (25000, 43200000)
    AND remaining_duration_ms >= 0
    AND (paused_at IS NULL OR status = 'active')
  );

COMMENT ON COLUMN flags.damage_cycle_id IS
  'Durable personal-Flag hostile damage cycle. Cleared only by successful repair, destruction, or forced lifecycle reset.';
COMMENT ON COLUMN flag_burn_operations.remaining_duration_ms IS
  'Database-clock remaining burn duration captured when a contested repair pauses the burn.';

CREATE TABLE IF NOT EXISTS flag_repair_operations (
  operation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  -- Keep the terminal operation row when an owner demolishes the Flag.  The
  -- existing burn/attack ledgers use the same lifecycle-retention boundary.
  flag_id uuid NOT NULL,
  burn_operation_id uuid NOT NULL,
  damage_cycle_id uuid NOT NULL,
  request_id text NOT NULL,
  flag_name text NOT NULL,
  flag_lat double precision NOT NULL,
  flag_lon double precision NOT NULL,
  started_at timestamptz NOT NULL,
  completes_at timestamptz NOT NULL,
  paused_burn_remaining_ms bigint NOT NULL CHECK (paused_burn_remaining_ms >= 0),
  repair_kit_quantity smallint NOT NULL CHECK (repair_kit_quantity = 1),
  stone_quantity smallint NOT NULL CHECK (stone_quantity IN (5, 25)),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'cancelled', 'completed', 'disrupted', 'server_refunded')),
  cancel_reason text NULL,
  completed_at timestamptz NULL,
  refund_applied boolean NOT NULL DEFAULT false,
  result jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_player_id, request_id),
  CHECK (completes_at = started_at + interval '60 seconds'),
  CHECK ((status = 'active' AND completed_at IS NULL)
      OR (status IN ('cancelled', 'completed', 'disrupted', 'server_refunded') AND completed_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS flag_repair_operations_active_flag_unique
  ON flag_repair_operations (flag_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS flag_repair_operations_active_owner_idx
  ON flag_repair_operations (owner_player_id, completes_at)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS flag_repair_disrupt_operations (
  operation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contributor_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  flag_id uuid NOT NULL,
  repair_operation_id uuid NOT NULL REFERENCES flag_repair_operations(operation_id) ON DELETE CASCADE,
  damage_cycle_id uuid NOT NULL,
  request_id text NOT NULL,
  flag_lat double precision NOT NULL,
  flag_lon double precision NOT NULL,
  started_at timestamptz NOT NULL,
  completes_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'cancelled', 'completed')),
  cancel_reason text NULL,
  completed_at timestamptz NULL,
  result jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contributor_player_id, request_id),
  CHECK (completes_at = started_at + interval '8 seconds'),
  CHECK ((status = 'active' AND completed_at IS NULL)
      OR (status IN ('cancelled', 'completed') AND completed_at IS NOT NULL))
);

ALTER TABLE flag_repair_disrupt_operations
  ADD COLUMN IF NOT EXISTS flag_lat double precision,
  ADD COLUMN IF NOT EXISTS flag_lon double precision;

UPDATE flag_repair_disrupt_operations disrupt
SET flag_lat = COALESCE(disrupt.flag_lat, flag.lat),
    flag_lon = COALESCE(disrupt.flag_lon, flag.lon)
FROM flags flag
WHERE disrupt.flag_id = flag.id;

ALTER TABLE flag_repair_disrupt_operations
  ALTER COLUMN flag_lat SET NOT NULL,
  ALTER COLUMN flag_lon SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS flag_repair_disrupt_one_success_per_cycle
  ON flag_repair_disrupt_operations (contributor_player_id, flag_id, damage_cycle_id)
  WHERE status = 'completed';

CREATE INDEX IF NOT EXISTS flag_repair_disrupt_operations_repair_idx
  ON flag_repair_disrupt_operations (repair_operation_id, status);

COMMENT ON TABLE flag_repair_operations IS
  'Durable 60-second owner repair channels for player-created Stone/Tower Flag burns; materials are debited at reservation and refunded only for controlled server interruption.';
COMMENT ON TABLE flag_repair_disrupt_operations IS
  'Durable 8-second contributor-only repair disruption channels. A contributor can successfully disrupt at most once per damage cycle.';
