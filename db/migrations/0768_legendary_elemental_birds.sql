INSERT INTO item_definitions (
  item_id, display_name, category, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants, rarity
)
VALUES
  ('fire_feather', 'Fire Feather', 'resource', false, 1, true, true, true, true, 'fire_feather', ARRAY['default']::text[], 'legendary'),
  ('tempest_quill', 'Tempest Quill', 'resource', false, 1, true, true, true, true, 'tempest_quill', ARRAY['default']::text[], 'legendary'),
  ('ice_feather', 'Ice Feather', 'resource', false, 1, true, true, true, true, 'ice_feather', ARRAY['default']::text[], 'legendary'),
  ('fire_bar', 'Fire Bar', 'resource', true, 50, true, true, true, true, 'fire_bar', ARRAY['default']::text[], 'legendary'),
  ('fire_core', 'Fire Core', 'resource', false, 1, true, true, true, true, 'fire_core', ARRAY['default']::text[], 'legendary'),
  ('lightning_bar', 'Lightning Bar', 'resource', true, 50, true, true, true, true, 'lightning_bar', ARRAY['default']::text[], 'legendary'),
  ('lightning_core', 'Lightning Core', 'resource', false, 1, true, true, true, true, 'lightning_core', ARRAY['default']::text[], 'legendary'),
  ('ice_bar', 'Ice Bar', 'resource', true, 50, true, true, true, true, 'ice_bar', ARRAY['default']::text[], 'legendary'),
  ('ice_core', 'Ice Core', 'resource', false, 1, true, true, true, true, 'ice_core', ARRAY['default']::text[], 'legendary')
ON CONFLICT (item_id) DO UPDATE SET
  display_name=EXCLUDED.display_name, category=EXCLUDED.category,
  stackable=EXCLUDED.stackable, max_stack=EXCLUDED.max_stack,
  droppable=EXCLUDED.droppable, manor_storable=EXCLUDED.manor_storable,
  market_tradable=EXCLUDED.market_tradable, market_fungible=EXCLUDED.market_fungible,
  market_identity=EXCLUDED.market_identity, supported_variants=EXCLUDED.supported_variants,
  rarity=EXCLUDED.rarity,
  updated_at=now();

ALTER TABLE furnace_smelt_jobs DROP CONSTRAINT IF EXISTS furnace_smelt_jobs_recipe_id_check;
ALTER TABLE furnace_smelt_jobs ADD CONSTRAINT furnace_smelt_jobs_recipe_id_check CHECK (
  recipe_id IN (
    'iron_bar', 'venomsteel_bar', 'venomsteel_core',
    'fire_bar', 'fire_core', 'lightning_bar', 'lightning_core', 'ice_bar', 'ice_core'
  )
);

ALTER TABLE flags
  ADD COLUMN IF NOT EXISTS health smallint NOT NULL DEFAULT 200,
  ADD COLUMN IF NOT EXISTS maximum_health smallint NOT NULL DEFAULT 200,
  ADD COLUMN IF NOT EXISTS burning_started_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS burning_until timestamptz NULL,
  ADD COLUMN IF NOT EXISTS burning_reason text NULL;
ALTER TABLE flags DROP CONSTRAINT IF EXISTS flags_health_valid;
ALTER TABLE flags ADD CONSTRAINT flags_health_valid CHECK (
  health BETWEEN 0 AND maximum_health AND maximum_health = 200
);
ALTER TABLE flags DROP CONSTRAINT IF EXISTS flags_burning_state_valid;
ALTER TABLE flags ADD CONSTRAINT flags_burning_state_valid CHECK (
  (burning_started_at IS NULL AND burning_until IS NULL AND burning_reason IS NULL)
  OR
  (burning_started_at IS NOT NULL AND burning_until IS NOT NULL
   AND burning_until > burning_started_at AND burning_reason IN ('legendary_event'))
);

CREATE TABLE IF NOT EXISTS legendary_bird_cycles (
  cycle_started_at timestamptz PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at = cycle_started_at + interval '24 hours')
);

CREATE TABLE IF NOT EXISTS legendary_bird_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_started_at timestamptz NOT NULL REFERENCES legendary_bird_cycles(cycle_started_at),
  bird_species text NOT NULL CHECK (bird_species IN ('fire', 'lightning', 'ice')),
  flag_id uuid NOT NULL REFERENCES flags(id) ON DELETE CASCADE,
  owner_player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'completed', 'expired')),
  selected_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  activated_at timestamptz NULL,
  activated_by_player_id text NULL REFERENCES players(id) ON DELETE SET NULL,
  combat_entity_id uuid NOT NULL DEFAULT gen_random_uuid(),
  completed_at timestamptz NULL,
  defeat_settlement_key text NULL,
  CHECK (expires_at = cycle_started_at + interval '24 hours'),
  CHECK ((status = 'pending' AND activated_at IS NULL) OR status <> 'pending')
);
CREATE UNIQUE INDEX IF NOT EXISTS legendary_bird_event_cycle_flag_unique
  ON legendary_bird_events (cycle_started_at, flag_id);
CREATE UNIQUE INDEX IF NOT EXISTS legendary_bird_event_live_flag_unique
  ON legendary_bird_events (flag_id) WHERE status IN ('pending', 'active');
CREATE UNIQUE INDEX IF NOT EXISTS legendary_bird_event_entity_unique
  ON legendary_bird_events (combat_entity_id);
CREATE UNIQUE INDEX IF NOT EXISTS legendary_bird_event_defeat_unique
  ON legendary_bird_events (defeat_settlement_key) WHERE defeat_settlement_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS legendary_bird_event_recovery_idx
  ON legendary_bird_events (status, expires_at, event_id);

COMMENT ON TABLE legendary_bird_events IS
  'Durable daily hard-flag encounters. Pending and active events expire at the next 24-hour cycle boundary.';
