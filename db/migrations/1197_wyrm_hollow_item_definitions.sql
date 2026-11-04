-- Wyrm Hollow (level 27 dungeon) item: the Wyrm Egg (6 plus 3 trophies discover Rare Beast
-- Mastery at the Wyrm Nest; one hatches an Ember Drake). Rare, 10 g, stack 25, matching
-- packages/shared/src/collectibles.ts, inventoryCatalog.ts and inventoryWeight.ts. The Dragon Scale
-- row comes from 1101_dungeon_loot_item_definitions.sql. Forward-only and idempotent (ON CONFLICT
-- DO UPDATE); replaces the unshipped 0940 from the old Wyrm Hollow branch.
INSERT INTO item_definitions (
  item_id, display_name, category, rarity, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants, unit_weight_grams
)
VALUES
  ('wyrm_egg', 'Wyrm Egg', 'resource', 'rare', true, 25, true, true, true, true, 'wyrm_egg', ARRAY['default']::text[], 10)
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
