-- Every General skill rank now costs 1 Skill Point. Rank 3 used to
-- cost 2 for the 20 General skills below (Cleave, Archery, Martial Arts and
-- Tactics already cost 1) and for the Tidecraft and Rare Beast Mastery world
-- knowledge, so a rank-3 row bought at the old price holds points_spent = 4.
-- Both live in player_skill_ranks.
--
-- Policy:
-- * Only rank-3 rows whose persisted spending is above the new full price (3)
--   are refunded, by exactly 1. Grandfathered or partly paid rows (points_spent
--   <= 3) paid no extra point and are left alone; points_spent stays >= 3.
-- * Each refund is recorded once in skill_point_operations, keyed
--   `rank-cost-refund-1100:<player>:<skill>`.
-- * The player's balance is then reconciled exactly as lockAndReconcileSkillPointState
--   does: total_spent = SUM(points_spent) over general + specialization ranks,
--   total_earned = GREATEST(level entitlement (1 per level, cap 40), total_spent).
--   A player whose earned was inflated by spending above entitlement therefore
--   drops by the same point (0 available before and after); everyone else keeps
--   total_earned and gains 1 available point per refunded skill.
--
-- Re-running is a no-op: refunded rows are back at points_spent = 3 and their
-- operation key exists.

LOCK TABLE player_skill_ranks, player_specialization_ranks, player_skill_point_state
  IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE skill_rank_cost_refunds ON COMMIT DROP AS
SELECT ranks.player_id,
       ranks.skill_id,
       ranks.points_spent AS points_spent_before,
       'rank-cost-refund-1100:' || ranks.player_id || ':' || ranks.skill_id AS operation_key
FROM player_skill_ranks AS ranks
WHERE ranks.rank = 3
  AND ranks.points_spent > 3
  AND ranks.skill_id IN (
    'shield_charge', 'cleanse', 'taunt', 'war_standard', 'ricochet', 'heroism',
    'quarry_sense', 'huntsmans_edge', 'perfect_strike', 'pierce_armor', 'blight_strike',
    'provoke', 'pursuit', 'scavenge', 'calm_mind', 'second_wind', 'deathburst',
    'concentration', 'companion_bond', 'delvers_lore',
    'tidecraft', 'rare_beast_mastery'
  )
  AND NOT EXISTS (
    SELECT 1 FROM skill_point_operations AS operation
    WHERE operation.operation_key =
      'rank-cost-refund-1100:' || ranks.player_id || ':' || ranks.skill_id
  );

INSERT INTO skill_point_operations (operation_key, player_id, action, payload, result, completed_at)
SELECT operation_key, player_id, 'rank_cost_refund',
       jsonb_build_object(
         'migration', '1100', 'skillId', skill_id, 'rank', 3, 'refund', 1,
         'pointsSpentBefore', points_spent_before
       ),
       jsonb_build_object('migrated', true, 'pointsSpentAfter', points_spent_before - 1),
       now()
FROM skill_rank_cost_refunds;

UPDATE player_skill_ranks AS ranks
SET points_spent = ranks.points_spent - 1,
    revision = ranks.revision + 1
FROM skill_rank_cost_refunds AS refund
WHERE ranks.player_id = refund.player_id
  AND ranks.skill_id = refund.skill_id
  AND ranks.rank = 3
  AND ranks.points_spent > 3;

-- Same reconciliation the skill authority applies on its next read.
WITH actual_spending AS (
  SELECT state.player_id,
         LEAST(40, GREATEST(0, progression.level)) AS level_entitlement,
         COALESCE(general.total_spent, 0) + COALESCE(specialization.total_spent, 0) AS total_spent
  FROM player_skill_point_state AS state
  JOIN (SELECT DISTINCT player_id FROM skill_rank_cost_refunds) AS affected
    ON affected.player_id = state.player_id
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
