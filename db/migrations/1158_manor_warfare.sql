-- Player Manors are attackable (Manor House: 4,400 HP, 50%
-- burn threshold, 90 h burn). Mirrors packages/shared/src/manorWarfare.ts.
--
-- Like city buildings (0937), the warfare state is a checkpoint on the Manor's
-- own row: health (NULL = untouched, full health), health_at, burning_since and
-- the owner's active repair. Current health is projected from it with the
-- shared burn / repair rates. A Manor at 0 health is "burnt": it keeps every
-- stored item, furniture placement and station and cannot be entered until it
-- is repaired. Warfare never deletes or unbuilds a Manor, so no existing row
-- needs a backfill (NULL health already means full health).
ALTER TABLE player_manors
  ADD COLUMN IF NOT EXISTS health integer NULL,
  ADD COLUMN IF NOT EXISTS health_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS burning_since timestamptz NULL,
  -- Always the owner (CHECK below), whose FK already covers it.
  ADD COLUMN IF NOT EXISTS repair_player_id text NULL,
  ADD COLUMN IF NOT EXISTS repair_started_at timestamptz NULL;

ALTER TABLE player_manors
  DROP CONSTRAINT IF EXISTS player_manors_warfare_health_check,
  DROP CONSTRAINT IF EXISTS player_manors_warfare_burn_check,
  DROP CONSTRAINT IF EXISTS player_manors_warfare_repair_check;

ALTER TABLE player_manors
  ADD CONSTRAINT player_manors_warfare_health_check CHECK (
    health IS NULL OR (health BETWEEN 0 AND 4400 AND health_at IS NOT NULL)
  ),
  ADD CONSTRAINT player_manors_warfare_burn_check CHECK (
    burning_since IS NULL OR health IS NOT NULL
  ),
  ADD CONSTRAINT player_manors_warfare_repair_check CHECK (
    (repair_player_id IS NULL) = (repair_started_at IS NULL)
    AND (repair_player_id IS NULL OR (health IS NOT NULL AND repair_player_id = owner_player_id))
  );

CREATE INDEX IF NOT EXISTS player_manors_warfare_live_idx
  ON player_manors (id)
  WHERE burning_since IS NOT NULL OR repair_player_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS player_manors_repair_player_idx
  ON player_manors (repair_player_id)
  WHERE repair_player_id IS NOT NULL;

-- One row per hand attack, keyed by the attacker's request (replay-safe); the
-- latest row per (manor, attacker) drives the 24 h per-attacker cooldown.
CREATE TABLE IF NOT EXISTS manor_attack_operations (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  manor_id uuid NOT NULL REFERENCES player_manors(id) ON DELETE CASCADE,
  damage integer NOT NULL CHECK (damage >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (player_id, request_id)
);

CREATE INDEX IF NOT EXISTS manor_attack_operations_cooldown_idx
  ON manor_attack_operations (manor_id, player_id, created_at DESC);

COMMENT ON COLUMN player_manors.health IS
  'Manor war health checkpoint (0..4400, Manor House); NULL = untouched full health; 0 = burnt (cannot be entered until repaired).';
COMMENT ON TABLE manor_attack_operations IS
  'Replay-safe Manor hand attacks; drives the 24 h per-attacker cooldown.';
