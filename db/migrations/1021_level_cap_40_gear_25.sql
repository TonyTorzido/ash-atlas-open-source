-- Raise the character level cap from 25 to 40 while weapons and armor stay
-- capped at Level 25 (packages/shared/src/progression.ts CURRENT_LEVEL_CAP and
-- EQUIPMENT_LEVEL_CAP). Only character levels and skill points change here:
--   * Item levels, effective (gear) levels, and the 0885 banked item levels stay
--     as they are; banked levels stay banked while gear is capped at 25.
--   * Monster levels and challenge tiers keep the 25-cap bands
--     (0-5/6-10/11-15/16-20/21-25), so generated_world_mobs is untouched.
--   * Every character-level range constraint is already 0..40 (0879; 0885 kept it).

-- Character level. Lifetime XP banked past Level 25 while the cap was 25 counts
-- toward Levels 26-40 again (TOTAL_XP_FOR_LEVEL). Levels only move up.
WITH thresholds(level, threshold) AS (
  VALUES
    (25, 1000000), (26, 1129902), (27, 1275743), (28, 1439481), (29, 1623310),
    (30, 1829697), (31, 2061409), (32, 2321554), (33, 2613621), (34, 2941527),
    (35, 3309670), (36, 3722986), (37, 4187020), (38, 4707995), (39, 5292897),
    (40, 5949572)
), resolved AS (
  SELECT profile.player_id, max(thresholds.level) AS level
  FROM player_progression_profiles AS profile
  JOIN thresholds ON thresholds.threshold <= profile.total_xp
  WHERE profile.total_xp >= 1129902
  GROUP BY profile.player_id
)
UPDATE player_progression_profiles AS profile
SET level = resolved.level,
    persistence_version = profile.persistence_version + 1,
    updated_at = now()
FROM resolved
WHERE profile.player_id = resolved.player_id
  AND profile.level < resolved.level;

-- Skill points: one point per character level through the new cap, matching
-- lockAndReconcileSkillPointState. Spent points above the entitlement stay
-- grandfathered (earned = spent), as in 0782/0885.
WITH actual_spending AS (
  SELECT state.player_id,
         LEAST(40, GREATEST(0, progression.level)) AS level_entitlement,
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
  WHERE progression.level > 25
)
UPDATE player_skill_point_state AS state
SET total_earned = GREATEST(actual.level_entitlement, actual.total_spent),
    total_spent = actual.total_spent,
    revision = state.revision + 1,
    updated_at = now()
FROM actual_spending AS actual
WHERE state.player_id = actual.player_id
  AND (state.total_earned, state.total_spent) IS DISTINCT FROM
      (GREATEST(actual.level_entitlement, actual.total_spent), actual.total_spent);

COMMENT ON TABLE equipment_level_cap_banked_levels IS
  'Item levels above 25 clamped by 0885_level_cap_25. Still banked after 1021 (characters to 40, gear stays 25); restore them only if the equipment level cap is raised.';
