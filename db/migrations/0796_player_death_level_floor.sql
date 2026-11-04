ALTER TABLE player_death_xp_penalties
  ADD COLUMN level_floor_xp bigint;

-- Historical penalties predate the permanent-level-floor rule. Their resulting XP is the
-- only floor that preserves the recorded XP loss, levels, and replay result without rewriting history.
UPDATE player_death_xp_penalties
SET level_floor_xp = resulting_xp
WHERE level_floor_xp IS NULL;

ALTER TABLE player_death_xp_penalties
  ALTER COLUMN level_floor_xp SET NOT NULL,
  ADD CONSTRAINT player_death_xp_penalties_level_floor_xp_nonnegative_check
    CHECK (level_floor_xp >= 0),
  ADD CONSTRAINT player_death_xp_penalties_level_floor_xp_not_above_previous_check
    CHECK (level_floor_xp <= previous_xp),
  DROP CONSTRAINT player_death_xp_penalties_xp_lost_calculation_check,
  ADD CONSTRAINT player_death_xp_penalties_xp_lost_calculation_check
    CHECK (xp_lost = LEAST(previous_xp - level_floor_xp, penalty_basis_xp / 10));

COMMENT ON COLUMN player_death_xp_penalties.level_floor_xp IS
  'Minimum total XP for this penalty. Historical rows use their recorded resulting XP; new rows use the permanent threshold for the recorded previous level.';
