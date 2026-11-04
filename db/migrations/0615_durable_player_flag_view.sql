ALTER TABLE players
  ADD COLUMN IF NOT EXISTS current_flag_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'players'::regclass
      AND conname = 'players_current_flag_id_fkey'
  ) THEN
    ALTER TABLE players
      ADD CONSTRAINT players_current_flag_id_fkey
      FOREIGN KEY (current_flag_id)
      REFERENCES flags(id)
      ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS players_current_flag_idx
  ON players (current_flag_id)
  WHERE current_flag_id IS NOT NULL;
