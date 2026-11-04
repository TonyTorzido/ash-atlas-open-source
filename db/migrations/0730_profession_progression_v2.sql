-- Profession Progression V2: preserve rank-relative progress while moving 4,000 XP to 100,000 XP.

ALTER TABLE player_profession_progress
  ADD COLUMN IF NOT EXISTS curve_version smallint NOT NULL DEFAULT 1;

ALTER TABLE mastery_progression_operations
  ADD COLUMN IF NOT EXISTS policy_id text NULL,
  ADD COLUMN IF NOT EXISTS policy_version smallint NULL,
  ADD COLUMN IF NOT EXISTS policy_fingerprint text NULL;

ALTER TABLE player_profession_progress
  DROP CONSTRAINT IF EXISTS player_profession_progress_xp_check;

CREATE TEMP TABLE profession_v2_curve_mapping ON COMMIT DROP AS
WITH old_progress AS (
  SELECT
    player_id,
    profession_id,
    LEAST(4000, GREATEST(0, xp))::integer AS old_xp,
    GREATEST(
      rank::integer,
      CASE
        WHEN xp >= 4000 THEN 8 WHEN xp >= 3063 THEN 7
        WHEN xp >= 2250 THEN 6 WHEN xp >= 1563 THEN 5
        WHEN xp >= 1000 THEN 4 WHEN xp >= 563 THEN 3
        WHEN xp >= 250 THEN 2 WHEN xp >= 63 THEN 1
        ELSE 0
      END
    ) AS old_rank,
    completed_at
  FROM player_profession_progress
  WHERE curve_version = 1
), bounded AS (
  SELECT
    old_progress.*,
    (ARRAY[0,63,250,563,1000,1563,2250,3063,4000])[old_rank + 1] AS old_floor,
    (ARRAY[0,3021,7218,13049,21152,32412,48056,69795,100000])[old_rank + 1] AS new_floor
  FROM old_progress
), mapped AS (
  SELECT
    bounded.*,
    CASE
      WHEN old_rank >= 8 THEN 100000
      ELSE new_floor + ROUND(
        (GREATEST(old_xp, old_floor) - old_floor)::numeric
        * (
          (ARRAY[0,3021,7218,13049,21152,32412,48056,69795,100000])[old_rank + 2]
          - new_floor
        )
        / (
          (ARRAY[0,63,250,563,1000,1563,2250,3063,4000])[old_rank + 2]
          - old_floor
        )
      )::integer
    END AS new_xp
  FROM bounded
)
SELECT
  player_id,
  profession_id,
  old_xp,
  old_rank,
  new_xp,
  old_rank AS new_rank,
  completed_at
FROM mapped;

INSERT INTO mastery_progression_operations (
  operation_key,
  player_id,
  profession_id,
  source_type,
  source_id,
  requested_xp,
  granted_xp,
  previous_xp,
  resulting_xp,
  previous_rank,
  resulting_rank,
  random_results,
  result,
  policy_id,
  policy_version,
  policy_fingerprint
)
SELECT
  'profession-curve-v2:' || player_id || ':' || profession_id,
  player_id,
  profession_id,
  'development',
  'profession-curve-v2',
  new_xp - old_xp,
  new_xp - old_xp,
  old_xp,
  new_xp,
  old_rank,
  new_rank,
  jsonb_build_object('oldCurveVersion', 1, 'newCurveVersion', 2),
  jsonb_build_object(
    'operationKey', 'profession-curve-v2:' || player_id || ':' || profession_id,
    'playerId', player_id,
    'trackId', profession_id,
    'requestedXp', new_xp - old_xp,
    'grantedXp', new_xp - old_xp,
    'previousXp', old_xp,
    'resultingXp', new_xp,
    'previousRank', old_rank,
    'resultingRank', new_rank,
    'replayed', false,
    'newlyMastered', false
  ),
  'curve-migration',
  2,
  NULL
FROM profession_v2_curve_mapping
ON CONFLICT (operation_key) DO NOTHING;

UPDATE player_profession_progress AS progress
SET xp = mapping.new_xp,
    rank = mapping.new_rank::smallint,
    curve_version = 2,
    completed_at = CASE
      WHEN mapping.new_rank = 8 THEN COALESCE(progress.completed_at, now())
      ELSE NULL
    END,
    revision = revision + 1
FROM profession_v2_curve_mapping AS mapping
WHERE progress.player_id = mapping.player_id
  AND progress.profession_id = mapping.profession_id
  AND progress.curve_version = 1;

ALTER TABLE player_profession_progress
  ALTER COLUMN curve_version SET DEFAULT 2,
  DROP CONSTRAINT IF EXISTS player_profession_progress_xp_check,
  DROP CONSTRAINT IF EXISTS player_profession_progress_curve_version_check;

ALTER TABLE player_profession_progress
  ADD CONSTRAINT player_profession_progress_xp_check CHECK (xp BETWEEN 0 AND 100000),
  ADD CONSTRAINT player_profession_progress_curve_version_check CHECK (curve_version > 0);

INSERT INTO player_mastery_achievements (
  player_id, achievement_id, title, badge_id, completed_at
)
SELECT
  player_id,
  'master_' || profession_id,
  'Master ' || initcap(profession_id),
  'master_' || profession_id,
  COALESCE(completed_at, now())
FROM player_profession_progress
WHERE curve_version = 2 AND rank = 8
ON CONFLICT DO NOTHING;
