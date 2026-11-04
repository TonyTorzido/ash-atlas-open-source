-- Golem Forge items (docs/design/GOLEM_FORGE_PLAN.md): Forge Spark (raid token: Field Engineering,
-- monoliths, Storm Bar), Shard Grit (ring forging material, golem drop) and Amulet Clasp (boss
-- drop, amulet material). Stackable resources; Forge Spark and Amulet Clasp trade on the market,
-- Shard Grit does not (same definition as the Atlas Pass Shard Grit migration). Stack, weight and rarity match
-- packages/shared/src/collectibles.ts, inventoryWeight.ts and inventoryCatalog.ts; the boot item
-- catalog check compares them.
INSERT INTO item_definitions (
  item_id, display_name, category, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants, unit_weight_grams, rarity
) VALUES
  ('forge_spark', 'Forge Spark', 'resource', true, 500,
   true, true, true, true, 'forge_spark', ARRAY['default']::text[], 5, 'rare'),
  ('shard_grit', 'Shard Grit', 'resource', true, 10000,
   true, true, false, false, NULL, ARRAY['default']::text[], 1, 'uncommon'),
  ('amulet_clasp', 'Amulet Clasp', 'resource', true, 100,
   true, true, true, true, 'amulet_clasp', ARRAY['default']::text[], 5, 'rare')
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
