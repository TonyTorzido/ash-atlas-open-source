-- Warrior Progression V3. XP is the canonical rank authority; retained progress is
-- projected by fractional journey completion and every adjustment is recorded.

LOCK TABLE player_class_progress IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE player_class_progress
  ADD COLUMN curve_version smallint NOT NULL DEFAULT 1 CHECK (curve_version > 0);

CREATE TABLE warrior_xp_curve_adjustments (
  operation_key text PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  from_curve_version smallint NOT NULL CHECK (from_curve_version IN (1, 2)),
  to_curve_version smallint NOT NULL CHECK (to_curve_version = 3),
  previous_xp integer NOT NULL CHECK (previous_xp BETWEEN 0 AND 200000),
  resulting_xp integer NOT NULL CHECK (resulting_xp BETWEEN 0 AND 72000),
  xp_delta integer NOT NULL,
  previous_rank smallint NOT NULL CHECK (previous_rank BETWEEN 0 AND 25),
  resulting_rank smallint NOT NULL CHECK (resulting_rank BETWEEN 0 AND 15),
  source_max_xp integer NOT NULL CHECK (source_max_xp IN (38000, 200000)),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (player_id, to_curve_version),
  CHECK (resulting_xp = previous_xp + xp_delta)
);

CREATE TEMP TABLE warrior_v3_projection ON COMMIT DROP AS
WITH deployment AS (
  SELECT applied_at
  FROM schema_migrations
  WHERE version = '0732_warrior_pve_rework.sql'
), classified AS (
  SELECT progress.player_id, progress.mastery_xp AS previous_xp,
         progress.mastery_rank AS previous_rank,
         CASE WHEN EXISTS (
           SELECT 1
           FROM class_progression_operations AS operation
           CROSS JOIN deployment
           WHERE operation.player_id = progress.player_id
             AND operation.class_id = 'warrior'
             AND operation.created_at >= deployment.applied_at
         ) OR EXISTS (
           SELECT 1
           FROM dev_progression_operations AS operation
           CROSS JOIN deployment
           WHERE operation.player_id = progress.player_id
             AND operation.progression_type IN ('warrior_level', 'warrior_mastery')
             AND operation.created_at >= deployment.applied_at
             AND operation.completed_at IS NOT NULL
         ) THEN 2 ELSE 1 END AS from_curve_version,
         CASE WHEN EXISTS (
           SELECT 1
           FROM class_progression_operations AS operation
           CROSS JOIN deployment
           WHERE operation.player_id = progress.player_id
             AND operation.class_id = 'warrior'
             AND operation.created_at >= deployment.applied_at
         ) OR EXISTS (
           SELECT 1
           FROM dev_progression_operations AS operation
           CROSS JOIN deployment
           WHERE operation.player_id = progress.player_id
             AND operation.progression_type IN ('warrior_level', 'warrior_mastery')
             AND operation.created_at >= deployment.applied_at
             AND operation.completed_at IS NOT NULL
         ) THEN 38000 ELSE 200000 END AS source_max_xp,
         progress.completed_at IS NOT NULL
           OR EXISTS (SELECT 1 FROM player_mastery_achievements AS achievement
                      WHERE achievement.player_id = progress.player_id
                        AND achievement.achievement_id = 'master_warrior') AS mastered
  FROM player_class_progress AS progress
  WHERE progress.class_id = 'warrior' AND progress.curve_version = 1
), mapped AS (
  SELECT *, CASE WHEN mastered OR previous_xp >= source_max_xp THEN 72000
                 ELSE ROUND(LEAST(source_max_xp, previous_xp)::numeric * 72000 / source_max_xp)::integer
            END AS resulting_xp
  FROM classified
)
SELECT *, CASE
  WHEN resulting_xp >= 72000 THEN 15 WHEN resulting_xp >= 60068 THEN 14
  WHEN resulting_xp >= 49946 THEN 13 WHEN resulting_xp >= 41360 THEN 12
  WHEN resulting_xp >= 34075 THEN 11 WHEN resulting_xp >= 27895 THEN 10
  WHEN resulting_xp >= 22652 THEN 9 WHEN resulting_xp >= 18205 THEN 8
  WHEN resulting_xp >= 14432 THEN 7 WHEN resulting_xp >= 11231 THEN 6
  WHEN resulting_xp >= 8515 THEN 5 WHEN resulting_xp >= 6212 THEN 4
  WHEN resulting_xp >= 4257 THEN 3 WHEN resulting_xp >= 2600 THEN 2
  WHEN resulting_xp >= 1193 THEN 1 ELSE 0 END AS resulting_rank
FROM mapped;

INSERT INTO warrior_xp_curve_adjustments (
  operation_key, player_id, from_curve_version, to_curve_version,
  previous_xp, resulting_xp, xp_delta, previous_rank, resulting_rank, source_max_xp
)
SELECT 'warrior-curve:v' || from_curve_version || '-to-v3:' || player_id,
       player_id, from_curve_version, 3, previous_xp, resulting_xp,
       resulting_xp - previous_xp, previous_rank, resulting_rank, source_max_xp
FROM warrior_v3_projection
ON CONFLICT (player_id, to_curve_version) DO NOTHING;

ALTER TABLE player_class_progress
  DROP CONSTRAINT IF EXISTS player_class_progress_mastery_rank_launch_check;

