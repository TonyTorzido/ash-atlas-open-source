-- War for cities and kingdoms, phase 1.
--
-- 1. City and kingdom structures get durability and burn times (City Flag
--    4,500 / 27 h, City Center (city_seat) 230,000 / 90 h, Kingdom Flag
--    27 h, Castle (kingdom_seat) 230,000 / 90 h; migrations 1156 and 1157
--    redefine the flag health values). Existing rows are backfilled at full
--    health. Buoys, Atlas Shrines and system-controlled (goblin / NPC)
--    territory stay immune (NULL health).
-- 2. Health columns widen to integer (230,000 does not fit smallint).
-- 3. Repairs become free, progressive channels (5x the burn rate, burn
--    paused while repairing).
-- 4. Organization wars (kingdom<->kingdom, kingdom<->city, city<->city) with
--    rate-limited "war declared" / "under attack" alerts.

ALTER TABLE flags
  DROP CONSTRAINT IF EXISTS flags_health_valid;

-- The health trigger depends on the columns being widened; it is recreated
-- below with the new profile function.
DROP TRIGGER IF EXISTS flags_sync_health_defaults ON flags;

ALTER TABLE flags
  ALTER COLUMN health TYPE integer,
  ALTER COLUMN maximum_health TYPE integer;

ALTER TABLE flag_burn_operations
  ALTER COLUMN burn_start_health TYPE integer,
  ALTER COLUMN burn_damage_applied TYPE integer,
  ALTER COLUMN burn_damage_budget TYPE integer;

ALTER TABLE flag_burn_operations
  DROP CONSTRAINT IF EXISTS flag_burn_operations_duration_check,
  DROP CONSTRAINT IF EXISTS flag_burn_operations_lifecycle_check;

-- The warfare profile for a flag row. Mirrors structureWarfareProfileForFlag
-- in packages/shared/src/structureWarfare.ts.
CREATE OR REPLACE FUNCTION flag_warfare_maximum_health(
  p_anchor_kind text,
  p_control_type text,
  p_system_controlled boolean,
  p_city_id uuid,
  p_kingdom_id uuid,
  p_reinforcement_level smallint
) RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_anchor_kind IS DISTINCT FROM 'flag' OR p_system_controlled THEN NULL
    WHEN p_control_type = 'personal' AND p_city_id IS NULL AND p_kingdom_id IS NULL THEN
      CASE p_reinforcement_level WHEN 0 THEN 100 WHEN 1 THEN 200 WHEN 3 THEN 2700 ELSE NULL END
    WHEN p_control_type = 'city' AND p_city_id IS NOT NULL AND p_kingdom_id IS NULL THEN 4500
    WHEN p_control_type = 'city_seat' AND p_city_id IS NOT NULL AND p_kingdom_id IS NULL THEN 230000
    WHEN p_control_type = 'kingdom' AND p_kingdom_id IS NOT NULL AND p_city_id IS NULL THEN 200
    WHEN p_control_type = 'kingdom_seat' AND p_kingdom_id IS NOT NULL AND p_city_id IS NULL THEN 230000
    ELSE NULL
  END
$$;

CREATE OR REPLACE FUNCTION sync_flag_health_defaults()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  next_maximum integer;
BEGIN
  next_maximum := flag_warfare_maximum_health(
    NEW.anchor_kind, NEW.control_type, NEW.system_controlled,
    NEW.city_id, NEW.kingdom_id, NEW.reinforcement_level
  );
  IF next_maximum IS NOT NULL THEN
    IF TG_OP = 'UPDATE' AND (
         OLD.control_type IS DISTINCT FROM NEW.control_type
         OR OLD.city_id IS DISTINCT FROM NEW.city_id
         OR OLD.kingdom_id IS DISTINCT FROM NEW.kingdom_id
       )
       AND OLD.maximum_health IS DISTINCT FROM next_maximum THEN
      -- A structure that changes hands (personal -> city / kingdom, seat
      -- demotion) starts its new life at full health.
      NEW.health := next_maximum;
    ELSE
      NEW.health := LEAST(COALESCE(NEW.health, next_maximum), next_maximum);
    END IF;
    NEW.maximum_health := next_maximum;
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

