-- Durable GPS relocation cooldown state.
-- NULL means the player has never completed a GPS relocation.
ALTER TABLE players
  ADD COLUMN IF NOT EXISTS last_relocated_at timestamptz NULL;

CREATE INDEX IF NOT EXISTS players_last_relocated_at_idx
  ON players (last_relocated_at)
  WHERE last_relocated_at IS NOT NULL;