UPDATE player_class_progress AS progress
SET mastery_xp = projection.resulting_xp,
    mastery_rank = projection.resulting_rank,
    curve_version = 3,
    completed_at = CASE WHEN projection.resulting_rank = 15
      THEN COALESCE(progress.completed_at, now()) ELSE NULL END,
    updated_at = now()
FROM warrior_v3_projection AS projection
WHERE progress.player_id = projection.player_id AND progress.class_id = 'warrior';

INSERT INTO player_mastery_achievements (player_id, achievement_id, title, badge_id, completed_at)
SELECT player_id, 'master_warrior', 'Master Warrior', 'master_warrior', COALESCE(completed_at, now())
FROM player_class_progress
WHERE class_id = 'warrior' AND mastery_rank = 15
ON CONFLICT (player_id, achievement_id) DO NOTHING;

INSERT INTO player_mastery_state (player_id)
SELECT player_id FROM player_class_progress WHERE class_id = 'warrior'
ON CONFLICT (player_id) DO NOTHING;
UPDATE player_mastery_state AS state
SET equipped_title = COALESCE(state.equipped_title, 'Master Warrior'), revision = state.revision + 1
FROM player_class_progress AS progress
WHERE progress.player_id = state.player_id
  AND progress.class_id = 'warrior' AND progress.mastery_rank = 15;

INSERT INTO player_profiles (player_id)
SELECT player_id FROM player_class_progress WHERE class_id = 'warrior' AND mastery_rank = 15
ON CONFLICT (player_id) DO NOTHING;
UPDATE player_profiles AS profile
SET title = COALESCE(profile.title, 'Master Warrior')
FROM player_class_progress AS progress
WHERE progress.player_id = profile.player_id
  AND progress.class_id = 'warrior' AND progress.mastery_rank = 15;

ALTER TABLE player_class_progress
  ALTER COLUMN curve_version SET DEFAULT 1,
  ADD CONSTRAINT player_class_progress_mastery_rank_v3_check CHECK (
    (class_id = 'warrior' AND curve_version = 3 AND mastery_rank BETWEEN 0 AND 15 AND mastery_xp BETWEEN 0 AND 72000)
    OR (class_id <> 'warrior' AND curve_version = 1 AND mastery_rank BETWEEN 0 AND 25 AND mastery_xp >= 0)
  );

UPDATE player_class_loadouts AS loadout
SET normal_active_ids = ARRAY[
      CASE WHEN progress.mastery_rank >= 1 THEN COALESCE(loadout.normal_active_ids[1], 'warrior_empowered_hit') END,
      CASE WHEN progress.mastery_rank >= 4 THEN loadout.normal_active_ids[2] END
    ]::text[],
    passive_tier_ids = ARRAY[
      CASE WHEN progress.mastery_rank >= 2 THEN loadout.passive_tier_ids[1] END,
      CASE WHEN progress.mastery_rank >= 7 THEN loadout.passive_tier_ids[2] END,
      CASE WHEN progress.mastery_rank >= 12 THEN loadout.passive_tier_ids[3] END
    ]::text[],
    revision = loadout.revision + 1
FROM player_class_progress AS progress
WHERE loadout.player_id = progress.player_id
  AND loadout.class_id = 'warrior' AND progress.class_id = 'warrior';

ALTER TABLE combat_reward_settlements
  ADD COLUMN class_xp_policy_version smallint NOT NULL DEFAULT 0 CHECK (class_xp_policy_version >= 0),
  ADD COLUMN base_class_xp_pool integer NOT NULL DEFAULT 0 CHECK (base_class_xp_pool >= 0);

ALTER TABLE combat_reward_participants
  ADD COLUMN active_class_id text NULL CHECK (active_class_id IS NULL OR active_class_id IN ('warrior','hunter','paladin','cleric')),
  ADD COLUMN requested_class_xp integer NOT NULL DEFAULT 0 CHECK (requested_class_xp >= 0),
  ADD COLUMN class_xp_policy_version smallint NOT NULL DEFAULT 0 CHECK (class_xp_policy_version >= 0);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM player_class_progress AS progress
    WHERE progress.class_id = 'warrior'
      AND (progress.curve_version <> 3 OR progress.mastery_rank <> CASE
        WHEN progress.mastery_xp >= 72000 THEN 15 WHEN progress.mastery_xp >= 60068 THEN 14
        WHEN progress.mastery_xp >= 49946 THEN 13 WHEN progress.mastery_xp >= 41360 THEN 12
        WHEN progress.mastery_xp >= 34075 THEN 11 WHEN progress.mastery_xp >= 27895 THEN 10
        WHEN progress.mastery_xp >= 22652 THEN 9 WHEN progress.mastery_xp >= 18205 THEN 8
        WHEN progress.mastery_xp >= 14432 THEN 7 WHEN progress.mastery_xp >= 11231 THEN 6
        WHEN progress.mastery_xp >= 8515 THEN 5 WHEN progress.mastery_xp >= 6212 THEN 4
        WHEN progress.mastery_xp >= 4257 THEN 3 WHEN progress.mastery_xp >= 2600 THEN 2
        WHEN progress.mastery_xp >= 1193 THEN 1 ELSE 0 END)
  ) THEN RAISE EXCEPTION 'Warrior V3 migration produced a noncanonical rank/XP pair';
  END IF;
END
$$;

COMMENT ON COLUMN player_class_progress.curve_version IS
  'Durable discriminator for class-specific XP curve interpretation.';
COMMENT ON TABLE warrior_xp_curve_adjustments IS
  'Append-only audit ledger for deterministic Warrior XP curve migrations.';
