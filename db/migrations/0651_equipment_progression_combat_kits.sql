-- Equipment progression and six saved combat kits. This is an additive,
-- forward-only migration: retained instances are never deleted and every
-- instance that predates durable levels begins at level 0.

LOCK TABLE equipment_instances, equipment_operations, player_combat_profiles
  IN ACCESS EXCLUSIVE MODE;

-- These definitions make a complete seven-slot level-0 kit representable for
-- persistence and validation. They are catalog entries only: this migration
-- does not grant them to any player.
INSERT INTO item_definitions (
  item_id, display_name, category, stackable, max_stack,
  market_tradable, market_fungible, market_identity, supported_variants
)
VALUES
  ('training_axe', 'Training Axe', 'equipment', false, 1, false, false, NULL, ARRAY['default']::text[]),
  ('training_heavy_helm', 'Training Heavy Helm', 'equipment', false, 1, false, false, NULL, ARRAY['default']::text[]),
  ('training_heavy_chest', 'Training Heavy Chest', 'equipment', false, 1, false, false, NULL, ARRAY['default']::text[]),
  ('training_heavy_gloves', 'Training Heavy Gloves', 'equipment', false, 1, false, false, NULL, ARRAY['default']::text[]),
  ('training_heavy_boots', 'Training Heavy Boots', 'equipment', false, 1, false, false, NULL, ARRAY['default']::text[]),
  ('training_light_hood', 'Training Light Hood', 'equipment', false, 1, false, false, NULL, ARRAY['default']::text[]),
  ('training_light_gloves', 'Training Light Gloves', 'equipment', false, 1, false, false, NULL, ARRAY['default']::text[]),
  ('training_light_boots', 'Training Light Boots', 'equipment', false, 1, false, false, NULL, ARRAY['default']::text[]),
  ('training_ring', 'Training Ring', 'equipment', false, 1, false, false, NULL, ARRAY['default']::text[]),
  ('training_shield', 'Training Shield', 'equipment', false, 1, false, false, NULL, ARRAY['default']::text[])
ON CONFLICT (item_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  category = EXCLUDED.category,
  stackable = EXCLUDED.stackable,
  max_stack = EXCLUDED.max_stack,
  market_tradable = EXCLUDED.market_tradable,
  market_fungible = EXCLUDED.market_fungible,
  market_identity = EXCLUDED.market_identity,
  supported_variants = EXCLUDED.supported_variants,
  updated_at = now();

ALTER TABLE equipment_instances
  ADD COLUMN IF NOT EXISTS item_level smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS balance_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS enchantment_identity text NULL;

ALTER TABLE equipment_instances
  DROP CONSTRAINT IF EXISTS equipment_instances_item_level_check,
  DROP CONSTRAINT IF EXISTS equipment_instances_balance_version_check,
  DROP CONSTRAINT IF EXISTS equipment_instances_enchantment_identity_check,
  DROP CONSTRAINT IF EXISTS equipment_instances_equipped_slot_check;

ALTER TABLE equipment_instances
  ADD CONSTRAINT equipment_instances_item_level_check
    CHECK (item_level BETWEEN 0 AND 25),
  ADD CONSTRAINT equipment_instances_balance_version_check
    CHECK (balance_version > 0),
  ADD CONSTRAINT equipment_instances_enchantment_identity_check
    CHECK (
      enchantment_identity IS NULL
      OR length(enchantment_identity) BETWEEN 1 AND 160
    ),
  ADD CONSTRAINT equipment_instances_equipped_slot_check
    CHECK (
      equipped_slot IS NULL
      OR equipped_slot IN ('head', 'chest', 'gloves', 'boots', 'ring', 'melee', 'secondary')
    ) NOT VALID;

-- The legacy schema allowed exactly one active "weapon". Known launch
-- definitions map deterministically; any unknown retained definition remains
-- owned in inventory instead of being guessed into a new slot.
UPDATE equipment_instances
SET equipped_slot = CASE
      WHEN definition_id = 'starter_sword' THEN 'melee'
      WHEN definition_id IN ('starter_bow', 'starter_staff') THEN 'secondary'
      ELSE NULL
    END,
    location = CASE
      WHEN definition_id IN ('starter_sword', 'starter_bow', 'starter_staff')
        THEN 'equipped'
      ELSE 'inventory'
    END
WHERE location = 'equipped'
  AND equipped_slot = 'weapon';

ALTER TABLE equipment_instances
  VALIDATE CONSTRAINT equipment_instances_equipped_slot_check;

-- Historical operation rows retain "weapon" as their original request
-- vocabulary. New operations use only the seven launch slots.
ALTER TABLE equipment_operations
  DROP CONSTRAINT IF EXISTS equipment_operations_requested_slot_check;
ALTER TABLE equipment_operations
  ADD CONSTRAINT equipment_operations_requested_slot_check
  CHECK (
    requested_slot IS NULL
    OR requested_slot IN (
      'weapon', 'head', 'chest', 'gloves', 'boots', 'ring', 'melee', 'secondary'
    )
  );

CREATE TABLE IF NOT EXISTS player_equipment_state (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  inventory_revision bigint NOT NULL DEFAULT 0 CHECK (inventory_revision >= 0),
  active_revision bigint NOT NULL DEFAULT 0 CHECK (active_revision >= 0),
  checkpoint_revision bigint NOT NULL DEFAULT 0 CHECK (checkpoint_revision >= 0),
  readied_weapon_slot text NOT NULL DEFAULT 'melee'
    CHECK (readied_weapon_slot IN ('melee', 'secondary')),
  active_kit_index smallint NULL
    CHECK (active_kit_index IS NULL OR active_kit_index BETWEEN 1 AND 6),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (checkpoint_revision <= active_revision)
);

INSERT INTO player_equipment_state (
  player_id, readied_weapon_slot
)
SELECT
  player.id,
  CASE
    WHEN EXISTS (
      SELECT 1
      FROM equipment_instances equipment
      WHERE equipment.owner_player_id = player.id
        AND equipment.location = 'equipped'
        AND equipment.equipped_slot = 'secondary'
        AND equipment.definition_id IN ('starter_bow', 'starter_staff')
    ) THEN 'secondary'
    ELSE 'melee'
  END
FROM players player
ON CONFLICT (player_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS combat_kits (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  kit_index smallint NOT NULL CHECK (kit_index BETWEEN 1 AND 6),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 32),
  readied_weapon_slot text NOT NULL DEFAULT 'melee'
    CHECK (readied_weapon_slot IN ('melee', 'secondary')),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, kit_index)
);

