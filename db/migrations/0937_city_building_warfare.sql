-- War part C3: city buildings get health, burning and siege.
--
-- City buildings keep their warfare state on their own city_structures row
-- (the flag warfare engine is keyed to flag rows and flag operation tables).
-- One checkpoint per building: health (NULL = untouched, full health),
-- health_at, burning_since and the active repairer. Current health is
-- projected from the checkpoint with the fixed burn and repair rates in
-- packages/shared/src/cityStructureWarfare.ts; this function mirrors its
-- maximum health table. The Mayor House belongs to the City Center seat and
-- retired building types stay immune (NULL).

CREATE OR REPLACE FUNCTION city_structure_warfare_maximum_health(p_structure_type text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_structure_type
    WHEN 'city_house' THEN 17500
    WHEN 'oil_well' THEN 11500
    WHEN 'quartz_hut' THEN 11000
    WHEN 'salon' THEN 18500
    WHEN 'barracks' THEN 21500
    WHEN 'demolition_factory' THEN 19000
    WHEN 'warehouse' THEN 23000
    WHEN 'market' THEN 22000
    WHEN 'city_kennel' THEN 6500
    WHEN 'cistern_warrens' THEN 5500
    WHEN 'monument' THEN 18000
    ELSE NULL
  END
$$;

ALTER TABLE city_structures
  ADD COLUMN IF NOT EXISTS health integer NULL,
  ADD COLUMN IF NOT EXISTS health_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS burning_since timestamptz NULL,
  ADD COLUMN IF NOT EXISTS repair_player_id text NULL REFERENCES players(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS repair_started_at timestamptz NULL;

ALTER TABLE city_structures
  DROP CONSTRAINT IF EXISTS city_structures_warfare_health_check,
  DROP CONSTRAINT IF EXISTS city_structures_warfare_burn_check,
  DROP CONSTRAINT IF EXISTS city_structures_warfare_repair_check;

ALTER TABLE city_structures
  ADD CONSTRAINT city_structures_warfare_health_check CHECK (
    health IS NULL
    OR (
      city_structure_warfare_maximum_health(structure_type) IS NOT NULL
      AND health BETWEEN 0 AND city_structure_warfare_maximum_health(structure_type)
      AND health_at IS NOT NULL
    )
  ),
  ADD CONSTRAINT city_structures_warfare_burn_check CHECK (
    burning_since IS NULL OR (health IS NOT NULL AND state = 'active')
  ),
  ADD CONSTRAINT city_structures_warfare_repair_check CHECK (
    (repair_player_id IS NULL) = (repair_started_at IS NULL)
    AND (repair_player_id IS NULL OR (health IS NOT NULL AND state = 'active'))
  );

-- A player repairs one building at a time.
CREATE UNIQUE INDEX IF NOT EXISTS city_structures_one_repair_per_player_idx
  ON city_structures (repair_player_id)
  WHERE repair_player_id IS NOT NULL;

-- The warfare sweep polls burning, repairing and fallen buildings only.
CREATE INDEX IF NOT EXISTS city_structures_warfare_live_idx
  ON city_structures (structure_id)
  WHERE burning_since IS NOT NULL
     OR repair_player_id IS NOT NULL
     OR (health = 0 AND state = 'active');

-- Hand attacks: idempotency by (player, request) and the 24 h per-building
-- cooldown. Siege and Bomber damage keeps using military_siege_operations.
CREATE TABLE IF NOT EXISTS city_structure_attack_operations (
  operation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  structure_id uuid NOT NULL REFERENCES city_structures(structure_id) ON DELETE CASCADE,
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 160),
  damage integer NOT NULL CHECK (damage >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (player_id, request_id)
);
CREATE INDEX IF NOT EXISTS city_structure_attack_operations_cooldown_idx
  ON city_structure_attack_operations (structure_id, player_id, created_at DESC);

-- War destruction writes its own audited structure operation.
ALTER TABLE city_structure_operations
  DROP CONSTRAINT IF EXISTS city_structure_operations_action_check;
ALTER TABLE city_structure_operations
  ADD CONSTRAINT city_structure_operations_action_check CHECK (
    action IN (
      'build_house', 'destroy_house', 'build_oil_well', 'destroy_oil_well',
      'build_quartz_hut', 'destroy_quartz_hut',
      'build_facility', 'upgrade_facility', 'destroy_facility',
      'claim_mayor', 'relinquish_mayor', 'expire_founder_grace',
      'build_market', 'build_monument', 'upgrade_monument', 'destroy_monument',
      'war_destroyed'
    )
  );

-- Sieges can hold a city building as their durable target, and Bomber /
-- Siege ledger rows record which kind of target their id names.
ALTER TABLE military_unit_groups
  ADD COLUMN IF NOT EXISTS target_city_structure_id uuid NULL
    REFERENCES city_structures(structure_id) ON DELETE SET NULL;

ALTER TABLE military_siege_operations
  ADD COLUMN IF NOT EXISTS target_kind text NOT NULL DEFAULT 'flag';
ALTER TABLE military_siege_operations
  DROP CONSTRAINT IF EXISTS military_siege_operations_target_kind_check;
ALTER TABLE military_siege_operations
  ADD CONSTRAINT military_siege_operations_target_kind_check
    CHECK (target_kind IN ('flag', 'city_structure'));

COMMENT ON COLUMN city_structures.health IS
  'War health checkpoint at health_at; NULL means untouched (full health). Maximum from city_structure_warfare_maximum_health().';
COMMENT ON COLUMN city_structures.burning_since IS
  'Set while the building burns (from its burn threshold to 0 over its burn time); the burn pauses while repair_player_id repairs.';
COMMENT ON COLUMN military_siege_operations.flag_id IS
  'Target id: a flag, or a city building when target_kind = ''city_structure''.';
