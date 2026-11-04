-- Reconcile retained Warrior loadouts to the five-action launch interface.
-- Taunt remains innate and outside the four persisted assignable slots.

WITH sanitized AS (
  SELECT
    loadout.player_id,
    progress.mastery_rank,
    CASE
      WHEN loadout.reset_active_ids[1] = 'warrior_punishing_strike' AND progress.mastery_rank >= 1
        THEN loadout.reset_active_ids[1]
      WHEN loadout.reset_active_ids[1] = 'warrior_guarded_strike' AND progress.mastery_rank >= 5
        THEN loadout.reset_active_ids[1]
      ELSE NULL
    END AS reset_1,
    CASE
      WHEN loadout.reset_active_ids[2] = 'warrior_punishing_strike' AND progress.mastery_rank >= 1
        THEN loadout.reset_active_ids[2]
      WHEN loadout.reset_active_ids[2] = 'warrior_guarded_strike' AND progress.mastery_rank >= 5
        THEN loadout.reset_active_ids[2]
      ELSE NULL
    END AS reset_2,
    CASE
      WHEN loadout.normal_active_ids[1] = 'warrior_cleave' AND progress.mastery_rank >= 3
        THEN loadout.normal_active_ids[1]
      WHEN loadout.normal_active_ids[1] = 'warrior_fortify' AND progress.mastery_rank >= 7
        THEN loadout.normal_active_ids[1]
      ELSE NULL
    END AS normal_1,
    CASE
      WHEN loadout.normal_active_ids[2] = 'warrior_cleave' AND progress.mastery_rank >= 3
        THEN loadout.normal_active_ids[2]
      WHEN loadout.normal_active_ids[2] = 'warrior_fortify' AND progress.mastery_rank >= 7
        THEN loadout.normal_active_ids[2]
      ELSE NULL
    END AS normal_2
  FROM player_class_loadouts AS loadout
  JOIN player_class_progress AS progress
    ON progress.player_id = loadout.player_id AND progress.class_id = 'warrior'
  WHERE loadout.class_id = 'warrior'
)
UPDATE player_class_loadouts AS loadout
SET reset_active_ids = ARRAY[
      COALESCE(sanitized.reset_1, sanitized.reset_2),
      CASE
        WHEN sanitized.mastery_rank >= 5
          AND sanitized.reset_1 IS NOT NULL
          AND sanitized.reset_2 IS DISTINCT FROM sanitized.reset_1
        THEN sanitized.reset_2
        ELSE NULL
      END
    ]::text[],
    normal_active_ids = ARRAY[
      COALESCE(sanitized.normal_1, sanitized.normal_2),
      CASE
        WHEN sanitized.mastery_rank >= 7
          AND sanitized.normal_1 IS NOT NULL
          AND sanitized.normal_2 IS DISTINCT FROM sanitized.normal_1
        THEN sanitized.normal_2
        ELSE NULL
      END
    ]::text[],
    passive_tier_ids = ARRAY[NULL,NULL,NULL]::text[],
    revision = revision + 1
FROM sanitized
WHERE loadout.player_id = sanitized.player_id
  AND loadout.class_id = 'warrior';

-- Fill only empty compatible slots. These updates never replace a retained
-- valid player choice and run once as a forward migration.
UPDATE player_class_loadouts AS loadout
SET reset_active_ids = CASE
      WHEN loadout.reset_active_ids[1] IS NULL
        THEN ARRAY['warrior_punishing_strike', loadout.reset_active_ids[2]]::text[]
      WHEN loadout.reset_active_ids[2] IS NULL
        THEN ARRAY[loadout.reset_active_ids[1], 'warrior_punishing_strike']::text[]
      ELSE loadout.reset_active_ids
    END,
    revision = revision + 1
FROM player_class_progress AS progress
WHERE progress.player_id = loadout.player_id
  AND progress.class_id = 'warrior'
  AND loadout.class_id = 'warrior'
  AND progress.mastery_rank >= 1
  AND array_position(loadout.reset_active_ids, 'warrior_punishing_strike') IS NULL
  AND array_position(loadout.reset_active_ids, NULL) IS NOT NULL;

UPDATE player_class_loadouts AS loadout
SET reset_active_ids = CASE
      WHEN loadout.reset_active_ids[1] IS NULL
        THEN ARRAY['warrior_guarded_strike', loadout.reset_active_ids[2]]::text[]
      WHEN loadout.reset_active_ids[2] IS NULL
        THEN ARRAY[loadout.reset_active_ids[1], 'warrior_guarded_strike']::text[]
      ELSE loadout.reset_active_ids
    END,
    revision = revision + 1
FROM player_class_progress AS progress
WHERE progress.player_id = loadout.player_id
  AND progress.class_id = 'warrior'
  AND loadout.class_id = 'warrior'
  AND progress.mastery_rank >= 5
  AND array_position(loadout.reset_active_ids, 'warrior_guarded_strike') IS NULL
  AND array_position(loadout.reset_active_ids, NULL) IS NOT NULL;

UPDATE player_class_loadouts AS loadout
SET normal_active_ids = CASE
      WHEN loadout.normal_active_ids[1] IS NULL
        THEN ARRAY['warrior_cleave', loadout.normal_active_ids[2]]::text[]
      WHEN loadout.normal_active_ids[2] IS NULL
        THEN ARRAY[loadout.normal_active_ids[1], 'warrior_cleave']::text[]
      ELSE loadout.normal_active_ids
    END,
    revision = revision + 1
FROM player_class_progress AS progress
WHERE progress.player_id = loadout.player_id
  AND progress.class_id = 'warrior'
  AND loadout.class_id = 'warrior'
  AND progress.mastery_rank >= 3
  AND array_position(loadout.normal_active_ids, 'warrior_cleave') IS NULL
  AND array_position(loadout.normal_active_ids, NULL) IS NOT NULL;

UPDATE player_class_loadouts AS loadout
SET normal_active_ids = CASE
      WHEN loadout.normal_active_ids[1] IS NULL
        THEN ARRAY['warrior_fortify', loadout.normal_active_ids[2]]::text[]
      WHEN loadout.normal_active_ids[2] IS NULL
        THEN ARRAY[loadout.normal_active_ids[1], 'warrior_fortify']::text[]
      ELSE loadout.normal_active_ids
    END,
    revision = revision + 1
FROM player_class_progress AS progress
WHERE progress.player_id = loadout.player_id
  AND progress.class_id = 'warrior'
  AND loadout.class_id = 'warrior'
  AND progress.mastery_rank >= 7
  AND array_position(loadout.normal_active_ids, 'warrior_fortify') IS NULL
  AND array_position(loadout.normal_active_ids, NULL) IS NOT NULL;
