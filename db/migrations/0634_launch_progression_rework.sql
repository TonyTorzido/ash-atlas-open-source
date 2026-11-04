-- Launch progression: exact character curve, 15-rank Warrior, four durable professions.

UPDATE player_progression_profiles
SET total_xp = LEAST(500000, GREATEST(0, total_xp)),
    level = LEAST(25, FLOOR(SQRT(LEAST(500000, GREATEST(0, total_xp))::numeric / 800))::integer),
    curve_version = 2,
    persistence_version = persistence_version + 1;

ALTER TABLE player_class_progress
  DROP CONSTRAINT IF EXISTS player_class_progress_warrior_level_check,
  DROP CONSTRAINT IF EXISTS player_class_progress_mastery_rank_check;

UPDATE player_class_progress
SET mastery_xp = LEAST(200000, GREATEST(0, mastery_xp)),
    mastery_rank = CASE
      WHEN mastery_xp >= 200000 THEN 15 WHEN mastery_xp >= 174200 THEN 14
      WHEN mastery_xp >= 150200 THEN 13 WHEN mastery_xp >= 128000 THEN 12
      WHEN mastery_xp >= 107600 THEN 11 WHEN mastery_xp >= 88900 THEN 10
      WHEN mastery_xp >= 72000 THEN 9 WHEN mastery_xp >= 56900 THEN 8
      WHEN mastery_xp >= 43600 THEN 7 WHEN mastery_xp >= 32000 THEN 6
      WHEN mastery_xp >= 22200 THEN 5 WHEN mastery_xp >= 14200 THEN 4
      WHEN mastery_xp >= 8000 THEN 3 WHEN mastery_xp >= 3600 THEN 2
      WHEN mastery_xp >= 900 THEN 1 ELSE 0 END,
    completed_at = CASE WHEN mastery_xp >= 200000 THEN COALESCE(completed_at, now()) ELSE NULL END
WHERE class_id = 'warrior';

ALTER TABLE player_class_progress
  ADD CONSTRAINT player_class_progress_mastery_rank_launch_check
  CHECK (
    (class_id = 'warrior' AND mastery_rank BETWEEN 0 AND 15 AND mastery_xp BETWEEN 0 AND 200000)
    OR (class_id <> 'warrior' AND mastery_rank BETWEEN 0 AND 25 AND mastery_xp >= 0)
  );

UPDATE player_class_profiles
SET active_class_id = 'warrior', active_subclass_id = NULL, revision = revision + 1
WHERE active_class_id <> 'warrior' OR active_subclass_id IS NOT NULL;

UPDATE player_class_runtime
SET rage_reserved = 0, queued_ability_id = NULL, queued_target_entity_id = NULL,
    queued_at_tick = NULL, cooldown_ends_at = '{}'::jsonb, status_effects = '[]'::jsonb,
    counters = '{}'::jsonb, combat_generation = combat_generation + 1, revision = revision + 1
WHERE queued_ability_id IS NOT NULL OR rage_reserved <> 0;

CREATE TABLE IF NOT EXISTS player_profession_progress (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  profession_id text NOT NULL CHECK (profession_id IN ('woodcutter','miner','builder','hunter')),
  xp integer NOT NULL DEFAULT 0 CHECK (xp BETWEEN 0 AND 200000),
  rank smallint NOT NULL DEFAULT 0 CHECK (rank BETWEEN 0 AND 8),
  completed_at timestamptz NULL,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, profession_id)
);

CREATE TABLE IF NOT EXISTS mastery_progression_operations (
  operation_key text PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  profession_id text NOT NULL CHECK (profession_id IN ('woodcutter','miner','builder','hunter')),
  source_type text NOT NULL CHECK (source_type IN ('harvest','mining','construction','reinforcement','combat','development')),
  source_id text NULL,
  requested_xp integer NOT NULL CHECK (requested_xp >= 0),
  granted_xp integer NOT NULL CHECK (granted_xp >= 0),
  previous_xp integer NOT NULL CHECK (previous_xp BETWEEN 0 AND 200000),
  resulting_xp integer NOT NULL CHECK (resulting_xp BETWEEN 0 AND 200000),
  previous_rank smallint NOT NULL CHECK (previous_rank BETWEEN 0 AND 8),
  resulting_rank smallint NOT NULL CHECK (resulting_rank BETWEEN 0 AND 8),
  random_results jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (resulting_xp = previous_xp + granted_xp),
  CHECK (resulting_rank >= previous_rank)
);

CREATE TABLE IF NOT EXISTS player_mastery_achievements (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  achievement_id text NOT NULL CHECK (achievement_id IN (
    'master_warrior','master_woodcutter','master_miner','master_builder','master_hunter'
  )),
  title text NOT NULL,
  badge_id text NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, achievement_id)
);

CREATE TABLE IF NOT EXISTS player_mastery_state (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  equipped_title text NULL CHECK (equipped_title IS NULL OR equipped_title IN (
    'Master Warrior','Master Woodcutter','Master Miner','Master Builder','Master Hunter'
  )),
  last_woodcut_completed_at timestamptz NULL,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS player_discovered_mines (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  node_id uuid NOT NULL REFERENCES repeatable_resource_nodes(id) ON DELETE CASCADE,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, node_id)
);

ALTER TABLE repeatable_resource_nodes
  ADD COLUMN IF NOT EXISTS bonus_extraction_available boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS bonus_extraction_revision bigint NULL;

ALTER TABLE harvest_sessions
  ADD COLUMN IF NOT EXISTS mastery_results jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE repeatable_resource_sessions
  ADD COLUMN IF NOT EXISTS mastery_results jsonb NOT NULL DEFAULT '{}'::jsonb;

INSERT INTO player_profession_progress (player_id, profession_id)
SELECT player.id, profession.id
FROM players AS player
CROSS JOIN (VALUES ('woodcutter'),('miner'),('builder'),('hunter')) AS profession(id)
ON CONFLICT DO NOTHING;
INSERT INTO player_mastery_state (player_id)
SELECT id FROM players ON CONFLICT DO NOTHING;

INSERT INTO player_mastery_achievements (player_id, achievement_id, title, badge_id, completed_at)
SELECT player_id, 'master_warrior', 'Master Warrior', 'master_warrior', COALESCE(completed_at, now())
FROM player_class_progress WHERE class_id = 'warrior' AND mastery_rank = 15
ON CONFLICT DO NOTHING;

DROP TRIGGER IF EXISTS player_profession_progress_set_updated_at ON player_profession_progress;
CREATE TRIGGER player_profession_progress_set_updated_at BEFORE UPDATE ON player_profession_progress
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS player_mastery_state_set_updated_at ON player_mastery_state;
CREATE TRIGGER player_mastery_state_set_updated_at BEFORE UPDATE ON player_mastery_state
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
