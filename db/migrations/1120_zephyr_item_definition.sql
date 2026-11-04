-- Zephyr: the Monastery of the Still Hand token. The Grandmaster drops one per defeat; five offered at the
-- Zephyr Altar (or from the Skills panel) discover Perfect Strike. Rare and light (10 g), matching
-- packages/shared/src/inventoryCatalog.ts and inventoryWeight.ts. Forward-only and idempotent; replaces
-- the unshipped 0939 from the old Monastery branch.

LOCK TABLE item_definitions IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO item_definitions (
  item_id, display_name, category, rarity, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants, unit_weight_grams
) VALUES (
  'zephyr', 'Zephyr', 'resource', 'rare', true, 250,
  true, true, true, true, 'zephyr', ARRAY['default']::text[], 10
)
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
  updated_at = clock_timestamp();
