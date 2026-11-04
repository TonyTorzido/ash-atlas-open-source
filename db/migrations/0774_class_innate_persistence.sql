ALTER TABLE player_combat_profiles
  ADD COLUMN IF NOT EXISTS life_state text NOT NULL DEFAULT 'alive',
  ADD COLUMN IF NOT EXISTS downed_until timestamptz NULL;

DO $$ BEGIN
  ALTER TABLE player_combat_profiles ADD CONSTRAINT player_combat_profiles_life_state_check
    CHECK (life_state IN ('alive', 'downed', 'defeated', 'respawning'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE parties
  ADD COLUMN IF NOT EXISTS saving_grace_cooldown_ends_at timestamptz NULL;
