INSERT INTO item_definitions (item_id, display_name, category, stackable, max_stack)
VALUES
  ('starter_sword', 'Starter Sword', 'equipment', false, 1),
  ('padded_tunic', 'Padded Tunic', 'equipment', false, 1)
ON CONFLICT (item_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  category = EXCLUDED.category,
  stackable = EXCLUDED.stackable,
  max_stack = EXCLUDED.max_stack,
  updated_at = now();

CREATE TABLE IF NOT EXISTS equipment_operations (
  operation_key text PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('starter_loadout', 'equip', 'unequip')),
  instance_id uuid NULL,
  requested_slot text NULL CHECK (requested_slot IS NULL OR requested_slot IN ('weapon', 'chest')),
  result jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL
);

CREATE TABLE IF NOT EXISTS equipment_instances (
  instance_id uuid PRIMARY KEY,
  definition_id text NOT NULL REFERENCES item_definitions(item_id),
  owner_player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  location text NOT NULL CHECK (location IN ('inventory', 'equipped', 'destroyed')),
  equipped_slot text NULL CHECK (equipped_slot IS NULL OR equipped_slot IN ('weapon', 'chest')),
  created_by_operation_key text NOT NULL REFERENCES equipment_operations(operation_key),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((location = 'equipped') = (equipped_slot IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS equipment_one_slot_per_player_idx
  ON equipment_instances (owner_player_id, equipped_slot)
  WHERE location = 'equipped';
CREATE UNIQUE INDEX IF NOT EXISTS equipment_starter_definition_once_idx
  ON equipment_instances (owner_player_id, definition_id)
  WHERE definition_id IN ('starter_sword', 'padded_tunic') AND location <> 'destroyed';
CREATE INDEX IF NOT EXISTS equipment_owner_idx
  ON equipment_instances (owner_player_id, location);

DROP TRIGGER IF EXISTS equipment_instances_set_updated_at ON equipment_instances;
CREATE TRIGGER equipment_instances_set_updated_at
BEFORE UPDATE ON equipment_instances
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS combat_reward_settlements (
  settlement_key text PRIMARY KEY,
  defeated_mob_instance_id text NOT NULL,
  mob_life_generation integer NOT NULL CHECK (mob_life_generation >= 0),
  mob_archetype text NOT NULL,
  server_tick bigint NOT NULL CHECK (server_tick >= 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  error_code text NULL,
  failure_summary text NULL CHECK (failure_summary IS NULL OR length(failure_summary) <= 240),
  base_xp_pool integer NOT NULL DEFAULT 0 CHECK (base_xp_pool >= 0),
  calculated_xp_pool integer NOT NULL DEFAULT 0 CHECK (calculated_xp_pool >= 0),
  result jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  UNIQUE (defeated_mob_instance_id, mob_life_generation)
);

CREATE TABLE IF NOT EXISTS combat_reward_participants (
  settlement_key text NOT NULL REFERENCES combat_reward_settlements(settlement_key) ON DELETE CASCADE,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  authoritative_damage integer NOT NULL CHECK (authoritative_damage > 0),
  player_level integer NOT NULL CHECK (player_level BETWEEN 0 AND 25),
  level_multiplier numeric(6, 4) NOT NULL CHECK (level_multiplier > 0),
  contribution_share numeric(12, 8) NOT NULL CHECK (contribution_share > 0 AND contribution_share <= 1),
  requested_xp integer NOT NULL DEFAULT 0 CHECK (requested_xp >= 0),
  granted_xp integer NOT NULL DEFAULT 0 CHECK (granted_xp >= 0),
  xp_operation_key text NULL REFERENCES xp_operations(operation_key),
  PRIMARY KEY (settlement_key, player_id)
);

CREATE INDEX IF NOT EXISTS combat_reward_settlement_status_idx
  ON combat_reward_settlements (status, updated_at);

