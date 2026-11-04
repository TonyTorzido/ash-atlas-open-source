-- Forward-only Hunter and multi-class foundation. Published migrations 0300-0303 remain immutable.

ALTER TABLE player_class_profiles
  DROP CONSTRAINT IF EXISTS player_class_profiles_active_class_id_check,
  DROP CONSTRAINT IF EXISTS player_class_profiles_active_subclass_id_check;
ALTER TABLE player_class_profiles
  ADD CONSTRAINT player_class_profiles_active_class_id_check
    CHECK (active_class_id IN ('warrior', 'hunter')),
  ADD CONSTRAINT player_class_profiles_active_subclass_id_check
    CHECK (active_subclass_id IS NULL OR active_subclass_id IN ('reaver', 'warden', 'sharpshooter', 'stalker')),
  ADD COLUMN IF NOT EXISTS selected_subclasses jsonb NOT NULL
    DEFAULT '{"warrior":null,"hunter":null}'::jsonb;

UPDATE player_class_profiles
SET selected_subclasses = jsonb_build_object(
  'warrior', CASE WHEN active_subclass_id IN ('reaver', 'warden') THEN active_subclass_id ELSE NULL END,
  'hunter', CASE WHEN active_subclass_id IN ('sharpshooter', 'stalker') THEN active_subclass_id ELSE NULL END
)
WHERE selected_subclasses = '{"warrior":null,"hunter":null}'::jsonb;

ALTER TABLE player_class_progress
  DROP CONSTRAINT IF EXISTS player_class_progress_class_id_check;
ALTER TABLE player_class_progress
  ADD CONSTRAINT player_class_progress_class_id_check CHECK (class_id IN ('warrior', 'hunter'));

ALTER TABLE player_subclass_progress
  DROP CONSTRAINT IF EXISTS player_subclass_progress_class_id_check,
  DROP CONSTRAINT IF EXISTS player_subclass_progress_subclass_id_check,
  DROP CONSTRAINT IF EXISTS player_subclass_progress_owner_check;
ALTER TABLE player_subclass_progress
  ADD CONSTRAINT player_subclass_progress_class_id_check CHECK (class_id IN ('warrior', 'hunter')),
  ADD CONSTRAINT player_subclass_progress_subclass_id_check
    CHECK (subclass_id IN ('reaver', 'warden', 'sharpshooter', 'stalker')),
  ADD CONSTRAINT player_subclass_progress_owner_check CHECK (
    (class_id = 'warrior' AND subclass_id IN ('reaver', 'warden')) OR
    (class_id = 'hunter' AND subclass_id IN ('sharpshooter', 'stalker'))
  );

ALTER TABLE player_class_technique_unlocks
  DROP CONSTRAINT IF EXISTS player_class_technique_unlocks_class_id_check,
  DROP CONSTRAINT IF EXISTS player_class_technique_unlocks_subclass_id_check;
ALTER TABLE player_class_technique_unlocks
  ADD CONSTRAINT player_class_technique_unlocks_class_id_check CHECK (class_id IN ('warrior', 'hunter')),
  ADD CONSTRAINT player_class_technique_unlocks_subclass_id_check
    CHECK (subclass_id IS NULL OR subclass_id IN ('reaver', 'warden', 'sharpshooter', 'stalker'));

ALTER TABLE player_class_loadouts
  DROP CONSTRAINT IF EXISTS player_class_loadouts_class_id_check;
ALTER TABLE player_class_loadouts
  ADD CONSTRAINT player_class_loadouts_class_id_check CHECK (class_id IN ('warrior', 'hunter'));

ALTER TABLE player_subclass_loadouts
  DROP CONSTRAINT IF EXISTS player_subclass_loadouts_subclass_id_check;
ALTER TABLE player_subclass_loadouts
  ADD CONSTRAINT player_subclass_loadouts_subclass_id_check
    CHECK (subclass_id IN ('reaver', 'warden', 'sharpshooter', 'stalker'));

ALTER TABLE class_progression_operations
  DROP CONSTRAINT IF EXISTS class_progression_operations_class_id_check,
  DROP CONSTRAINT IF EXISTS class_progression_operations_subclass_id_check;
ALTER TABLE class_progression_operations
  ADD CONSTRAINT class_progression_operations_class_id_check CHECK (class_id IN ('warrior', 'hunter')),
  ADD CONSTRAINT class_progression_operations_subclass_id_check
    CHECK (subclass_id IS NULL OR subclass_id IN ('reaver', 'warden', 'sharpshooter', 'stalker'));

ALTER TABLE dev_progression_operations
  DROP CONSTRAINT IF EXISTS dev_progression_operations_progression_type_check;
ALTER TABLE dev_progression_operations
  ADD CONSTRAINT dev_progression_operations_progression_type_check CHECK (progression_type IN (
    'character_level', 'warrior_level', 'hunter_level', 'warrior_mastery',
    'reaver_mastery', 'warden_mastery'
  ));

INSERT INTO player_class_progress (
  player_id, class_id, mastery_xp, mastery_rank, training_points_earned, training_points_spent
)
SELECT id, 'hunter', 0, 0, 0, 0 FROM players
ON CONFLICT (player_id, class_id) DO NOTHING;

