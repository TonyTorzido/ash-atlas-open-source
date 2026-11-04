-- War for cities and kingdoms, part B2: the Command Board, War Towers and War
-- Outposts.
--
-- Command Board: one per kingdom, levels 1..3, built by the leader. Its level
-- caps the kingdom's standing War Outposts (1/2/3) and War Towers (9/18/27).
--
-- War Towers and War Outposts are Kingdom Flags tied to one active war
-- (flags.war_structure_kind + flags.war_id). They stand outside the kingdom's
-- seat network: they never connect other flags and are never pruned as
-- disconnected. A War Tower is a level-1 tower (11,500 HP, 27 h burn); a War
-- Outpost has 2,200 HP and a 1 h burn. Mirrors structureWarfareProfileForFlag
-- in packages/shared/src/structureWarfare.ts.

CREATE TABLE IF NOT EXISTS kingdom_command_boards (
  kingdom_id uuid PRIMARY KEY REFERENCES kingdoms(id) ON DELETE RESTRICT,
  level smallint NOT NULL CHECK (level BETWEEN 1 AND 3),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One row per completed Command Board level, keyed by the request's operation
-- key. materials records every material's quantity and source
-- ('treasury' or 'builder').
CREATE TABLE IF NOT EXISTS kingdom_command_board_operations (
  operation_key text PRIMARY KEY,
  kingdom_id uuid NOT NULL REFERENCES kingdoms(id) ON DELETE RESTRICT,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  from_level smallint NULL CHECK (from_level BETWEEN 1 AND 2),
  to_level smallint NOT NULL CHECK (to_level BETWEEN 1 AND 3),
  materials jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kingdom_command_board_level_step CHECK (
    (from_level IS NULL AND to_level = 1) OR (to_level = from_level + 1)
  ),
  CONSTRAINT kingdom_command_board_one_build_per_level UNIQUE (kingdom_id, to_level)
);

DROP TRIGGER IF EXISTS kingdom_command_board_operations_append_only ON kingdom_command_board_operations;
CREATE TRIGGER kingdom_command_board_operations_append_only
BEFORE UPDATE OR DELETE ON kingdom_command_board_operations
FOR EACH ROW EXECUTE FUNCTION prevent_kingdom_ledger_mutation();

ALTER TABLE kingdom_treasury_ledger
  DROP CONSTRAINT IF EXISTS kingdom_treasury_ledger_source_valid;
ALTER TABLE kingdom_treasury_ledger
  ADD CONSTRAINT kingdom_treasury_ledger_source_valid CHECK (
    source_type IN (
      'brick_deposit', 'kingdom_structure_build', 'brick_furnace_upgrade', 'brick_furnace_package',
      'war_surrender_transfer', 'war_surrender_destroyed', 'war_death_loss',
      'kingdom_perk_choose', 'kingdom_perk_change',
      'command_board_upgrade', 'war_structure_build'
    )
  );

-- flags.war_id has no foreign key, like the warfare ledgers' flag ids: war
-- rows are never deleted (they end), and a key would make every
-- organization_wars TRUNCATE ... CASCADE in tooling also empty flags.
ALTER TABLE flags
  ADD COLUMN IF NOT EXISTS war_structure_kind text NULL,
  ADD COLUMN IF NOT EXISTS war_id uuid NULL;

ALTER TABLE flags
  DROP CONSTRAINT IF EXISTS flags_health_valid;
ALTER TABLE flags
  DROP CONSTRAINT IF EXISTS flags_war_structure_valid;

DROP TRIGGER IF EXISTS flags_sync_health_defaults ON flags;

CREATE OR REPLACE FUNCTION flag_warfare_maximum_health(
  p_anchor_kind text,
  p_control_type text,
  p_system_controlled boolean,
  p_city_id uuid,
  p_kingdom_id uuid,
  p_reinforcement_level smallint,
  p_tower_level smallint,
  p_obelisk_level smallint,
  p_war_structure_kind text
) RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_war_structure_kind IS NULL THEN flag_warfare_maximum_health(
      p_anchor_kind, p_control_type, p_system_controlled,
      p_city_id, p_kingdom_id, p_reinforcement_level, p_tower_level, p_obelisk_level
    )
    WHEN p_anchor_kind IS DISTINCT FROM 'flag' OR p_system_controlled
      OR p_control_type IS DISTINCT FROM 'kingdom' OR p_kingdom_id IS NULL
      OR p_city_id IS NOT NULL OR p_obelisk_level IS NOT NULL THEN NULL
    WHEN p_war_structure_kind = 'war_tower' AND p_tower_level = 1 THEN 11500
    WHEN p_war_structure_kind = 'war_outpost' AND p_tower_level IS NULL THEN 2200
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
  -- Tower level follows the structure: a personal Tower is at least level 1;
  -- any other personal tier has none; a change of hands (personal -> city /
  -- kingdom, seat demotion) starts the new structure un-upgraded. An
  -- obelisk exists only on a Kingdom Flag and is lost with a change of hands.
  IF NEW.control_type = 'personal' THEN
    NEW.tower_level := CASE WHEN NEW.reinforcement_level = 3 THEN COALESCE(NEW.tower_level, 1) ELSE NULL END;
    NEW.obelisk_level := NULL;
  ELSIF NEW.control_type NOT IN ('city', 'kingdom') THEN
    NEW.tower_level := NULL;
    NEW.obelisk_level := NULL;
  ELSIF TG_OP = 'UPDATE' AND (
      OLD.control_type IS DISTINCT FROM NEW.control_type
      OR OLD.city_id IS DISTINCT FROM NEW.city_id
      OR OLD.kingdom_id IS DISTINCT FROM NEW.kingdom_id
    ) THEN
    NEW.tower_level := NULL;
    NEW.obelisk_level := NULL;
  END IF;
  IF NEW.control_type <> 'kingdom' THEN
    NEW.obelisk_level := NULL;
  END IF;
  -- A War Tower is always a level-1 tower; a War Outpost is never a tower.
  IF NEW.war_structure_kind IS NOT NULL AND NEW.control_type = 'kingdom' THEN
    NEW.tower_level := CASE WHEN NEW.war_structure_kind = 'war_tower' THEN 1 ELSE NULL END;
    NEW.obelisk_level := NULL;
  END IF;
  next_maximum := flag_warfare_maximum_health(
    NEW.anchor_kind, NEW.control_type, NEW.system_controlled,
    NEW.city_id, NEW.kingdom_id, NEW.reinforcement_level, NEW.tower_level, NEW.obelisk_level,
    NEW.war_structure_kind
  );
  IF next_maximum IS NOT NULL THEN
    IF TG_OP = 'UPDATE' AND (
         OLD.control_type IS DISTINCT FROM NEW.control_type
         OR OLD.city_id IS DISTINCT FROM NEW.city_id
         OR OLD.kingdom_id IS DISTINCT FROM NEW.kingdom_id
         OR OLD.war_structure_kind IS DISTINCT FROM NEW.war_structure_kind
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

-- Flush deferred flag-control trigger events before altering the table.
SET CONSTRAINTS ALL IMMEDIATE;

CREATE TRIGGER flags_sync_health_defaults
BEFORE INSERT OR UPDATE OF anchor_kind, control_type, system_controlled, city_id, kingdom_id,
  reinforcement_level, tower_level, obelisk_level, war_structure_kind, health, maximum_health
ON flags
FOR EACH ROW
EXECUTE FUNCTION sync_flag_health_defaults();

ALTER TABLE flags
  ADD CONSTRAINT flags_war_structure_valid CHECK (
    (war_structure_kind IS NULL AND war_id IS NULL)
    OR (
      war_structure_kind IN ('war_tower', 'war_outpost')
      AND war_id IS NOT NULL
      AND control_type = 'kingdom'
      AND kingdom_id IS NOT NULL
      AND obelisk_level IS NULL
      AND (war_structure_kind <> 'war_tower' OR tower_level = 1)
      AND (war_structure_kind <> 'war_outpost' OR tower_level IS NULL)
    )
  );

ALTER TABLE flags
  ADD CONSTRAINT flags_health_valid CHECK (
    (
      flag_warfare_maximum_health(
        anchor_kind, control_type, system_controlled, city_id, kingdom_id,
        reinforcement_level, tower_level, obelisk_level, war_structure_kind
      ) IS NOT NULL
      AND health IS NOT NULL
      AND maximum_health IS NOT NULL
      AND health BETWEEN 0 AND maximum_health
      AND maximum_health = flag_warfare_maximum_health(
        anchor_kind, control_type, system_controlled, city_id, kingdom_id,
        reinforcement_level, tower_level, obelisk_level, war_structure_kind
      )
    )
    OR
    (
      flag_warfare_maximum_health(
        anchor_kind, control_type, system_controlled, city_id, kingdom_id,
        reinforcement_level, tower_level, obelisk_level, war_structure_kind
      ) IS NULL
      AND health IS NULL
      AND maximum_health IS NULL
    )
  );

CREATE INDEX IF NOT EXISTS flags_war_structure_kingdom_idx
  ON flags (kingdom_id, war_structure_kind)
  WHERE war_structure_kind IS NOT NULL;
CREATE INDEX IF NOT EXISTS flags_war_structure_war_idx
  ON flags (war_id)
  WHERE war_id IS NOT NULL;

-- War Tower / War Outpost builds, one row per placed structure keyed by the
-- request's operation key. flag_id has no foreign key so the record outlives
-- the structure. materials records every material's quantity and source.
CREATE TABLE IF NOT EXISTS kingdom_war_structure_operations (
  operation_key text PRIMARY KEY,
  kingdom_id uuid NOT NULL REFERENCES kingdoms(id) ON DELETE RESTRICT,
  war_id uuid NOT NULL REFERENCES organization_wars(war_id) ON DELETE RESTRICT,
  flag_id uuid NOT NULL,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  structure_kind text NOT NULL CHECK (structure_kind IN ('war_tower', 'war_outpost')),
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
  gold bigint NOT NULL CHECK (gold >= 0),
  materials jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS kingdom_war_structure_operations_kingdom_idx
  ON kingdom_war_structure_operations (kingdom_id, created_at DESC);

DROP TRIGGER IF EXISTS kingdom_war_structure_operations_append_only ON kingdom_war_structure_operations;
CREATE TRIGGER kingdom_war_structure_operations_append_only
BEFORE UPDATE OR DELETE ON kingdom_war_structure_operations
FOR EACH ROW EXECUTE FUNCTION prevent_kingdom_ledger_mutation();

COMMENT ON TABLE kingdom_command_boards IS
  'Kingdom Command Board level 1..3; caps War Outposts at 1/2/3 and War Towers at 9/18/27.';
COMMENT ON COLUMN flags.war_structure_kind IS
  'War Tower / War Outpost on a Kingdom Flag, tied to flags.war_id; NULL for every other flag.';
COMMENT ON TABLE kingdom_war_structure_operations IS
  'Append-only War Tower / War Outpost placements with the gold and materials charged.';