INSERT INTO combat_kits (player_id, kit_index, name)
SELECT player.id, kit_index, 'Kit ' || kit_index::text
FROM players player
CROSS JOIN generate_series(1, 6) AS kit_index
ON CONFLICT (player_id, kit_index) DO NOTHING;

CREATE TABLE IF NOT EXISTS combat_kit_items (
  player_id text NOT NULL,
  kit_index smallint NOT NULL,
  equipment_slot text NOT NULL
    CHECK (equipment_slot IN ('head', 'chest', 'gloves', 'boots', 'ring', 'melee', 'secondary')),
  instance_id uuid NOT NULL REFERENCES equipment_instances(instance_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, kit_index, equipment_slot),
  UNIQUE (player_id, kit_index, instance_id),
  FOREIGN KEY (player_id, kit_index)
    REFERENCES combat_kits(player_id, kit_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS combat_kit_items_instance_idx
  ON combat_kit_items (instance_id, player_id, kit_index);

CREATE TABLE IF NOT EXISTS combat_kit_operations (
  operation_key text PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  action text NOT NULL
    CHECK (action IN ('save', 'rename', 'clear', 'toggle_readied', 'activate')),
  kit_index smallint NULL
    CHECK (kit_index IS NULL OR kit_index BETWEEN 1 AND 6),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (octet_length(payload::text) <= 4096),
  result jsonb NULL
    CHECK (result IS NULL OR octet_length(result::text) <= 262144),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  UNIQUE (player_id, request_id),
  CHECK ((completed_at IS NULL) = (result IS NULL))
);

CREATE TABLE IF NOT EXISTS equipment_upgrade_operations (
  operation_key text PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  instance_id uuid NOT NULL REFERENCES equipment_instances(instance_id) ON DELETE RESTRICT,
  expected_level smallint NOT NULL CHECK (expected_level BETWEEN 0 AND 25),
  level_before smallint NULL CHECK (level_before BETWEEN 0 AND 24),
  level_after smallint NULL CHECK (level_after BETWEEN 1 AND 25),
  gold_cost bigint NULL CHECK (gold_cost > 0),
  balance_version integer NULL CHECK (balance_version > 0),
  wallet_operation_key text NULL,
  wallet_version_after bigint NULL CHECK (wallet_version_after > 0),
  result jsonb NULL
    CHECK (result IS NULL OR octet_length(result::text) <= 262144),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  UNIQUE (account_id, request_id),
  FOREIGN KEY (player_id, account_id)
    REFERENCES players(id, account_id) ON DELETE RESTRICT,
  FOREIGN KEY (wallet_operation_key, player_id)
    REFERENCES wallet_events(operation_key, player_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK (
    (completed_at IS NULL
      AND level_before IS NULL
      AND level_after IS NULL
      AND gold_cost IS NULL
      AND balance_version IS NULL
      AND wallet_operation_key IS NULL
      AND wallet_version_after IS NULL
      AND result IS NULL)
    OR
    (completed_at IS NOT NULL
      AND level_before IS NOT NULL
      AND level_after = level_before + 1
      AND gold_cost IS NOT NULL
      AND balance_version IS NOT NULL
      AND wallet_operation_key IS NOT NULL
      AND wallet_version_after IS NOT NULL
      AND result IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS equipment_upgrade_operations_player_created_idx
  ON equipment_upgrade_operations (player_id, created_at DESC);
CREATE INDEX IF NOT EXISTS equipment_upgrade_operations_instance_created_idx
  ON equipment_upgrade_operations (instance_id, created_at DESC);

CREATE TABLE IF NOT EXISTS equipment_audit_events (
  event_id bigserial PRIMARY KEY,
  operation_key text NOT NULL CHECK (length(operation_key) BETWEEN 1 AND 240),
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (
    event_type IN (
      'equipment_upgraded',
      'combat_kit_saved',
      'combat_kit_renamed',
      'combat_kit_cleared',
      'readied_weapon_changed',
      'active_loadout_checkpointed'
    )
  ),
  instance_id uuid NULL REFERENCES equipment_instances(instance_id) ON DELETE RESTRICT,
  kit_index smallint NULL
    CHECK (kit_index IS NULL OR kit_index BETWEEN 1 AND 6),
  inventory_revision bigint NOT NULL CHECK (inventory_revision >= 0),
  active_revision bigint NOT NULL CHECK (active_revision >= 0),
  details jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (octet_length(details::text) <= 4096),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operation_key, event_type)
);

CREATE INDEX IF NOT EXISTS equipment_audit_events_player_created_idx
  ON equipment_audit_events (player_id, created_at DESC);

CREATE OR REPLACE FUNCTION reject_completed_equipment_operation_mutation()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'completed equipment operation history cannot be deleted';
  END IF;
  IF OLD.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'completed equipment operation history is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS combat_kit_operations_completed_immutable
  ON combat_kit_operations;
CREATE TRIGGER combat_kit_operations_completed_immutable
BEFORE UPDATE OR DELETE ON combat_kit_operations
FOR EACH ROW EXECUTE FUNCTION reject_completed_equipment_operation_mutation();

DROP TRIGGER IF EXISTS equipment_upgrade_operations_completed_immutable
  ON equipment_upgrade_operations;
CREATE TRIGGER equipment_upgrade_operations_completed_immutable
BEFORE UPDATE OR DELETE ON equipment_upgrade_operations
FOR EACH ROW EXECUTE FUNCTION reject_completed_equipment_operation_mutation();

CREATE OR REPLACE FUNCTION reject_equipment_audit_event_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'equipment audit events are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS equipment_audit_events_immutable
  ON equipment_audit_events;
CREATE TRIGGER equipment_audit_events_immutable
BEFORE UPDATE OR DELETE ON equipment_audit_events
FOR EACH ROW EXECUTE FUNCTION reject_equipment_audit_event_mutation();

DROP TRIGGER IF EXISTS player_equipment_state_set_updated_at
  ON player_equipment_state;
CREATE TRIGGER player_equipment_state_set_updated_at
BEFORE UPDATE ON player_equipment_state
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS combat_kits_set_updated_at ON combat_kits;
CREATE TRIGGER combat_kits_set_updated_at
BEFORE UPDATE ON combat_kits
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Preserve retained health percentage while moving every ordinary player to
-- the 100-HP launch baseline. Zero stays zero, living players stay alive, an
-- injured player cannot round up to full, and a full player remains full.
UPDATE player_combat_profiles
SET current_health = CASE
      WHEN current_health = 0 THEN 0
      WHEN current_health >= max_health THEN 100
      ELSE LEAST(
        99,
        GREATEST(1, round(current_health::numeric * 100 / max_health)::integer)
      )
    END,
    max_health = 100,
    persistence_version = persistence_version + 1,
    updated_at = now()
WHERE max_health <> 100;