CREATE TRIGGER flags_sync_health_defaults
BEFORE INSERT OR UPDATE OF anchor_kind, control_type, system_controlled, city_id, kingdom_id,
  reinforcement_level, health, maximum_health
ON flags
FOR EACH ROW
EXECUTE FUNCTION sync_flag_health_defaults();

-- Backfill every city / kingdom structure at full health.
UPDATE flags
SET maximum_health = flag_warfare_maximum_health(
      anchor_kind, control_type, system_controlled, city_id, kingdom_id, reinforcement_level),
    health = flag_warfare_maximum_health(
      anchor_kind, control_type, system_controlled, city_id, kingdom_id, reinforcement_level)
WHERE control_type IN ('city', 'city_seat', 'kingdom', 'kingdom_seat')
  AND flag_warfare_maximum_health(
        anchor_kind, control_type, system_controlled, city_id, kingdom_id, reinforcement_level
      ) IS NOT NULL
  AND maximum_health IS NULL;

-- Flush deferred flag-control trigger events queued by the backfill before
-- altering the table definition.
SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE flags
  ADD CONSTRAINT flags_health_valid CHECK (
    (
      flag_warfare_maximum_health(
        anchor_kind, control_type, system_controlled, city_id, kingdom_id, reinforcement_level
      ) IS NOT NULL
      AND health IS NOT NULL
      AND maximum_health IS NOT NULL
      AND health BETWEEN 0 AND maximum_health
      AND maximum_health = flag_warfare_maximum_health(
        anchor_kind, control_type, system_controlled, city_id, kingdom_id, reinforcement_level
      )
    )
    OR
    (
      flag_warfare_maximum_health(
        anchor_kind, control_type, system_controlled, city_id, kingdom_id, reinforcement_level
      ) IS NULL
      AND health IS NULL
      AND maximum_health IS NULL
    )
  );

-- 25 s soft burn, 22 h personal burn, 27 h organization flag, 90 h seat.
ALTER TABLE flag_burn_operations
  ADD CONSTRAINT flag_burn_operations_duration_check CHECK (
    burn_duration_ms IN (25000, 79200000, 97200000, 324000000)
    AND completes_at > started_at
  ),
  ADD CONSTRAINT flag_burn_operations_lifecycle_check CHECK (
    burn_duration_ms IN (25000, 79200000, 97200000, 324000000)
    AND remaining_duration_ms >= 0
    AND (paused_at IS NULL OR status = 'active')
  );

-- Progressive repair channels. Legacy rows keep their fixed 60-second shape;
-- new rows restore health continuously and cost nothing.
DO $$
DECLARE
  constraint_row record;
BEGIN
  FOR constraint_row IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'flag_repair_operations'::regclass
      AND contype = 'c'
      AND (
        pg_get_constraintdef(oid) LIKE '%60 seconds%'
        OR pg_get_constraintdef(oid) LIKE '%00:01:00%'
        OR pg_get_constraintdef(oid) LIKE '%repair_kit_quantity = 1%'
        OR pg_get_constraintdef(oid) LIKE '%stone_quantity = ANY%'
      )
  LOOP
    EXECUTE format('ALTER TABLE flag_repair_operations DROP CONSTRAINT %I', constraint_row.conname);
  END LOOP;
END;
$$;

ALTER TABLE flag_repair_operations
  ALTER COLUMN burn_operation_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS repair_mode text NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS maximum_health integer NULL,
  ADD COLUMN IF NOT EXISTS full_repair_ms bigint NULL,
  ADD COLUMN IF NOT EXISTS health_restored integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS organization_kind text NULL,
  ADD COLUMN IF NOT EXISTS organization_id uuid NULL;

ALTER TABLE flag_repair_operations
  DROP CONSTRAINT IF EXISTS flag_repair_operations_mode_check;
