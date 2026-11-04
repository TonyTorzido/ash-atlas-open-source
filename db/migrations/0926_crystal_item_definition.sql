-- Crystal: produced by a member's Quartz Hut, used by Kingdom Towers.
-- Stack and weight match Crude Oil (packages/shared/src/collectibles.ts,
-- packages/shared/src/inventoryWeight.ts); the boot catalog check compares them.
INSERT INTO item_definitions (
  item_id, display_name, category, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants, unit_weight_grams, rarity
) VALUES (
  'crystal', 'Crystal', 'resource', true, 250,
  true, true, true, true, 'crystal', ARRAY['default']::text[], 250, 'common'
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
  unit_weight_grams = EXCLUDED.unit_weight_grams,
  rarity = EXCLUDED.rarity,
  updated_at = now();
