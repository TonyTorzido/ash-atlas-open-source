-- Complete launch class roster. Historical `hunter` class rows remain hidden
-- compatibility input; the Hunter profession tables are deliberately untouched.

LOCK TABLE player_class_progress IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE class_xp_curve_adjustments (
  operation_key text PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  class_id text NOT NULL CHECK (class_id IN ('druid','ranger','paladin','knight','cleric')),
  source_class_id text NOT NULL CHECK (source_class_id IN ('hunter','paladin','cleric')),
  from_curve_version smallint NOT NULL CHECK (from_curve_version = 1),
  to_curve_version smallint NOT NULL CHECK (to_curve_version = 3),
  previous_xp integer NOT NULL CHECK (previous_xp >= 0),
  resulting_xp integer NOT NULL CHECK (resulting_xp BETWEEN 0 AND 72000),
  previous_rank smallint NOT NULL CHECK (previous_rank BETWEEN 0 AND 25),
  resulting_rank smallint NOT NULL CHECK (resulting_rank BETWEEN 0 AND 15),
  source_max_xp integer NOT NULL CHECK (source_max_xp = 38000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (player_id, class_id, to_curve_version)
);

CREATE TABLE player_class_unlocks (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  class_id text NOT NULL CHECK (class_id IN ('warrior','druid','ranger','paladin','knight','cleric')),
  unlock_operation_key text NOT NULL,
  gold_paid bigint NOT NULL CHECK (
    (class_id = 'warrior' AND gold_paid = 0) OR
    (class_id <> 'warrior' AND gold_paid = 50000)
  ),
  unlocked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, class_id),
  UNIQUE (unlock_operation_key)
);

ALTER TABLE player_mastery_achievements DROP CONSTRAINT IF EXISTS player_mastery_achievements_achievement_id_check;
ALTER TABLE player_mastery_achievements ADD CONSTRAINT player_mastery_achievements_achievement_id_check CHECK (
  achievement_id IN (
    'master_warrior','master_druid','master_ranger','master_paladin','master_knight','master_cleric',
    'master_woodcutter','master_miner','master_builder','master_hunter','master_oil_worker'
  )
);
ALTER TABLE player_mastery_state DROP CONSTRAINT IF EXISTS player_mastery_state_equipped_title_check;
ALTER TABLE player_mastery_state ADD CONSTRAINT player_mastery_state_equipped_title_check CHECK (
  equipped_title IS NULL OR equipped_title IN (
    'Master Warrior','Master Druid','Master Ranger','Master Paladin','Master Knight','Master Cleric',
    'Master Woodcutter','Master Miner','Master Builder','Master Hunter','Master Oil Worker'
  )
);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM player_class_progress
    WHERE class_id IN ('paladin','cleric') AND curve_version NOT IN (1,3))
  THEN RAISE EXCEPTION 'Unsupported durable class curve version requires explicit reconciliation'; END IF;
END $$;

-- Permit the in-transaction projection before enforcing the final all-launch
-- v3 invariant. The prior 0733 check admits v3 only for Warrior.
ALTER TABLE player_class_progress DROP CONSTRAINT IF EXISTS player_class_progress_mastery_rank_v3_check;
ALTER TABLE player_class_progress ADD CONSTRAINT player_class_progress_launch_v1_transition_check CHECK (
  (class_id = 'warrior' AND curve_version = 3 AND mastery_rank BETWEEN 0 AND 15 AND mastery_xp BETWEEN 0 AND 72000)
  OR (class_id <> 'warrior' AND curve_version IN (1,3) AND mastery_rank BETWEEN 0 AND 25 AND mastery_xp >= 0)
);

ALTER TABLE player_class_profiles
  DROP CONSTRAINT IF EXISTS player_class_profiles_active_class_id_check;
ALTER TABLE player_class_profiles
  ADD CONSTRAINT player_class_profiles_active_class_id_check
    CHECK (active_class_id IN ('warrior','druid','ranger','paladin','knight','cleric','hunter')),
  ALTER COLUMN selected_subclasses SET DEFAULT
    '{"warrior":null,"druid":null,"ranger":null,"paladin":null,"knight":null,"cleric":null,"hunter":null}'::jsonb;
