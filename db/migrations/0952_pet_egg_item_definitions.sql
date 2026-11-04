-- Pet eggs and the Broken Whistle (docs/design/PETS_PLAN.md). Rare, 10 g, tradable until hatched,
-- matching packages/shared/src/inventoryCatalog.ts and inventoryWeight.ts. Forward-only and idempotent.
INSERT INTO item_definitions (
  item_id, display_name, category, rarity, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants, unit_weight_grams
)
VALUES
  ('brood_egg', 'Brood Egg', 'resource', 'rare', true, 250, true, true, true, true, 'brood_egg', ARRAY['default']::text[], 10),
  ('clutch_egg', 'Fangrock Clutch Egg', 'resource', 'rare', true, 250, true, true, true, true, 'clutch_egg', ARRAY['default']::text[], 10),
  ('crawler_egg', 'Crawler Egg', 'resource', 'rare', true, 250, true, true, true, true, 'crawler_egg', ARRAY['default']::text[], 10),
  ('broken_whistle', 'Broken Whistle', 'resource', 'rare', true, 250, true, true, true, true, 'broken_whistle', ARRAY['default']::text[], 10)
ON CONFLICT (item_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  category = EXCLUDED.category,
  rarity = EXCLUDED.rarity,
  stackable = EXCLUDED.stackable,
  max_stack = EXCLUDED.max_stack,
  droppable = EXCLUDED.droppable,
  manor_storable = EXCLUDED.manor_storable,
  market_tradable = EXCLUDED.market_tradable,
  market_fungible = EXCLUDED.market_fungible,
  market_identity = EXCLUDED.market_identity,
  supported_variants = EXCLUDED.supported_variants,
  unit_weight_grams = EXCLUDED.unit_weight_grams,
  updated_at = now();
