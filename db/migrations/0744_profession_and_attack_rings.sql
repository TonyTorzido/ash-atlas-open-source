-- Register three one-slot ring definitions. This migration only makes the
-- items available to authoritative equipment grants; it does not grant or
-- alter any retained player equipment.
INSERT INTO item_definitions (
  item_id, display_name, category, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants
)
VALUES
  (
    'chopping_ring', 'Chopping Ring', 'equipment', false, 1,
    false, true, false, false, NULL, ARRAY['default']::text[]
  ),
  (
    'mining_ring', 'Mining Ring', 'equipment', false, 1,
    false, true, false, false, NULL, ARRAY['default']::text[]
  ),
  (
    'attack_ring', 'Attack Ring', 'equipment', false, 1,
    false, true, false, false, NULL, ARRAY['default']::text[]
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
