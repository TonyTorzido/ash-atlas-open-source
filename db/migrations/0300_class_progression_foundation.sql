CREATE TABLE IF NOT EXISTS player_class_profiles (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  active_class_id text NOT NULL DEFAULT 'warrior' CHECK (active_class_id IN ('warrior')),
  active_subclass_id text NULL CHECK (active_subclass_id IS NULL OR active_subclass_id IN ('reaver', 'warden')),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS player_class_progress (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  class_id text NOT NULL CHECK (class_id IN ('warrior')),
  unlocked boolean NOT NULL DEFAULT true,
  mastery_xp integer NOT NULL DEFAULT 0 CHECK (mastery_xp >= 0),
  mastery_rank integer NOT NULL DEFAULT 1 CHECK (mastery_rank BETWEEN 1 AND 25),
  training_points_earned integer NOT NULL DEFAULT 1 CHECK (training_points_earned >= 0),
  training_points_spent integer NOT NULL DEFAULT 0 CHECK (
    training_points_spent >= 0 AND training_points_spent <= training_points_earned
  ),
  completed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, class_id)
);

CREATE TABLE IF NOT EXISTS player_subclass_progress (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  class_id text NOT NULL CHECK (class_id IN ('warrior')),
  subclass_id text NOT NULL CHECK (subclass_id IN ('reaver', 'warden')),
  unlocked boolean NOT NULL DEFAULT false,
  mastery_xp integer NOT NULL DEFAULT 0 CHECK (mastery_xp >= 0),
  mastery_rank integer NOT NULL DEFAULT 1 CHECK (mastery_rank BETWEEN 1 AND 10),
  training_points_earned integer NOT NULL DEFAULT 1 CHECK (training_points_earned >= 0),
  training_points_spent integer NOT NULL DEFAULT 0 CHECK (
    training_points_spent >= 0 AND training_points_spent <= training_points_earned
  ),
  completed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, subclass_id),
  UNIQUE (player_id, class_id, subclass_id)
);

CREATE TABLE IF NOT EXISTS player_class_technique_unlocks (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  technique_id text NOT NULL,
  class_id text NOT NULL CHECK (class_id IN ('warrior')),
  subclass_id text NULL CHECK (subclass_id IS NULL OR subclass_id IN ('reaver', 'warden')),
  learned_at timestamptz NOT NULL DEFAULT now(),
  operation_key text NOT NULL UNIQUE,
  PRIMARY KEY (player_id, technique_id)
);

CREATE TABLE IF NOT EXISTS player_class_loadouts (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  class_id text NOT NULL CHECK (class_id IN ('warrior')),
  base_active_ids text[] NOT NULL DEFAULT ARRAY[NULL,NULL]::text[] CHECK (cardinality(base_active_ids) = 2),
  base_passive_ids text[] NOT NULL DEFAULT ARRAY[NULL,NULL,NULL]::text[] CHECK (cardinality(base_passive_ids) = 3),
  subclass_active_id text NULL,
  subclass_passive_ids text[] NOT NULL DEFAULT ARRAY[NULL,NULL]::text[] CHECK (cardinality(subclass_passive_ids) = 2),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, class_id)
);

CREATE TABLE IF NOT EXISTS player_subclass_loadouts (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  subclass_id text NOT NULL CHECK (subclass_id IN ('reaver', 'warden')),
  active_id text NULL,
  passive_ids text[] NOT NULL DEFAULT ARRAY[NULL,NULL]::text[] CHECK (cardinality(passive_ids) = 2),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, subclass_id)
);

CREATE TABLE IF NOT EXISTS player_class_legacy_unlocks (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  completed_class_id text NOT NULL CHECK (completed_class_id IN ('warrior')),
  legacy_id text NOT NULL CHECK (legacy_id IN ('warrior_legacy_iron_constitution')),
  display_name text NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, legacy_id),
  UNIQUE (player_id, completed_class_id)
);