UPDATE player_class_profiles SET selected_subclasses = selected_subclasses ||
  '{"druid":null,"ranger":null,"knight":null}'::jsonb;

ALTER TABLE player_class_progress DROP CONSTRAINT IF EXISTS player_class_progress_class_id_check;
ALTER TABLE player_class_progress ADD CONSTRAINT player_class_progress_class_id_check
  CHECK (class_id IN ('warrior','druid','ranger','paladin','knight','cleric','hunter'));

ALTER TABLE player_class_loadouts DROP CONSTRAINT IF EXISTS player_class_loadouts_class_id_check;
ALTER TABLE player_class_loadouts ADD CONSTRAINT player_class_loadouts_class_id_check
  CHECK (class_id IN ('warrior','druid','ranger','paladin','knight','cleric','hunter'));

ALTER TABLE player_class_technique_unlocks DROP CONSTRAINT IF EXISTS player_class_technique_unlocks_class_id_check;
ALTER TABLE player_class_technique_unlocks ADD CONSTRAINT player_class_technique_unlocks_class_id_check
  CHECK (class_id IN ('warrior','druid','ranger','paladin','knight','cleric','hunter'));

ALTER TABLE class_progression_operations DROP CONSTRAINT IF EXISTS class_progression_operations_class_id_check;
ALTER TABLE class_progression_operations ADD CONSTRAINT class_progression_operations_class_id_check
  CHECK (class_id IN ('warrior','druid','ranger','paladin','knight','cleric','hunter'));

ALTER TABLE player_class_resources
  DROP CONSTRAINT IF EXISTS player_class_resources_class_id_check,
  DROP CONSTRAINT IF EXISTS player_class_resources_resource_id_check,
  DROP CONSTRAINT IF EXISTS player_class_resources_owner_check;
UPDATE player_class_resources SET resource_id = 'none', current_value = 0, reserved_value = 0
WHERE class_id IN ('warrior','paladin','cleric');
ALTER TABLE player_class_resources
  ADD CONSTRAINT player_class_resources_class_id_check
    CHECK (class_id IN ('warrior','druid','ranger','paladin','knight','cleric','hunter')),
  ADD CONSTRAINT player_class_resources_resource_id_check
    CHECK (resource_id IN ('none','rage','focus','conviction','faith')),
  ADD CONSTRAINT player_class_resources_owner_check CHECK (
    (class_id = 'hunter' AND resource_id = 'focus') OR
    (class_id IN ('warrior','druid','ranger','paladin','knight','cleric') AND resource_id = 'none')
  );

ALTER TABLE dev_progression_operations DROP CONSTRAINT IF EXISTS dev_progression_operations_progression_type_check;
ALTER TABLE dev_progression_operations ADD CONSTRAINT dev_progression_operations_progression_type_check CHECK (progression_type IN (
  'character_level','warrior_level','druid_level','ranger_level','hunter_level','paladin_level','knight_level','cleric_level',
  'woodcutter_level','miner_level','builder_level','hunter_profession_level','oil_worker_level',
  'warrior_mastery','reaver_mastery','warden_mastery'
));

ALTER TABLE combat_reward_participants DROP CONSTRAINT IF EXISTS combat_reward_participants_active_class_id_check;
ALTER TABLE combat_reward_participants ADD CONSTRAINT combat_reward_participants_active_class_id_check
  CHECK (active_class_id IS NULL OR active_class_id IN ('warrior','druid','ranger','paladin','knight','cleric','hunter'));

