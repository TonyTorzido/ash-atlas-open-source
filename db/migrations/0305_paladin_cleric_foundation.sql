-- Forward-only Paladin and Cleric foundation. Published migrations 0300-0304 remain immutable.

ALTER TABLE player_class_profiles
  DROP CONSTRAINT IF EXISTS player_class_profiles_active_class_id_check,
  DROP CONSTRAINT IF EXISTS player_class_profiles_active_subclass_id_check;
ALTER TABLE player_class_profiles
  ADD CONSTRAINT player_class_profiles_active_class_id_check
    CHECK (active_class_id IN ('warrior', 'hunter', 'paladin', 'cleric')),
  ADD CONSTRAINT player_class_profiles_active_subclass_id_check
    CHECK (active_subclass_id IS NULL OR active_subclass_id IN (
      'reaver', 'warden', 'sharpshooter', 'stalker',
      'justicar', 'vindicator', 'hierophant', 'exorcist'
    ));
ALTER TABLE player_class_profiles
  ALTER COLUMN selected_subclasses SET DEFAULT
    '{"warrior":null,"hunter":null,"paladin":null,"cleric":null}'::jsonb;
UPDATE player_class_profiles
SET selected_subclasses = selected_subclasses || jsonb_build_object(
  'paladin', COALESCE(selected_subclasses->'paladin', 'null'::jsonb),
  'cleric', COALESCE(selected_subclasses->'cleric', 'null'::jsonb)
)
WHERE NOT (selected_subclasses ? 'paladin') OR NOT (selected_subclasses ? 'cleric');

ALTER TABLE player_class_progress
  DROP CONSTRAINT IF EXISTS player_class_progress_class_id_check;
ALTER TABLE player_class_progress
  ADD CONSTRAINT player_class_progress_class_id_check
    CHECK (class_id IN ('warrior', 'hunter', 'paladin', 'cleric'));

ALTER TABLE player_subclass_progress
  DROP CONSTRAINT IF EXISTS player_subclass_progress_class_id_check,
  DROP CONSTRAINT IF EXISTS player_subclass_progress_subclass_id_check,
  DROP CONSTRAINT IF EXISTS player_subclass_progress_owner_check;
ALTER TABLE player_subclass_progress
  ADD CONSTRAINT player_subclass_progress_class_id_check
    CHECK (class_id IN ('warrior', 'hunter', 'paladin', 'cleric')),
  ADD CONSTRAINT player_subclass_progress_subclass_id_check
    CHECK (subclass_id IN (
      'reaver', 'warden', 'sharpshooter', 'stalker',
      'justicar', 'vindicator', 'hierophant', 'exorcist'
    )),
  ADD CONSTRAINT player_subclass_progress_owner_check CHECK (
    (class_id = 'warrior' AND subclass_id IN ('reaver', 'warden')) OR
    (class_id = 'hunter' AND subclass_id IN ('sharpshooter', 'stalker')) OR
    (class_id = 'paladin' AND subclass_id IN ('justicar', 'vindicator')) OR
    (class_id = 'cleric' AND subclass_id IN ('hierophant', 'exorcist'))
  );

ALTER TABLE player_class_technique_unlocks
  DROP CONSTRAINT IF EXISTS player_class_technique_unlocks_class_id_check,
  DROP CONSTRAINT IF EXISTS player_class_technique_unlocks_subclass_id_check;
ALTER TABLE player_class_technique_unlocks
  ADD CONSTRAINT player_class_technique_unlocks_class_id_check
    CHECK (class_id IN ('warrior', 'hunter', 'paladin', 'cleric')),
  ADD CONSTRAINT player_class_technique_unlocks_subclass_id_check
    CHECK (subclass_id IS NULL OR subclass_id IN (
      'reaver', 'warden', 'sharpshooter', 'stalker',
      'justicar', 'vindicator', 'hierophant', 'exorcist'
    ));

ALTER TABLE player_class_loadouts
  DROP CONSTRAINT IF EXISTS player_class_loadouts_class_id_check;
ALTER TABLE player_class_loadouts
  ADD CONSTRAINT player_class_loadouts_class_id_check
    CHECK (class_id IN ('warrior', 'hunter', 'paladin', 'cleric'));

ALTER TABLE player_subclass_loadouts
  DROP CONSTRAINT IF EXISTS player_subclass_loadouts_subclass_id_check;
ALTER TABLE player_subclass_loadouts
  ADD CONSTRAINT player_subclass_loadouts_subclass_id_check
    CHECK (subclass_id IN (
      'reaver', 'warden', 'sharpshooter', 'stalker',
      'justicar', 'vindicator', 'hierophant', 'exorcist'
    ));

ALTER TABLE class_progression_operations
  DROP CONSTRAINT IF EXISTS class_progression_operations_class_id_check,
  DROP CONSTRAINT IF EXISTS class_progression_operations_subclass_id_check;
ALTER TABLE class_progression_operations
  ADD CONSTRAINT class_progression_operations_class_id_check
    CHECK (class_id IN ('warrior', 'hunter', 'paladin', 'cleric')),
  ADD CONSTRAINT class_progression_operations_subclass_id_check
    CHECK (subclass_id IS NULL OR subclass_id IN (
      'reaver', 'warden', 'sharpshooter', 'stalker',
      'justicar', 'vindicator', 'hierophant', 'exorcist'
    ));

ALTER TABLE dev_progression_operations
  DROP CONSTRAINT IF EXISTS dev_progression_operations_progression_type_check;
ALTER TABLE dev_progression_operations
  ADD CONSTRAINT dev_progression_operations_progression_type_check CHECK (progression_type IN (
    'character_level', 'warrior_level', 'hunter_level', 'paladin_level', 'cleric_level',
    'warrior_mastery', 'reaver_mastery', 'warden_mastery'
  ));

