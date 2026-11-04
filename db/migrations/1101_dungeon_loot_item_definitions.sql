-- Dungeon special-metal ingredients (dungeon procgen plan, owner decision 5).
-- Cave Lichen (Fangrock), Gale Plume (Eyrie), Heartsap (Grove), Dragon Scale (Wyrm Hollow) and
-- Maw Bloom Petal (Drowned City) are rare dungeon drops. Special-metal infusion is a later system;
-- until it ships they are stackable, tradeable materials. Stack, weight and rarity match
-- packages/shared/src/collectibles.ts, inventoryWeight.ts and inventoryCatalog.ts; the boot item
-- catalog check compares them.
INSERT INTO item_definitions (
  item_id, display_name, category, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants, unit_weight_grams, rarity
) VALUES
  ('cave_lichen', 'Cave Lichen', 'resource', true, 25,
   true, true, true, true, 'cave_lichen', ARRAY['default']::text[], 10, 'rare'),
  ('gale_plume', 'Gale Plume', 'resource', true, 25,
   true, true, true, true, 'gale_plume', ARRAY['default']::text[], 10, 'rare'),
  ('heartsap', 'Heartsap', 'resource', true, 25,
   true, true, true, true, 'heartsap', ARRAY['default']::text[], 10, 'rare'),
  ('dragon_scale', 'Dragon Scale', 'resource', true, 25,
   true, true, true, true, 'dragon_scale', ARRAY['default']::text[], 10, 'rare'),
  ('maw_bloom_petal', 'Maw Bloom Petal', 'resource', true, 25,
   true, true, true, true, 'maw_bloom_petal', ARRAY['default']::text[], 10, 'rare')
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
