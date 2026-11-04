ALTER TABLE flags DROP CONSTRAINT IF EXISTS flags_burning_state_valid;
ALTER TABLE flags ADD CONSTRAINT flags_burning_state_valid CHECK (
  (burning_started_at IS NULL AND burning_until IS NULL AND burning_reason IS NULL)
  OR
  (burning_started_at IS NOT NULL AND burning_until IS NOT NULL
   AND burning_until > burning_started_at
   AND burning_reason IN ('legendary_event', 'flag_burn'))
);

INSERT INTO item_definitions (
  item_id, display_name, category, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants, rarity
)
VALUES (
  'torch', 'Torch', 'consumable', true, 250,
  true, true, false, false,
  NULL, ARRAY['default']::text[], 'common'
)
ON CONFLICT (item_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  category = EXCLUDED.category,
  stackable = EXCLUDED.stackable,
  max_stack = EXCLUDED.max_stack,
  droppable = EXCLUDED.droppable,
  manor_storable = EXCLUDED.manor_storable,
  market_tradable = EXCLUDED.market_tradable,
  market_fungible = EXCLUDED.market_fungible,
  market_identity = EXCLUDED.market_identity,
  supported_variants = EXCLUDED.supported_variants,
  rarity = EXCLUDED.rarity,
  updated_at = now();

CREATE TABLE IF NOT EXISTS flag_burn_operations (
  operation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  burner_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  victim_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  flag_id uuid NOT NULL,
  request_id text NOT NULL,
  flag_name text NOT NULL,
  flag_lat double precision NOT NULL,
  flag_lon double precision NOT NULL,
  notice_message text NOT NULL,
  started_at timestamptz NOT NULL,
  completes_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'cancelled', 'completed')),
  cancel_reason text NULL,
  completed_at timestamptz NULL,
  result jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (burner_player_id, request_id),
  CHECK (burner_player_id <> victim_player_id),
  CHECK (completes_at = started_at + interval '25 seconds'),
  CHECK ((status = 'active' AND completed_at IS NULL)
      OR (status IN ('cancelled', 'completed') AND completed_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS flag_burn_operations_active_flag_unique
  ON flag_burn_operations (flag_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS flag_burn_operations_active_player_idx
  ON flag_burn_operations (burner_player_id, completes_at)
  WHERE status = 'active';

COMMENT ON TABLE flag_burn_operations IS
  'Durable 25-second player flag burning operations. The operation is authoritative; flags.burning_* is a presentation mirror only.';
