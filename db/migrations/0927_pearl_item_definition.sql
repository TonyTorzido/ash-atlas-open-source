-- Pearl: rare Jellyfish drop (combat item reward policy V8), Command Board material.
-- Stack and weight match Jellyfish Venom (packages/shared/src/collectibles.ts,
-- packages/shared/src/inventoryWeight.ts); the boot catalog check compares them.
INSERT INTO item_definitions (
  item_id, display_name, category, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants, unit_weight_grams, rarity
) VALUES (
  'pearl', 'Pearl', 'resource', true, 25,
  true, true, true, true, 'pearl', ARRAY['default']::text[], 10, 'rare'
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
