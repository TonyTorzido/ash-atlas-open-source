ALTER TABLE player_death_xp_penalties
  ADD COLUMN penalty_basis_xp bigint;

UPDATE player_death_xp_penalties
SET penalty_basis_xp = previous_xp
WHERE penalty_basis_xp IS NULL;

ALTER TABLE player_death_xp_penalties
  ALTER COLUMN penalty_basis_xp SET NOT NULL,
  ADD CONSTRAINT player_death_xp_penalties_penalty_basis_xp_nonnegative_check
    CHECK (penalty_basis_xp >= 0),
  DROP CONSTRAINT player_death_xp_penalties_check,
  ADD CONSTRAINT player_death_xp_penalties_xp_lost_calculation_check
    CHECK (xp_lost = LEAST(previous_xp, penalty_basis_xp / 10));

COMMENT ON COLUMN player_death_xp_penalties.penalty_basis_xp IS
  'Full XP requirement used as the 1000-basis-point death-penalty basis; historical rows retain previous total XP.';
