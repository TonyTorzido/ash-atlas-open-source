ALTER TABLE player_combat_profiles
  ADD COLUMN respawn_available_at timestamptz NULL;

UPDATE player_combat_profiles
SET respawn_available_at = clock_timestamp()
WHERE life_state = 'respawning'
  AND respawn_available_at IS NULL;

ALTER TABLE player_combat_profiles
  ADD CONSTRAINT player_combat_profiles_respawn_available_at_check CHECK (
    (life_state = 'respawning') = (respawn_available_at IS NOT NULL)
  );

COMMENT ON COLUMN player_combat_profiles.respawn_available_at IS
  'Authoritative earliest manual-respawn time; present exactly while the player is respawning.';