ALTER TABLE player_class_resources
  DROP CONSTRAINT IF EXISTS player_class_resources_class_id_check,
  DROP CONSTRAINT IF EXISTS player_class_resources_resource_id_check,
  DROP CONSTRAINT IF EXISTS player_class_resources_owner_check,
  DROP CONSTRAINT IF EXISTS player_class_resources_check;
ALTER TABLE player_class_resources
  ADD CONSTRAINT player_class_resources_class_id_check
    CHECK (class_id IN ('warrior', 'hunter', 'paladin', 'cleric')),
  ADD CONSTRAINT player_class_resources_resource_id_check
    CHECK (resource_id IN ('rage', 'focus', 'conviction', 'faith')),
  ADD CONSTRAINT player_class_resources_owner_check CHECK (
    (class_id = 'warrior' AND resource_id = 'rage') OR
    (class_id = 'hunter' AND resource_id = 'focus') OR
    (class_id = 'paladin' AND resource_id = 'conviction') OR
    (class_id = 'cleric' AND resource_id = 'faith')
  );

ALTER TABLE player_class_legacy_unlocks
  DROP CONSTRAINT IF EXISTS player_class_legacy_unlocks_completed_class_id_check,
  DROP CONSTRAINT IF EXISTS player_class_legacy_unlocks_legacy_id_check;
ALTER TABLE player_class_legacy_unlocks
  ADD CONSTRAINT player_class_legacy_unlocks_completed_class_id_check
    CHECK (completed_class_id IN ('warrior', 'hunter', 'paladin', 'cleric')),
  ADD CONSTRAINT player_class_legacy_unlocks_legacy_id_check CHECK (legacy_id IN (
    'warrior_legacy_iron_constitution',
    'paladin_legacy_sacred_endurance',
    'cleric_legacy_lasting_grace'
  ));

INSERT INTO player_class_progress (
  player_id, class_id, mastery_xp, mastery_rank, training_points_earned, training_points_spent
)
SELECT players.id, classes.class_id, 0, 0, 0, 0
FROM players CROSS JOIN (VALUES ('paladin'), ('cleric')) AS classes(class_id)
ON CONFLICT (player_id, class_id) DO NOTHING;

INSERT INTO player_class_loadouts (player_id, class_id)
SELECT players.id, classes.class_id
FROM players CROSS JOIN (VALUES ('paladin'), ('cleric')) AS classes(class_id)
ON CONFLICT (player_id, class_id) DO NOTHING;

INSERT INTO player_subclass_progress (
  player_id, class_id, subclass_id, mastery_xp, mastery_rank,
  training_points_earned, training_points_spent
)
SELECT players.id, subclasses.class_id, subclasses.subclass_id, 0, 1, 0, 0
FROM players CROSS JOIN (VALUES
  ('paladin', 'justicar'),
  ('paladin', 'vindicator'),
  ('cleric', 'hierophant'),
  ('cleric', 'exorcist')
) AS subclasses(class_id, subclass_id)
ON CONFLICT (player_id, subclass_id) DO NOTHING;

INSERT INTO player_subclass_loadouts (player_id, subclass_id)
SELECT players.id, subclasses.subclass_id
FROM players CROSS JOIN (VALUES
  ('justicar'), ('vindicator'), ('hierophant'), ('exorcist')
) AS subclasses(subclass_id)
ON CONFLICT (player_id, subclass_id) DO NOTHING;

INSERT INTO player_class_resources (player_id, class_id, resource_id, current_value)
SELECT players.id, resources.class_id, resources.resource_id, resources.current_value
FROM players CROSS JOIN (VALUES
  ('paladin', 'conviction', 0),
  ('cleric', 'faith', 0)
) AS resources(class_id, resource_id, current_value)
ON CONFLICT (player_id, class_id) DO NOTHING;

INSERT INTO item_definitions (item_id, display_name, category, stackable, max_stack)
VALUES ('starter_staff', 'Starter Staff', 'equipment', false, 1)
ON CONFLICT (item_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  category = EXCLUDED.category,
  stackable = EXCLUDED.stackable,
  max_stack = EXCLUDED.max_stack,
  updated_at = now();

DROP INDEX IF EXISTS equipment_starter_definition_once_idx;
CREATE UNIQUE INDEX equipment_starter_definition_once_idx
  ON equipment_instances (owner_player_id, definition_id)
  WHERE definition_id IN ('starter_sword', 'starter_bow', 'starter_staff', 'padded_tunic')
    AND location <> 'destroyed';

INSERT INTO equipment_operations (operation_key, player_id, action, completed_at)
SELECT 'cleric-starter-staff:' || id || ':v1', id, 'starter_loadout', now()
FROM players ON CONFLICT (operation_key) DO NOTHING;

INSERT INTO equipment_instances (
  instance_id, definition_id, owner_player_id, location, equipped_slot, created_by_operation_key
)
SELECT gen_random_uuid(), 'starter_staff', players.id, 'inventory', NULL,
       'cleric-starter-staff:' || players.id || ':v1'
FROM players
WHERE NOT EXISTS (
  SELECT 1 FROM equipment_instances equipment
  WHERE equipment.owner_player_id = players.id
    AND equipment.definition_id = 'starter_staff'
    AND equipment.location <> 'destroyed'
)
ON CONFLICT DO NOTHING;

COMMENT ON COLUMN player_class_profiles.selected_subclasses IS
  'Per-class selected subclass for Warrior, Hunter, Paladin, and Cleric; active_subclass_id is the active-class projection.';
COMMENT ON TABLE player_class_legacy_unlocks IS
  'Permanent class-completion effects granted once; eligibility and behavior remain server authoritative.';
