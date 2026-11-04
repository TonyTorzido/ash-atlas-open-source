ALTER TABLE player_death_xp_penalties
  DROP CONSTRAINT IF EXISTS player_death_xp_penalties_penalty_basis_points_check,
  ADD CONSTRAINT player_death_xp_penalties_penalty_basis_points_check
    CHECK (penalty_basis_points IN (300, 1000)),
  DROP CONSTRAINT IF EXISTS player_death_xp_penalties_xp_lost_calculation_check,
  ADD CONSTRAINT player_death_xp_penalties_xp_lost_calculation_check
    CHECK (
      xp_lost = LEAST(
        previous_xp - level_floor_xp,
        FLOOR(penalty_basis_xp::numeric * penalty_basis_points::numeric / 10000)::bigint
      )
    );

COMMENT ON COLUMN player_death_xp_penalties.penalty_basis_points IS
  'Penalty rate in basis points. New rows use 300 (3%); 1000 is retained for historical rows.';