CREATE TABLE IF NOT EXISTS player_class_runtime (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  rage integer NOT NULL DEFAULT 0 CHECK (rage BETWEEN 0 AND 100),
  rage_reserved integer NOT NULL DEFAULT 0 CHECK (rage_reserved BETWEEN 0 AND 100),
  queued_ability_id text NULL,
  queued_target_entity_id text NULL,
  queued_at_tick bigint NULL CHECK (queued_at_tick IS NULL OR queued_at_tick >= 0),
  cooldown_ends_at jsonb NOT NULL DEFAULT '{}'::jsonb,
  status_effects jsonb NOT NULL DEFAULT '[]'::jsonb,
  counters jsonb NOT NULL DEFAULT '{}'::jsonb,
  combat_generation bigint NOT NULL DEFAULT 0 CHECK (combat_generation >= 0),
  last_combat_at timestamptz NULL,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((queued_ability_id IS NULL) = (queued_target_entity_id IS NULL)),
  CHECK ((queued_ability_id IS NULL) = (queued_at_tick IS NULL)),
  CHECK (rage + rage_reserved <= 100)
);

CREATE TABLE IF NOT EXISTS class_operations (
  operation_key text PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('learn', 'loadout', 'switch_class', 'switch_subclass', 'unlock_subclass')),
  payload jsonb NOT NULL,
  result jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL
);

CREATE TABLE IF NOT EXISTS class_progression_operations (
  operation_key text PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  class_id text NOT NULL CHECK (class_id IN ('warrior')),
  subclass_id text NULL CHECK (subclass_id IS NULL OR subclass_id IN ('reaver', 'warden')),
  requested_xp integer NOT NULL CHECK (requested_xp >= 0),
  granted_xp integer NOT NULL CHECK (granted_xp >= 0),
  previous_rank integer NOT NULL CHECK (previous_rank >= 1),
  resulting_rank integer NOT NULL CHECK (resulting_rank >= previous_rank),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS player_class_techniques_player_idx
  ON player_class_technique_unlocks (player_id, class_id, subclass_id);
CREATE INDEX IF NOT EXISTS class_progression_operations_player_idx
  ON class_progression_operations (player_id, created_at DESC);

INSERT INTO player_class_profiles (player_id)
SELECT id FROM players ON CONFLICT (player_id) DO NOTHING;
INSERT INTO player_class_progress (player_id, class_id)
SELECT id, 'warrior' FROM players ON CONFLICT (player_id, class_id) DO NOTHING;
INSERT INTO player_subclass_progress (player_id, class_id, subclass_id)
SELECT id, 'warrior', subclass_id
FROM players CROSS JOIN (VALUES ('reaver'), ('warden')) AS subclasses(subclass_id)
ON CONFLICT (player_id, subclass_id) DO NOTHING;
INSERT INTO player_class_loadouts (player_id, class_id)
SELECT id, 'warrior' FROM players ON CONFLICT (player_id, class_id) DO NOTHING;
INSERT INTO player_subclass_loadouts (player_id, subclass_id)
SELECT id, subclass_id
FROM players CROSS JOIN (VALUES ('reaver'), ('warden')) AS subclasses(subclass_id)
ON CONFLICT (player_id, subclass_id) DO NOTHING;
INSERT INTO player_class_runtime (player_id)
SELECT id FROM players ON CONFLICT (player_id) DO NOTHING;

DROP TRIGGER IF EXISTS player_class_profiles_set_updated_at ON player_class_profiles;
CREATE TRIGGER player_class_profiles_set_updated_at BEFORE UPDATE ON player_class_profiles
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS player_class_progress_set_updated_at ON player_class_progress;
CREATE TRIGGER player_class_progress_set_updated_at BEFORE UPDATE ON player_class_progress
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS player_subclass_progress_set_updated_at ON player_subclass_progress;
CREATE TRIGGER player_subclass_progress_set_updated_at BEFORE UPDATE ON player_subclass_progress
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS player_class_loadouts_set_updated_at ON player_class_loadouts;
CREATE TRIGGER player_class_loadouts_set_updated_at BEFORE UPDATE ON player_class_loadouts
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS player_subclass_loadouts_set_updated_at ON player_subclass_loadouts;
CREATE TRIGGER player_subclass_loadouts_set_updated_at BEFORE UPDATE ON player_subclass_loadouts
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON COLUMN player_class_profiles.active_class_id IS
  'Authoritative class selection and future class switching extension point.';
COMMENT ON TABLE player_class_technique_unlocks IS
  'Static technique definitions and current learning requirements remain in typed source.';
