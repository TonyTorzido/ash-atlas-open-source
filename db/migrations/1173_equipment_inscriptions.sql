-- Inscribed equipment: a unique player-chosen name plus per-item counters that travel with the item.
ALTER TABLE equipment_instances
  ADD COLUMN IF NOT EXISTS inscription_name text NULL,
  ADD COLUMN IF NOT EXISTS inscribed_by_name text NULL,
  ADD COLUMN IF NOT EXISTS inscribed_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS inscription_stats jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS equipment_instances_inscription_name_uniq
  ON equipment_instances (lower(inscription_name))
  WHERE inscription_name IS NOT NULL;

ALTER TABLE equipment_operations
  DROP CONSTRAINT IF EXISTS equipment_operations_action_check;
ALTER TABLE equipment_operations
  ADD CONSTRAINT equipment_operations_action_check CHECK (
    action IN (
      'starter_loadout', 'equip', 'unequip', 'package_grant',
      'ground_drop', 'ground_pickup', 'ground_expire', 'prepare', 'imbue',
      'craft', 'limited_purchase', 'manor_storage_recovery', 'reforge', 'inscribe'
    )
  );
