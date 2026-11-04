-- War for cities and kingdoms, part A2: Bricks, the 12% brick tax,
-- Obelisks, Kingdom Towers and the Brick Furnace.
--
-- Bricks are an ordinary carried item (item_id 'bricks') and a kingdom
-- treasury resource (kingdom_treasury_balances). flags.obelisk_level marks a
-- Kingdom Flag built up into an Obelisk, levels 1..5:
--   2,300 x level HP, 27 h burn.
-- A Kingdom Flag carries at most one of tower_level / obelisk_level. Mirrors
-- structureWarfareProfileForFlag in packages/shared/src/structureWarfare.ts.

INSERT INTO item_definitions (
  item_id, display_name, category, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants
) VALUES (
  'bricks', 'Bricks', 'resource', true, 1000,
  true, true, false, false, NULL, ARRAY['default']::text[]
)
ON CONFLICT (item_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  category = EXCLUDED.category,
  stackable = EXCLUDED.stackable,
  max_stack = EXCLUDED.max_stack,
  droppable = EXCLUDED.droppable,
  manor_storable = EXCLUDED.manor_storable,
  market_tradable = EXCLUDED.market_tradable,
  market_fungible = EXCLUDED.market_fungible,
  market_identity = EXCLUDED.market_identity,
  supported_variants = EXCLUDED.supported_variants,
  updated_at = now();

ALTER TABLE flags
  ADD COLUMN IF NOT EXISTS obelisk_level smallint NULL;

ALTER TABLE flags
  DROP CONSTRAINT IF EXISTS flags_health_valid;
ALTER TABLE flags
  DROP CONSTRAINT IF EXISTS flags_obelisk_level_valid;

DROP TRIGGER IF EXISTS flags_sync_health_defaults ON flags;

CREATE OR REPLACE FUNCTION flag_warfare_maximum_health(
  p_anchor_kind text,
  p_control_type text,
  p_system_controlled boolean,
  p_city_id uuid,
  p_kingdom_id uuid,
  p_reinforcement_level smallint,
  p_tower_level smallint,
  p_obelisk_level smallint
) RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_obelisk_level IS NULL THEN flag_warfare_maximum_health(
      p_anchor_kind, p_control_type, p_system_controlled,
      p_city_id, p_kingdom_id, p_reinforcement_level, p_tower_level
    )
    WHEN p_anchor_kind IS DISTINCT FROM 'flag' OR p_system_controlled THEN NULL
    WHEN p_control_type = 'kingdom' AND p_kingdom_id IS NOT NULL AND p_city_id IS NULL
      AND p_tower_level IS NULL AND p_obelisk_level BETWEEN 1 AND 5
      THEN 2300 * p_obelisk_level
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
  next_maximum := flag_warfare_maximum_health(
    NEW.anchor_kind, NEW.control_type, NEW.system_controlled,
    NEW.city_id, NEW.kingdom_id, NEW.reinforcement_level, NEW.tower_level, NEW.obelisk_level
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

-- Flush deferred flag-control trigger events before altering the table.
SET CONSTRAINTS ALL IMMEDIATE;

CREATE TRIGGER flags_sync_health_defaults
BEFORE INSERT OR UPDATE OF anchor_kind, control_type, system_controlled, city_id, kingdom_id,
  reinforcement_level, tower_level, obelisk_level, health, maximum_health
ON flags
FOR EACH ROW
EXECUTE FUNCTION sync_flag_health_defaults();

ALTER TABLE flags
  ADD CONSTRAINT flags_obelisk_level_valid CHECK (
    obelisk_level IS NULL
    OR (control_type = 'kingdom' AND tower_level IS NULL AND obelisk_level BETWEEN 1 AND 5)
  );

ALTER TABLE flags
  ADD CONSTRAINT flags_health_valid CHECK (
    (
      flag_warfare_maximum_health(
        anchor_kind, control_type, system_controlled, city_id, kingdom_id,
        reinforcement_level, tower_level, obelisk_level
      ) IS NOT NULL
      AND health IS NOT NULL
      AND maximum_health IS NOT NULL
      AND health BETWEEN 0 AND maximum_health
      AND maximum_health = flag_warfare_maximum_health(
        anchor_kind, control_type, system_controlled, city_id, kingdom_id,
        reinforcement_level, tower_level, obelisk_level
      )
    )
    OR
    (
      flag_warfare_maximum_health(
        anchor_kind, control_type, system_controlled, city_id, kingdom_id,
        reinforcement_level, tower_level, obelisk_level
      ) IS NULL
      AND health IS NULL
      AND maximum_health IS NULL
    )
  );

-- Standing obelisks, probed around a gather / kill position that rolled a
-- brick drop.
CREATE INDEX IF NOT EXISTS flags_obelisk_geography_gix
  ON flags USING gist ((geom::geography))
  WHERE obelisk_level IS NOT NULL
    AND health > 0
    AND territory_collapse_id IS NULL;

-- Every kingdom treasury movement outside advancement projects and plain
-- donations: brick deposits (net of tax), structure builds, Brick Furnace
-- upgrades and packages. Append-only; one row per operation, resource and
-- direction, so a replayed operation can never move a balance twice.
CREATE TABLE IF NOT EXISTS kingdom_treasury_ledger (
  id uuid PRIMARY KEY,
  kingdom_id uuid NOT NULL REFERENCES kingdoms(id) ON DELETE RESTRICT,
  actor_player_id text NULL REFERENCES players(id) ON DELETE RESTRICT,
  resource_type text NOT NULL REFERENCES item_definitions(item_id) ON DELETE RESTRICT,
  variant text NOT NULL DEFAULT 'default',
  direction text NOT NULL,
  quantity bigint NOT NULL,
  balance_before bigint NOT NULL,
  balance_after bigint NOT NULL,
  source_type text NOT NULL,
  operation_key text NOT NULL,
  source_id text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kingdom_treasury_ledger_direction_valid CHECK (direction IN ('credit', 'debit')),
  CONSTRAINT kingdom_treasury_ledger_quantity_valid CHECK (quantity > 0),
  CONSTRAINT kingdom_treasury_ledger_balance_valid CHECK (
    balance_before >= 0 AND balance_after >= 0 AND (
      (direction = 'credit' AND balance_after = balance_before + quantity) OR
      (direction = 'debit' AND balance_after = balance_before - quantity)
    )
  ),
  CONSTRAINT kingdom_treasury_ledger_source_valid CHECK (
    source_type IN ('brick_deposit', 'kingdom_structure_build', 'brick_furnace_upgrade', 'brick_furnace_package')
  ),
  CONSTRAINT kingdom_treasury_ledger_operation_unique UNIQUE (operation_key, resource_type, variant, direction)
);

CREATE INDEX IF NOT EXISTS kingdom_treasury_ledger_kingdom_history_idx
  ON kingdom_treasury_ledger (kingdom_id, created_at DESC, id DESC);

DROP TRIGGER IF EXISTS kingdom_treasury_ledger_append_only ON kingdom_treasury_ledger;
CREATE TRIGGER kingdom_treasury_ledger_append_only
BEFORE UPDATE OR DELETE ON kingdom_treasury_ledger
FOR EACH ROW EXECUTE FUNCTION prevent_kingdom_ledger_mutation();

-- Brick deposits: the carried Bricks taken from the member, the 12% tax
-- (rounded up) that is destroyed, and the remainder credited to the
-- treasury. One row per (member, request).
CREATE TABLE IF NOT EXISTS kingdom_brick_deposits (
  id uuid PRIMARY KEY,
  kingdom_id uuid NOT NULL REFERENCES kingdoms(id) ON DELETE RESTRICT,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL,
  quantity integer NOT NULL,
  tax_destroyed integer NOT NULL,
  credited integer NOT NULL,
  player_balance_before integer NOT NULL,
  player_balance_after integer NOT NULL,
  treasury_balance_before bigint NOT NULL,
  treasury_balance_after bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kingdom_brick_deposits_quantity_valid CHECK (quantity >= 2),
  CONSTRAINT kingdom_brick_deposits_tax_valid CHECK (
    tax_destroyed = (quantity * 12 + 99) / 100 AND credited = quantity - tax_destroyed AND credited > 0
  ),
  CONSTRAINT kingdom_brick_deposits_player_balance_valid CHECK (
    player_balance_before >= quantity AND player_balance_after = player_balance_before - quantity
  ),
  CONSTRAINT kingdom_brick_deposits_treasury_balance_valid CHECK (
    treasury_balance_before >= 0 AND treasury_balance_after = treasury_balance_before + credited
  ),
  CONSTRAINT kingdom_brick_deposits_request_unique UNIQUE (player_id, request_id)
);

CREATE INDEX IF NOT EXISTS kingdom_brick_deposits_kingdom_history_idx
  ON kingdom_brick_deposits (kingdom_id, created_at DESC, id DESC);

DROP TRIGGER IF EXISTS kingdom_brick_deposits_append_only ON kingdom_brick_deposits;
CREATE TRIGGER kingdom_brick_deposits_append_only
BEFORE UPDATE OR DELETE ON kingdom_brick_deposits
FOR EACH ROW EXECUTE FUNCTION prevent_kingdom_ledger_mutation();

-- Obelisk and Kingdom Tower builds, one row per completed level keyed by
-- the build request's operation key. flag_id has no foreign key so the
-- record outlives a destroyed structure.
CREATE TABLE IF NOT EXISTS kingdom_structure_build_operations (
  operation_key text PRIMARY KEY,
  kingdom_id uuid NOT NULL REFERENCES kingdoms(id) ON DELETE RESTRICT,
  flag_id uuid NOT NULL,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  structure_kind text NOT NULL CHECK (structure_kind IN ('kingdom_tower', 'obelisk')),
  from_level smallint NULL CHECK (from_level BETWEEN 1 AND 4),
  to_level smallint NOT NULL CHECK (to_level BETWEEN 1 AND 5),
  bricks_quantity integer NOT NULL CHECK (bricks_quantity > 0),
  material_item_id text NOT NULL REFERENCES item_definitions(item_id) ON DELETE RESTRICT,
  material_quantity integer NOT NULL CHECK (material_quantity > 0),
  material_source text NOT NULL CHECK (material_source IN ('treasury', 'builder')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kingdom_structure_build_level_step CHECK (
    (from_level IS NULL AND to_level = 1) OR (to_level = from_level + 1)
  )
);

CREATE INDEX IF NOT EXISTS kingdom_structure_build_operations_flag_idx
  ON kingdom_structure_build_operations (flag_id, created_at DESC);

DROP TRIGGER IF EXISTS kingdom_structure_build_operations_append_only ON kingdom_structure_build_operations;
CREATE TRIGGER kingdom_structure_build_operations_append_only
BEFORE UPDATE OR DELETE ON kingdom_structure_build_operations
FOR EACH ROW EXECUTE FUNCTION prevent_kingdom_ledger_mutation();

-- Brick Furnace: one per kingdom, levels 1..3. last_package_at drives the
-- 20 h package cooldown, checked under the kingdom row lock.
CREATE TABLE IF NOT EXISTS kingdom_brick_furnaces (
  kingdom_id uuid PRIMARY KEY REFERENCES kingdoms(id) ON DELETE RESTRICT,
  level smallint NOT NULL CHECK (level BETWEEN 1 AND 3),
  last_package_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kingdom_brick_furnace_operations (
  operation_key text PRIMARY KEY,
  kingdom_id uuid NOT NULL REFERENCES kingdoms(id) ON DELETE RESTRICT,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('upgrade', 'package')),
  furnace_level smallint NOT NULL CHECK (furnace_level BETWEEN 1 AND 3),
  glimmer_oil_quantity integer NOT NULL CHECK (glimmer_oil_quantity > 0),
  glimmer_oil_source text NOT NULL CHECK (glimmer_oil_source IN ('treasury', 'player')),
  bricks_quantity integer NOT NULL DEFAULT 0 CHECK (bricks_quantity >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kingdom_brick_furnace_operations_shape CHECK (
    (action = 'upgrade' AND bricks_quantity = 0)
    OR (action = 'package' AND bricks_quantity > 0 AND glimmer_oil_source = 'player')
  )
);

CREATE INDEX IF NOT EXISTS kingdom_brick_furnace_operations_kingdom_idx
  ON kingdom_brick_furnace_operations (kingdom_id, created_at DESC);

DROP TRIGGER IF EXISTS kingdom_brick_furnace_operations_append_only ON kingdom_brick_furnace_operations;
CREATE TRIGGER kingdom_brick_furnace_operations_append_only
BEFORE UPDATE OR DELETE ON kingdom_brick_furnace_operations
FOR EACH ROW EXECUTE FUNCTION prevent_kingdom_ledger_mutation();

COMMENT ON COLUMN flags.obelisk_level IS
  'Kingdom Obelisk level 1..5 on a Kingdom Flag (never together with tower_level); NULL otherwise.';
COMMENT ON TABLE kingdom_treasury_ledger IS
  'Append-only kingdom treasury movements for brick deposits, structure builds and the Brick Furnace.';
COMMENT ON TABLE kingdom_brick_deposits IS
  'Append-only brick deposits: quantity taken, 12% tax destroyed (rounded up), remainder credited.';
