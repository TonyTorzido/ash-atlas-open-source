-- Forward-only correction for retained databases that recorded 0305 before the
-- Cleric starter-staff backfill was appended. This is an idempotent no-op on
-- fresh databases where the final 0305 already created the staff.

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