-- Project only rows durably marked as the deployed legacy v1 curve. The known
-- v1 maximum was 38,000; no decision is inferred from the row's XP value.
CREATE TEMP TABLE launch_class_projection ON COMMIT DROP AS
WITH sources AS (
  SELECT player_id,
         CASE class_id WHEN 'hunter' THEN 'ranger' ELSE class_id END AS class_id,
         class_id AS source_class_id,
         mastery_xp AS previous_xp, mastery_rank AS previous_rank,
         completed_at IS NOT NULL AS mastered
  FROM player_class_progress
  WHERE class_id IN ('hunter','paladin','cleric') AND curve_version = 1
), mapped AS (
  SELECT *, CASE WHEN mastered OR previous_xp >= 38000 THEN 72000
                 ELSE ROUND(LEAST(38000, previous_xp)::numeric * 72000 / 38000)::integer END AS resulting_xp
  FROM sources
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

INSERT INTO class_xp_curve_adjustments (
  operation_key, player_id, class_id, source_class_id, from_curve_version, to_curve_version,
  previous_xp, resulting_xp, previous_rank, resulting_rank, source_max_xp
)
SELECT 'launch-class-curve:v1-to-v3:' || class_id || ':' || player_id,
       player_id, class_id, source_class_id, 1, 3, previous_xp, resulting_xp,
       previous_rank, resulting_rank, 38000
FROM launch_class_projection ON CONFLICT DO NOTHING;

INSERT INTO player_class_progress (
  player_id, class_id, mastery_xp, mastery_rank, curve_version,
  training_points_earned, training_points_spent, completed_at
)
SELECT player_id, class_id, resulting_xp, resulting_rank, 3, 0, 0,
       CASE WHEN resulting_rank = 15 THEN now() ELSE NULL END
FROM launch_class_projection
ON CONFLICT (player_id, class_id) DO UPDATE SET
  mastery_xp = EXCLUDED.mastery_xp, mastery_rank = EXCLUDED.mastery_rank,
  curve_version = 3, training_points_earned = 0, training_points_spent = 0,
  completed_at = EXCLUDED.completed_at, updated_at = now();

INSERT INTO player_class_progress (
  player_id, class_id, mastery_xp, mastery_rank, curve_version,
  training_points_earned, training_points_spent
)
SELECT players.id, class_id, 0, 0, 3, 0, 0
FROM players CROSS JOIN (VALUES ('druid'),('ranger'),('paladin'),('knight'),('cleric')) AS launch(class_id)
ON CONFLICT (player_id, class_id) DO NOTHING;

ALTER TABLE player_class_progress DROP CONSTRAINT IF EXISTS player_class_progress_launch_v1_transition_check;
ALTER TABLE player_class_progress ADD CONSTRAINT player_class_progress_mastery_rank_v3_check CHECK (
  (class_id IN ('warrior','druid','ranger','paladin','knight','cleric') AND curve_version = 3
    AND mastery_rank BETWEEN 0 AND 15 AND mastery_xp BETWEEN 0 AND 72000)
  OR (class_id = 'hunter' AND curve_version = 1 AND mastery_rank BETWEEN 0 AND 25 AND mastery_xp >= 0)
);
ALTER TABLE player_class_progress ALTER COLUMN curve_version SET DEFAULT 3;

INSERT INTO player_class_loadouts (player_id, class_id)
SELECT players.id, class_id
FROM players CROSS JOIN (VALUES ('druid'),('ranger'),('knight')) AS launch(class_id)
ON CONFLICT DO NOTHING;
INSERT INTO player_class_resources (player_id, class_id, resource_id, current_value)
SELECT players.id, class_id, 'none', 0
FROM players CROSS JOIN (VALUES ('druid'),('ranger'),('knight')) AS launch(class_id)
ON CONFLICT DO NOTHING;
-- Historical loadout IDs are not executable launch IDs. Start with the first
-- active when earned; retain all independent XP and audit records.
UPDATE player_class_loadouts AS loadout SET
  reset_active_ids = ARRAY[NULL,NULL]::text[],
  normal_active_ids = ARRAY[
    CASE WHEN progress.mastery_rank >= 1 THEN progress.class_id || '_' || CASE progress.class_id
      WHEN 'druid' THEN 'nature_bolt' WHEN 'ranger' THEN 'power_shot' WHEN 'paladin' THEN 'smite'
      WHEN 'knight' THEN 'heavy_slash' WHEN 'cleric' THEN 'holy_bolt' END END,
    NULL
  ]::text[],
  passive_tier_ids = ARRAY[NULL,NULL,NULL]::text[], revision = revision + 1
FROM player_class_progress AS progress
WHERE loadout.player_id = progress.player_id AND loadout.class_id = progress.class_id
  AND progress.class_id IN ('druid','ranger','paladin','knight','cleric');

INSERT INTO player_class_unlocks (player_id, class_id, unlock_operation_key, gold_paid)
SELECT id, 'warrior', 'launch-default-warrior:' || id, 0 FROM players ON CONFLICT DO NOTHING;
UPDATE player_class_profiles AS profile SET active_class_id = 'warrior', active_subclass_id = NULL, revision = revision + 1
WHERE profile.active_class_id <> 'warrior' AND NOT EXISTS (
  SELECT 1 FROM player_class_unlocks unlock
  WHERE unlock.player_id = profile.player_id AND unlock.class_id = profile.active_class_id
);

INSERT INTO player_mastery_achievements (player_id, achievement_id, title, badge_id, completed_at)
SELECT player_id, 'master_' || class_id, 'Master ' || initcap(class_id), 'master_' || class_id,
       COALESCE(completed_at, now())
FROM player_class_progress
WHERE class_id IN ('druid','ranger','paladin','knight','cleric') AND mastery_rank = 15
ON CONFLICT (player_id, achievement_id) DO NOTHING;

INSERT INTO item_definitions (
  item_id, display_name, category, stackable, max_stack, droppable, manor_storable,
  market_tradable, market_fungible, market_identity, supported_variants
) VALUES
  ('hammer','Hammer','equipment',false,1,false,true,false,false,NULL,ARRAY['default']::text[]),
  ('leather_armor','Leather Armor','equipment',false,1,false,true,false,false,NULL,ARRAY['default']::text[])
ON CONFLICT (item_id) DO UPDATE SET display_name = EXCLUDED.display_name,
  category = EXCLUDED.category, stackable = EXCLUDED.stackable, max_stack = EXCLUDED.max_stack,
  droppable = EXCLUDED.droppable, manor_storable = EXCLUDED.manor_storable,
  market_tradable = EXCLUDED.market_tradable, market_fungible = EXCLUDED.market_fungible,
  market_identity = EXCLUDED.market_identity, supported_variants = EXCLUDED.supported_variants,
  updated_at = now();

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM player_class_progress WHERE class_id IN ('warrior','druid','ranger','paladin','knight','cleric')
    AND (curve_version <> 3 OR mastery_rank <> CASE
      WHEN mastery_xp >= 72000 THEN 15 WHEN mastery_xp >= 60068 THEN 14 WHEN mastery_xp >= 49946 THEN 13
      WHEN mastery_xp >= 41360 THEN 12 WHEN mastery_xp >= 34075 THEN 11 WHEN mastery_xp >= 27895 THEN 10
      WHEN mastery_xp >= 22652 THEN 9 WHEN mastery_xp >= 18205 THEN 8 WHEN mastery_xp >= 14432 THEN 7
      WHEN mastery_xp >= 11231 THEN 6 WHEN mastery_xp >= 8515 THEN 5 WHEN mastery_xp >= 6212 THEN 4
      WHEN mastery_xp >= 4257 THEN 3 WHEN mastery_xp >= 2600 THEN 2 WHEN mastery_xp >= 1193 THEN 1 ELSE 0 END))
  THEN RAISE EXCEPTION 'Launch class migration produced a noncanonical rank/XP pair'; END IF;
END $$;

COMMENT ON TABLE player_class_unlocks IS 'Permanent authoritative launch-class entitlements; Warrior is free and all other launch classes cost exactly 50,000 Gold.';
COMMENT ON TABLE class_xp_curve_adjustments IS 'Append-only deterministic v1-to-v3 class XP projections; source selection uses durable curve_version, never XP ranges.';
