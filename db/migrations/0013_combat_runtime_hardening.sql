ALTER TABLE player_combat_profiles
ADD COLUMN IF NOT EXISTS persistence_version bigint NOT NULL DEFAULT 0;

ALTER TABLE player_combat_profiles
DROP CONSTRAINT IF EXISTS player_combat_profiles_persistence_version_nonnegative;

ALTER TABLE player_combat_profiles
ADD CONSTRAINT player_combat_profiles_persistence_version_nonnegative
CHECK (persistence_version >= 0);