ALTER TABLE flag_repair_operations
  ADD CONSTRAINT flag_repair_operations_mode_check CHECK (
    (
      repair_mode = 'legacy'
      AND burn_operation_id IS NOT NULL
      AND repair_kit_quantity = 1
      AND stone_quantity IN (5, 25)
      AND completes_at = started_at + interval '60 seconds'
    )
    OR
    (
      repair_mode = 'progressive'
      AND repair_kit_quantity = 0
      AND stone_quantity = 0
      AND maximum_health > 0
      AND full_repair_ms > 0
      AND health_restored >= 0
      AND completes_at >= started_at
      AND (organization_kind IS NULL OR organization_kind IN ('city', 'kingdom'))
      AND ((organization_kind IS NULL) = (organization_id IS NULL))
    )
  );

-- Organization wars. War is instant: a row is active from the moment it is
-- declared (from settings, or automatically on the first hostile action).
-- Sides are stored in canonical order so one active row exists per pair.
CREATE TABLE IF NOT EXISTS organization_wars (
  war_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  side_a_kind text NOT NULL CHECK (side_a_kind IN ('city', 'kingdom')),
  side_a_id uuid NOT NULL,
  side_b_kind text NOT NULL CHECK (side_b_kind IN ('city', 'kingdom')),
  side_b_id uuid NOT NULL,
  aggressor_kind text NOT NULL CHECK (aggressor_kind IN ('city', 'kingdom')),
  aggressor_id uuid NOT NULL,
  declared_by_player_id text NULL REFERENCES players(id) ON DELETE SET NULL,
  declared_via text NOT NULL CHECK (declared_via IN ('settings', 'attack')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  declared_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz NULL,
  ended_reason text NULL,
  CHECK ((side_a_kind, side_a_id::text) < (side_b_kind, side_b_id::text)),
  CHECK (
    (aggressor_kind = side_a_kind AND aggressor_id = side_a_id)
    OR (aggressor_kind = side_b_kind AND aggressor_id = side_b_id)
  ),
  CHECK ((status = 'ended') = (ended_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS organization_wars_active_pair_idx
  ON organization_wars (side_a_kind, side_a_id, side_b_kind, side_b_id)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS organization_wars_active_side_a_idx
  ON organization_wars (side_a_kind, side_a_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS organization_wars_active_side_b_idx
  ON organization_wars (side_b_kind, side_b_id) WHERE status = 'active';

-- Rate limit for "under attack" alerts, one row per defending organization.
-- Each sent alert gets a fresh alert_id, used as the inbox event id.
CREATE TABLE IF NOT EXISTS organization_war_alerts (
  organization_kind text NOT NULL CHECK (organization_kind IN ('city', 'kingdom')),
  organization_id uuid NOT NULL,
  alert_kind text NOT NULL CHECK (alert_kind IN ('under_attack')),
  alert_id uuid NOT NULL,
  last_sent_at timestamptz NOT NULL,
  PRIMARY KEY (organization_kind, organization_id, alert_kind)
);

COMMENT ON COLUMN flags.health IS
  'Current durability: personal Flags 100/200/2700, City Flags 4500, City Centers 230000, Kingdom Flags 200, Castles 230000; NULL for buoys, Atlas Shrines and system-controlled territory.';
COMMENT ON COLUMN flags.maximum_health IS
  'Maximum durability from flag_warfare_maximum_health(); NULL for immune structures.';
COMMENT ON TABLE flag_burn_operations IS
  'Durable structure burning operations: soft 25 s, personal 22 h, city/kingdom flag 27 h, City Center/Castle 90 h. The operation is authoritative; flags.burning_* is a presentation mirror.';

-- The organization fall sweep polls for burnt-out / destroyed city and
-- kingdom structures; keep that poll on a tiny partial index.
CREATE INDEX IF NOT EXISTS flags_fallen_organization_structure_idx
  ON flags (id)
  WHERE health = 0
    AND control_type IN ('city', 'city_seat', 'kingdom', 'kingdom_seat')
    AND territory_collapse_id IS NULL;
