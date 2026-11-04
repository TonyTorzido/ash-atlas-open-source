-- metals phase 3 (Revenant Metal): PvP max-HP loss and the persistent Revenant armor Lich.
-- Skeletons are memory-only and need no table.

-- The current PvP max-HP penalty per player. The effective penalty recovers 1 max HP every 75 minutes
-- counted from recovery_anchor_at and is computed lazily; the row only changes when a PvP death
-- adds loss.
CREATE TABLE IF NOT EXISTS player_max_health_penalties (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  penalty integer NOT NULL CHECK (penalty BETWEEN 0 AND 10000),
  recovery_anchor_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One row per PvP death operation, so a retried death penalty never takes max HP twice.
CREATE TABLE IF NOT EXISTS player_pvp_max_health_losses (
  operation_key text PRIMARY KEY CHECK (length(operation_key) BETWEEN 1 AND 240),
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  killer_player_id text NOT NULL CHECK (length(killer_player_id) BETWEEN 1 AND 160),
  revenant_armor boolean NOT NULL,
  requested_loss integer NOT NULL CHECK (requested_loss IN (4, 6)),
  applied_loss integer NOT NULL CHECK (applied_loss BETWEEN 0 AND requested_loss),
  penalty_before integer NOT NULL CHECK (penalty_before >= 0),
  penalty_after integer NOT NULL CHECK (penalty_after = penalty_before + applied_loss),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (requested_loss = CASE WHEN revenant_armor THEN 4 ELSE 6 END)
);

CREATE INDEX IF NOT EXISTS player_pvp_max_health_losses_player_created_idx
  ON player_pvp_max_health_losses (player_id, created_at DESC);

-- At most one Lich per owner. It keeps its stat snapshot and current HP across logout and
-- restarts; its 20 hours keep running while it is despawned.
CREATE TABLE IF NOT EXISTS player_revenant_metal_liches (
  owner_player_id text PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  death_operation_key text NOT NULL CHECK (length(death_operation_key) BETWEEN 1 AND 240),
  stats jsonb NOT NULL CHECK (jsonb_typeof(stats) = 'object'),
  max_health integer NOT NULL CHECK (max_health > 0),
  current_health integer NOT NULL CHECK (current_health > 0 AND current_health <= max_health),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);
