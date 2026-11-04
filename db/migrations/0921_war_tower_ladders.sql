-- War for cities and kingdoms, part A1: tower ladders and towers that shoot.
--
-- flags.tower_level marks a tower and its level:
--   personal Guard Tower (reinforcement_level 3): 1..25,
--     2,700 + 440 x (level - 1) HP (interpolated per level);
--   City Tower (control_type 'city'): 1, 36,500 HP;
--   Kingdom Tower (control_type 'kingdom'): 1..5, 11,500 x level HP.
-- Every other flag keeps tower_level NULL. Existing personal Towers become
-- level 1 at their current health. Mirrors structureWarfareProfileForFlag in
-- packages/shared/src/structureWarfare.ts.

ALTER TABLE flags
  ADD COLUMN IF NOT EXISTS tower_level smallint NULL;

ALTER TABLE flags
  DROP CONSTRAINT IF EXISTS flags_health_valid;
ALTER TABLE flags
  DROP CONSTRAINT IF EXISTS flags_tower_level_valid;

DROP TRIGGER IF EXISTS flags_sync_health_defaults ON flags;

CREATE OR REPLACE FUNCTION flag_warfare_maximum_health(
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
        WHEN 0 THEN 100
        WHEN 1 THEN 200
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
      CASE WHEN p_tower_level IS NULL THEN 200
           WHEN p_tower_level BETWEEN 1 AND 5 THEN 11500 * p_tower_level
           ELSE NULL END
    WHEN p_control_type = 'kingdom_seat' AND p_kingdom_id IS NOT NULL AND p_city_id IS NULL
      AND p_tower_level IS NULL THEN 230000
    ELSE NULL
  END
$$;

-- The phase-1 six-argument form stays callable and means "not upgraded".
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
  SELECT flag_warfare_maximum_health(
    p_anchor_kind, p_control_type, p_system_controlled,
    p_city_id, p_kingdom_id, p_reinforcement_level, NULL::smallint
  )
$$;

CREATE OR REPLACE FUNCTION sync_flag_health_defaults()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  next_maximum integer;
BEGIN
  -- Tower level follows the structure: a personal Tower is at least level 1;
  -- any other personal tier has none; a change of hands (personal -> city /
  -- kingdom, seat demotion) starts the new structure un-upgraded.
  IF NEW.control_type = 'personal' THEN
    NEW.tower_level := CASE WHEN NEW.reinforcement_level = 3 THEN COALESCE(NEW.tower_level, 1) ELSE NULL END;
  ELSIF NEW.control_type NOT IN ('city', 'kingdom') THEN
    NEW.tower_level := NULL;
  ELSIF TG_OP = 'UPDATE' AND (
      OLD.control_type IS DISTINCT FROM NEW.control_type
      OR OLD.city_id IS DISTINCT FROM NEW.city_id
      OR OLD.kingdom_id IS DISTINCT FROM NEW.kingdom_id
    ) THEN
    NEW.tower_level := NULL;
  END IF;
  next_maximum := flag_warfare_maximum_health(
    NEW.anchor_kind, NEW.control_type, NEW.system_controlled,
    NEW.city_id, NEW.kingdom_id, NEW.reinforcement_level, NEW.tower_level
  );
  IF next_maximum IS NOT NULL THEN
    IF TG_OP = 'UPDATE' AND (
         OLD.control_type IS DISTINCT FROM NEW.control_type
         OR OLD.city_id IS DISTINCT FROM NEW.city_id
         OR OLD.kingdom_id IS DISTINCT FROM NEW.kingdom_id
       )
       AND OLD.maximum_health IS DISTINCT FROM next_maximum THEN
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

-- Existing personal Towers become level-1 Guard Towers (same 2,700 maximum).
UPDATE flags
SET tower_level = 1
WHERE control_type = 'personal'
  AND reinforcement_level = 3
  AND tower_level IS NULL;

-- Flush deferred flag-control trigger events queued by the backfill before
-- altering the table definition.
SET CONSTRAINTS ALL IMMEDIATE;

CREATE TRIGGER flags_sync_health_defaults
BEFORE INSERT OR UPDATE OF anchor_kind, control_type, system_controlled, city_id, kingdom_id,
  reinforcement_level, tower_level, health, maximum_health
ON flags
FOR EACH ROW
EXECUTE FUNCTION sync_flag_health_defaults();

ALTER TABLE flags
  ADD CONSTRAINT flags_tower_level_valid CHECK (
    tower_level IS NULL
    OR (control_type = 'personal' AND reinforcement_level = 3 AND tower_level BETWEEN 1 AND 25)
    OR (control_type = 'city' AND tower_level = 1)
    OR (control_type = 'kingdom' AND tower_level BETWEEN 1 AND 5)
  );

ALTER TABLE flags
  ADD CONSTRAINT flags_health_valid CHECK (
    (
      flag_warfare_maximum_health(
        anchor_kind, control_type, system_controlled, city_id, kingdom_id, reinforcement_level, tower_level
      ) IS NOT NULL
      AND health IS NOT NULL
      AND maximum_health IS NOT NULL
      AND health BETWEEN 0 AND maximum_health
      AND maximum_health = flag_warfare_maximum_health(
        anchor_kind, control_type, system_controlled, city_id, kingdom_id, reinforcement_level, tower_level
      )
    )
    OR
    (
      flag_warfare_maximum_health(
        anchor_kind, control_type, system_controlled, city_id, kingdom_id, reinforcement_level, tower_level
      ) IS NULL
      AND health IS NULL
      AND maximum_health IS NULL
    )
  );

-- Armed towers for the tower volley tick: a standing, non-collapsing tower.
-- The tick probes this small partial geography index around each online
-- player instead of scanning every tower.
CREATE INDEX IF NOT EXISTS flags_armed_tower_geography_gix
  ON flags USING gist ((geom::geography))
  WHERE tower_level IS NOT NULL
    AND health > 0
    AND territory_collapse_id IS NULL;

-- Tower upgrade ledger: one row per completed upgrade request (keyed by the
-- request's operation key). Replays of the same request return the recorded
-- result; a second request for a level that is already built is refused by
-- the level check under the flag row lock, so materials and City Coins are
-- debited exactly once per level.
CREATE TABLE IF NOT EXISTS flag_tower_upgrade_operations (
  operation_key text PRIMARY KEY,
  flag_id uuid NOT NULL REFERENCES flags(id) ON DELETE CASCADE,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  upgrade_kind text NOT NULL CHECK (upgrade_kind IN ('guard_tower_level', 'city_tower')),
  from_level smallint NULL,
  to_level smallint NOT NULL CHECK (to_level BETWEEN 1 AND 25),
  iron_quantity integer NOT NULL DEFAULT 0 CHECK (iron_quantity >= 0),
  stone_quantity integer NOT NULL CHECK (stone_quantity > 0),
  city_coin_quantity integer NOT NULL DEFAULT 0 CHECK (city_coin_quantity >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS flag_tower_upgrade_operations_flag_idx
  ON flag_tower_upgrade_operations (flag_id, created_at DESC);

COMMENT ON COLUMN flags.tower_level IS
  'Tower level: personal Guard Tower 1..25 (reinforcement_level 3), City Tower 1, Kingdom Tower 1..5; NULL for every other structure.';
COMMENT ON TABLE flag_tower_upgrade_operations IS
  'One row per completed Guard Tower level or City Tower upgrade, keyed by the request operation key.';
