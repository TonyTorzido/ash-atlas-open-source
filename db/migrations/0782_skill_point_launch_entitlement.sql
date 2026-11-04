BEGIN;

LOCK TABLE player_skill_point_state, player_progression_profiles,
  player_skill_ranks, player_specialization_ranks, player_specialization_state IN SHARE ROW EXCLUSIVE MODE;

UPDATE player_specialization_state
SET active_specialization_id = NULL,
    revision = revision + 1,
    updated_at = now()
WHERE active_specialization_id IS NOT NULL
  AND active_specialization_id NOT IN ('warrior', 'ranger', 'ninja', 'paladin', 'cleric');

WITH actual_spending AS (
  SELECT state.player_id,
         LEAST(25, GREATEST(0, progression.level)) AS level_entitlement,
         COALESCE(general.total_spent, 0) + COALESCE(specialization.total_spent, 0) AS total_spent
  FROM player_skill_point_state AS state
  JOIN player_progression_profiles AS progression ON progression.player_id = state.player_id
  LEFT JOIN (
    SELECT player_id, SUM(points_spent)::integer AS total_spent
    FROM player_skill_ranks GROUP BY player_id
  ) AS general ON general.player_id = state.player_id
  LEFT JOIN (
    SELECT player_id, SUM(points_spent)::integer AS total_spent
    FROM player_specialization_ranks GROUP BY player_id
  ) AS specialization ON specialization.player_id = state.player_id
)
UPDATE player_skill_point_state AS state
SET total_earned = GREATEST(actual.level_entitlement, actual.total_spent),
    total_spent = actual.total_spent,
    revision = state.revision + 1
FROM actual_spending AS actual
WHERE state.player_id = actual.player_id
  AND (state.total_earned, state.total_spent) IS DISTINCT FROM
      (GREATEST(actual.level_entitlement, actual.total_spent), actual.total_spent);

COMMENT ON TABLE player_skill_point_state IS
  'Authoritative V3 Skill Point balance: one point per level through 25; actual persisted spending above entitlement is grandfathered with zero available.';

COMMIT;
