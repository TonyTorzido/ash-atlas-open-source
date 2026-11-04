-- Forward-only reconciliation from the original mastery/learning tree to the
-- automatically unlocked Warrior Level 0-25 model. Migrations 0300 and 0301
-- intentionally remain immutable.

ALTER TABLE player_class_progress
  DROP CONSTRAINT IF EXISTS player_class_progress_mastery_rank_check;
ALTER TABLE player_class_progress
  ALTER COLUMN mastery_rank SET DEFAULT 0;
ALTER TABLE player_class_progress
  ADD CONSTRAINT player_class_progress_warrior_level_check
  CHECK (mastery_rank BETWEEN 0 AND 25);

ALTER TABLE class_progression_operations
  DROP CONSTRAINT IF EXISTS class_progression_operations_previous_rank_check;
ALTER TABLE class_progression_operations
  ADD CONSTRAINT class_progression_operations_previous_level_check
  CHECK (previous_rank >= 0);

-- Preserve every existing Warrior level while reconciling its XP to the exact
-- minimum for that retained level. Future rows use Level 0 / XP 0 defaults.
UPDATE player_class_progress AS progress
SET mastery_xp = thresholds.minimum_xp
FROM (VALUES
  (0, 0), (1, 100), (2, 300), (3, 700), (4, 1200), (5, 1800),
  (6, 2500), (7, 3300), (8, 4200), (9, 5200), (10, 6300),
  (11, 7500), (12, 8800), (13, 10200), (14, 11700), (15, 13300),
  (16, 15000), (17, 16800), (18, 18700), (19, 20700), (20, 22800),
  (21, 25000), (22, 27500), (23, 30500), (24, 34000), (25, 38000)
) AS thresholds(warrior_level, minimum_xp)
WHERE progress.class_id = 'warrior'
  AND progress.mastery_rank = thresholds.warrior_level;

CREATE TABLE IF NOT EXISTS archived_class_technique_unlocks (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  technique_id text NOT NULL,
  class_id text NOT NULL,
  subclass_id text NULL,
  learned_at timestamptz NOT NULL,
  operation_key text NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now(),
  archive_reason text NOT NULL DEFAULT '0302_simplified_warrior',
  PRIMARY KEY (player_id, technique_id)
);

INSERT INTO archived_class_technique_unlocks (
  player_id, technique_id, class_id, subclass_id, learned_at, operation_key
)
SELECT player_id, technique_id, class_id, subclass_id, learned_at, operation_key
FROM player_class_technique_unlocks
ON CONFLICT (player_id, technique_id) DO NOTHING;

DELETE FROM player_class_technique_unlocks;

-- A pre-0302 reconnect may contain a reserved obsolete ability, its target,
-- old cooldown/status identifiers, or counters for retired technique trees.
-- Preserve earned Rage, but invalidate every transient action generation so no
-- removed technique can resolve or keep a simplified mutation locked.
UPDATE player_class_runtime
SET rage_reserved = 0,
    queued_ability_id = NULL,
    queued_target_entity_id = NULL,
    queued_at_tick = NULL,
    cooldown_ends_at = '{}'::jsonb,
    status_effects = '[]'::jsonb,
    counters = '{}'::jsonb,
    combat_generation = combat_generation + 1,
    last_combat_at = NULL,
    revision = revision + 1,
    updated_at = now();

-- Training Point columns remain as dormant generic-framework extension points,
-- but the simplified Warrior never earns or spends them.
UPDATE player_class_progress
SET training_points_spent = 0, training_points_earned = 0;
UPDATE player_subclass_progress
SET training_points_spent = 0, training_points_earned = 0;
ALTER TABLE player_class_progress
  ALTER COLUMN training_points_earned SET DEFAULT 0,
  ALTER COLUMN training_points_spent SET DEFAULT 0;
ALTER TABLE player_subclass_progress
  ALTER COLUMN training_points_earned SET DEFAULT 0,
  ALTER COLUMN training_points_spent SET DEFAULT 0;

ALTER TABLE player_class_loadouts
  ADD COLUMN IF NOT EXISTS reset_active_ids text[] NOT NULL
    DEFAULT ARRAY[NULL,NULL]::text[] CHECK (cardinality(reset_active_ids) = 2),
  ADD COLUMN IF NOT EXISTS normal_active_ids text[] NOT NULL
    DEFAULT ARRAY[NULL,NULL]::text[] CHECK (cardinality(normal_active_ids) = 2),
  ADD COLUMN IF NOT EXISTS passive_tier_ids text[] NOT NULL
    DEFAULT ARRAY[NULL,NULL,NULL]::text[] CHECK (cardinality(passive_tier_ids) = 3);

ALTER TABLE player_subclass_loadouts
  ADD COLUMN IF NOT EXISTS reset_id text NULL,
  ADD COLUMN IF NOT EXISTS reset_slot_index smallint NULL
    CHECK (reset_slot_index IS NULL OR reset_slot_index BETWEEN 0 AND 1),
  ADD CONSTRAINT player_subclass_loadouts_reset_pair_check
    CHECK ((reset_id IS NULL) = (reset_slot_index IS NULL));

-- Cleave and Fortify are the only equivalent old techniques. Preserve their
-- selection deterministically in fixed normal slots when the retained level
-- supports them. No old active is incorrectly promoted into a reset slot.
UPDATE player_class_loadouts AS loadout
SET normal_active_ids = ARRAY[
      CASE
        WHEN progress.mastery_rank >= 8
          AND array_position(loadout.base_active_ids, 'warrior_cleave') IS NOT NULL
        THEN 'warrior_cleave' ELSE NULL
      END,
      CASE
        WHEN progress.mastery_rank >= 16
          AND array_position(loadout.base_active_ids, 'warrior_fortify') IS NOT NULL
        THEN 'warrior_fortify' ELSE NULL
      END
    ]::text[],
    reset_active_ids = ARRAY[NULL,NULL]::text[],
    passive_tier_ids = ARRAY[NULL,NULL,NULL]::text[],
    base_active_ids = ARRAY[NULL,NULL]::text[],
    base_passive_ids = ARRAY[NULL,NULL,NULL]::text[],
    subclass_active_id = NULL,
    subclass_passive_ids = ARRAY[NULL,NULL]::text[],
    revision = revision + 1
FROM player_class_progress AS progress
WHERE progress.player_id = loadout.player_id
  AND progress.class_id = loadout.class_id
  AND loadout.class_id = 'warrior';

UPDATE player_subclass_loadouts
SET active_id = NULL,
    passive_ids = ARRAY[NULL,NULL]::text[],
    reset_id = NULL,
    reset_slot_index = NULL,
    revision = revision + 1;

-- Historical operation rows remain valid. New clients use warrior_level;
-- historical subtype values remain accepted only so their ledgers are intact.
ALTER TABLE dev_progression_operations
  DROP CONSTRAINT IF EXISTS dev_progression_operations_progression_type_check;
ALTER TABLE dev_progression_operations
  ADD CONSTRAINT dev_progression_operations_progression_type_check
  CHECK (progression_type IN (
    'character_level', 'warrior_level', 'warrior_mastery',
    'reaver_mastery', 'warden_mastery'
  ));

COMMENT ON TABLE archived_class_technique_unlocks IS
  'Immutable audit of learned techniques retired by the automatic-unlock Warrior Level model.';
COMMENT ON COLUMN player_class_progress.mastery_rank IS
  'Warrior Level 0-25; historical column name retained for forward schema compatibility.';
