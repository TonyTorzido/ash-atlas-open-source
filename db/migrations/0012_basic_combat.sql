CREATE TABLE IF NOT EXISTS player_combat_profiles (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  max_health integer NOT NULL DEFAULT 100,
  current_health integer NOT NULL DEFAULT 100,
  base_attack_damage integer NOT NULL DEFAULT 10,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (max_health BETWEEN 1 AND 1000000),
  CHECK (current_health BETWEEN 0 AND max_health),
  CHECK (base_attack_damage BETWEEN 1 AND 100000)
);

INSERT INTO player_combat_profiles (player_id)
SELECT id
FROM players
ON CONFLICT (player_id) DO NOTHING;

DROP TRIGGER IF EXISTS player_combat_profiles_set_updated_at ON player_combat_profiles;
CREATE TRIGGER player_combat_profiles_set_updated_at
BEFORE UPDATE ON player_combat_profiles
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
