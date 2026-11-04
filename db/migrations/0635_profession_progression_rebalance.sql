-- Rebalance the launch profession curve to 4,000 XP and correct historical flag awards.

ALTER TABLE player_profession_progress
  DROP CONSTRAINT IF EXISTS player_profession_progress_xp_check;

WITH corrected_builder_xp AS (
  SELECT
    player_id,
    LEAST(4000, SUM(
      CASE
        WHEN operation_key LIKE 'profession-xp:flag-build:%' THEN 50
        ELSE granted_xp
      END
    ))::integer AS xp
  FROM mastery_progression_operations
  WHERE profession_id = 'builder'
  GROUP BY player_id
)
UPDATE player_profession_progress AS progress
SET xp = corrected.xp
FROM corrected_builder_xp AS corrected
WHERE progress.player_id = corrected.player_id
  AND progress.profession_id = 'builder';

UPDATE player_profession_progress
SET xp = LEAST(4000, GREATEST(0, xp));

UPDATE player_profession_progress
SET rank = CASE
      WHEN xp >= 4000 THEN 8
      WHEN xp >= 3063 THEN 7
      WHEN xp >= 2250 THEN 6
      WHEN xp >= 1563 THEN 5
      WHEN xp >= 1000 THEN 4
      WHEN xp >= 563 THEN 3
      WHEN xp >= 250 THEN 2
      WHEN xp >= 63 THEN 1
      ELSE 0
    END,
    completed_at = CASE WHEN xp >= 4000 THEN COALESCE(completed_at, now()) ELSE NULL END,
    revision = revision + 1;

ALTER TABLE player_profession_progress
  ADD CONSTRAINT player_profession_progress_xp_check CHECK (xp BETWEEN 0 AND 4000);

INSERT INTO player_mastery_achievements (player_id, achievement_id, title, badge_id, completed_at)
SELECT
  progress.player_id,
  'master_' || progress.profession_id,
  'Master ' || initcap(progress.profession_id),
  'master_' || progress.profession_id,
  COALESCE(progress.completed_at, now())
FROM player_profession_progress AS progress
WHERE progress.rank = 8
ON CONFLICT DO NOTHING;

UPDATE player_mastery_state AS state
SET equipped_title = earned.title,
    revision = state.revision + 1
FROM (
  SELECT DISTINCT ON (player_id) player_id, title
  FROM player_mastery_achievements
  ORDER BY player_id, completed_at, achievement_id
) AS earned
WHERE state.player_id = earned.player_id
  AND state.equipped_title IS NULL;

UPDATE player_profiles AS profile
SET title = earned.title
FROM (
  SELECT DISTINCT ON (player_id) player_id, title
  FROM player_mastery_achievements
  ORDER BY player_id, completed_at, achievement_id
) AS earned
WHERE profile.player_id = earned.player_id
  AND profile.title IS NULL;
