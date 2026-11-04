-- War for cities and kingdoms, part B2: War Camp health (
-- 2,200 HP, 1 h burn). Enemies damage a standing camp by hand (25, once per
-- 24 h), with Bombers (1,150, one Bomber spent) and with Siege volleys.
-- Damage stops at the 1,100 burn threshold and reaching it ignites the camp
-- (must-burn); when the 1 h burn ends the camp is removed and its garrison
-- stands in the field. Existing active camps start at full health.

ALTER TABLE war_camps
  ADD COLUMN IF NOT EXISTS health integer NULL,
  ADD COLUMN IF NOT EXISTS maximum_health integer NULL,
  ADD COLUMN IF NOT EXISTS burning_started_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS burning_until timestamptz NULL,
  ADD COLUMN IF NOT EXISTS damage_cycle_id uuid NULL;

UPDATE war_camps
SET health = 2200, maximum_health = 2200
WHERE health IS NULL OR maximum_health IS NULL;

ALTER TABLE war_camps
  ALTER COLUMN health SET DEFAULT 2200,
  ALTER COLUMN maximum_health SET DEFAULT 2200,
  ALTER COLUMN health SET NOT NULL,
  ALTER COLUMN maximum_health SET NOT NULL;

ALTER TABLE war_camps
  DROP CONSTRAINT IF EXISTS war_camps_health_valid;
ALTER TABLE war_camps
  ADD CONSTRAINT war_camps_health_valid CHECK (
    maximum_health = 2200
    AND health BETWEEN 0 AND maximum_health
    AND ((burning_started_at IS NULL) = (burning_until IS NULL))
  );

CREATE INDEX IF NOT EXISTS war_camps_burning_due_idx
  ON war_camps (burning_until, camp_id)
  WHERE removed_at IS NULL AND burning_until IS NOT NULL;

-- One row per damaging request (hand, bomber or siege), replay-keyed by
-- (player, request). camp_id keeps the record after the camp is removed.
CREATE TABLE IF NOT EXISTS war_camp_damage_operations (
  operation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  camp_id uuid NOT NULL REFERENCES war_camps(camp_id) ON DELETE RESTRICT,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  source text NOT NULL CHECK (source IN ('hand', 'bomber', 'siege')),
  group_id uuid NULL,
  damage integer NOT NULL CHECK (damage > 0),
  health_after integer NOT NULL CHECK (health_after >= 0),
  ignited boolean NOT NULL DEFAULT false,
  damage_cycle_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT war_camp_damage_operations_request_unique UNIQUE (player_id, request_id)
);

CREATE INDEX IF NOT EXISTS war_camp_damage_operations_camp_idx
  ON war_camp_damage_operations (camp_id, created_at DESC);

DROP TRIGGER IF EXISTS war_camp_damage_operations_append_only ON war_camp_damage_operations;
CREATE TRIGGER war_camp_damage_operations_append_only
BEFORE UPDATE OR DELETE ON war_camp_damage_operations
FOR EACH ROW EXECUTE FUNCTION prevent_kingdom_ledger_mutation();

-- Hand attacks: once per attacker and camp every 24 h.
CREATE TABLE IF NOT EXISTS war_camp_attack_cooldowns (
  camp_id uuid NOT NULL REFERENCES war_camps(camp_id) ON DELETE CASCADE,
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  attacked_at timestamptz NOT NULL,
  PRIMARY KEY (camp_id, player_id)
);


COMMENT ON COLUMN war_camps.health IS
  'War Camp health (2,200 max); damage stops at 1,100, which ignites a 1 h burn that removes the camp.';
COMMENT ON TABLE war_camp_damage_operations IS
  'Append-only War Camp damage by hand, Bomber or Siege, replay-keyed by (player, request).';
