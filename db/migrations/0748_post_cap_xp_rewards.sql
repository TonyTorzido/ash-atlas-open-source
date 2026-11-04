-- Preserve lifetime character XP after Level 25 and add non-stacking Enchantment Stones.

DROP VIEW telemetry.authoritative_progression_events;

ALTER TABLE player_progression_profiles
  ALTER COLUMN total_xp TYPE bigint,
  DROP CONSTRAINT IF EXISTS player_progression_profiles_total_xp_check;
ALTER TABLE player_progression_profiles
  ADD CONSTRAINT player_progression_profiles_total_xp_check
  CHECK (total_xp >= 0);

ALTER TABLE xp_operations
  ALTER COLUMN previous_xp TYPE bigint,
  ALTER COLUMN resulting_xp TYPE bigint,
  DROP CONSTRAINT IF EXISTS xp_operations_previous_xp_check,
  DROP CONSTRAINT IF EXISTS xp_operations_resulting_xp_check;
ALTER TABLE xp_operations
  ADD CONSTRAINT xp_operations_previous_xp_check CHECK (previous_xp >= 0),
  ADD CONSTRAINT xp_operations_resulting_xp_check CHECK (resulting_xp >= 0);

ALTER TABLE xp_events
  ALTER COLUMN resulting_xp TYPE bigint,
  DROP CONSTRAINT IF EXISTS xp_events_resulting_xp_check;
ALTER TABLE xp_events
  ADD CONSTRAINT xp_events_resulting_xp_check CHECK (resulting_xp >= 0);

CREATE VIEW telemetry.authoritative_progression_events AS
SELECT
  operation_id::text AS operation_id,
  player_id,
  event_type,
  created_at AS event_time,
  xp_delta,
  resulting_xp,
  resulting_level,
  metadata - ARRAY[
    'playerId', 'player_id', 'accountId', 'account_id', 'sessionId', 'session_id'
  ] AS metadata
FROM public.xp_events;

COMMENT ON VIEW telemetry.authoritative_progression_events IS
  'Read-only analytical projection of durable progression authority; replay-safe by operation ID.';

INSERT INTO item_definitions (
  item_id, display_name, category, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants
)
VALUES (
  'enchantment_stone', 'Enchantment Stone', 'resource', false, 1,
  false, true, false, false, NULL,
  ARRAY['diamond','opal','amethyst','sapphire','ruby','emerald']::text[]
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
  updated_at = now();