INSERT INTO player_class_loadouts (player_id, class_id)
SELECT id, 'hunter' FROM players
ON CONFLICT (player_id, class_id) DO NOTHING;

INSERT INTO player_subclass_progress (
  player_id, class_id, subclass_id, mastery_xp, mastery_rank,
  training_points_earned, training_points_spent
)
SELECT players.id, 'hunter', subclasses.subclass_id, 0, 1, 0, 0
FROM players CROSS JOIN (VALUES ('sharpshooter'), ('stalker')) AS subclasses(subclass_id)
ON CONFLICT (player_id, subclass_id) DO NOTHING;

INSERT INTO player_subclass_loadouts (player_id, subclass_id)
SELECT players.id, subclasses.subclass_id
FROM players CROSS JOIN (VALUES ('sharpshooter'), ('stalker')) AS subclasses(subclass_id)
ON CONFLICT (player_id, subclass_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS player_class_resources (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  class_id text NOT NULL CHECK (class_id IN ('warrior', 'hunter')),
  resource_id text NOT NULL CHECK (resource_id IN ('rage', 'focus')),
  current_value integer NOT NULL CHECK (current_value BETWEEN 0 AND 100),
  reserved_value integer NOT NULL DEFAULT 0 CHECK (reserved_value BETWEEN 0 AND 100),
  cooldown_ends_at jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_combat_at timestamptz NULL,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, class_id),
  CHECK ((class_id = 'warrior' AND resource_id = 'rage') OR (class_id = 'hunter' AND resource_id = 'focus')),
  CHECK (current_value + reserved_value <= 100)
);

INSERT INTO player_class_resources (
  player_id, class_id, resource_id, current_value, reserved_value, cooldown_ends_at, last_combat_at
)
SELECT player_id, 'warrior', 'rage', rage, rage_reserved, cooldown_ends_at, last_combat_at
FROM player_class_runtime
ON CONFLICT (player_id, class_id) DO NOTHING;

INSERT INTO player_class_resources (player_id, class_id, resource_id, current_value)
SELECT id, 'hunter', 'focus', 100 FROM players
ON CONFLICT (player_id, class_id) DO NOTHING;

DROP TRIGGER IF EXISTS player_class_resources_set_updated_at ON player_class_resources;
CREATE TRIGGER player_class_resources_set_updated_at BEFORE UPDATE ON player_class_resources
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO item_definitions (item_id, display_name, category, stackable, max_stack)
VALUES ('starter_bow', 'Starter Bow', 'equipment', false, 1)
ON CONFLICT (item_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  category = EXCLUDED.category,
  stackable = EXCLUDED.stackable,
  max_stack = EXCLUDED.max_stack,
  updated_at = now();

DROP INDEX IF EXISTS equipment_starter_definition_once_idx;
CREATE UNIQUE INDEX equipment_starter_definition_once_idx
  ON equipment_instances (owner_player_id, definition_id)
  WHERE definition_id IN ('starter_sword', 'starter_bow', 'padded_tunic') AND location <> 'destroyed';

INSERT INTO equipment_operations (operation_key, player_id, action, completed_at)
SELECT 'hunter-starter-bow:' || id || ':v1', id, 'starter_loadout', now()
FROM players ON CONFLICT (operation_key) DO NOTHING;

INSERT INTO equipment_instances (
  instance_id, definition_id, owner_player_id, location, equipped_slot, created_by_operation_key
)
SELECT gen_random_uuid(), 'starter_bow', players.id, 'inventory', NULL,
       'hunter-starter-bow:' || players.id || ':v1'
FROM players
WHERE NOT EXISTS (
  SELECT 1 FROM equipment_instances equipment
  WHERE equipment.owner_player_id = players.id
    AND equipment.definition_id = 'starter_bow'
    AND equipment.location <> 'destroyed'
)
ON CONFLICT DO NOTHING;

ALTER TABLE combat_balance_summaries
  DROP CONSTRAINT IF EXISTS combat_balance_summaries_schema_version_check,
  DROP CONSTRAINT IF EXISTS combat_balance_summaries_active_class_level_check;
ALTER TABLE combat_balance_summaries
  ADD CONSTRAINT combat_balance_summaries_schema_version_check CHECK (schema_version IN (1, 2)),
  ADD COLUMN IF NOT EXISTS active_class_level smallint;
UPDATE combat_balance_summaries
SET active_class_level = warrior_level
WHERE active_class_level IS NULL;
ALTER TABLE combat_balance_summaries
  ALTER COLUMN active_class_level SET NOT NULL,
  ADD CONSTRAINT combat_balance_summaries_active_class_level_check
    CHECK (active_class_level BETWEEN 0 AND 25);

COMMENT ON TABLE player_class_resources IS
  'Independent authoritative primary resource and cooldown state for each player class.';
COMMENT ON COLUMN player_class_profiles.selected_subclasses IS
  'Per-class selected subclass; active_subclass_id is the active class compatibility projection.';
