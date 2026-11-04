-- Bonewrought Blade and Mail (Ashen Crypt, docs/design/PETS_PLAN.md section 5). Carried relics for
-- now: a killing blow while carrying the Blade raises a Bone Thrall; dying while carrying the Mail
-- usually raises a Grave Echo. Rare, 10 g, matching packages/shared/src/inventoryCatalog.ts and
-- inventoryWeight.ts. Forward-only and idempotent.
INSERT INTO item_definitions (
  item_id, display_name, category, rarity, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants, unit_weight_grams
)
VALUES
  ('bonewrought_blade', 'Bonewrought Blade', 'resource', 'rare', true, 250, true, true, true, true, 'bonewrought_blade', ARRAY['default']::text[], 10),
  ('bonewrought_mail', 'Bonewrought Mail', 'resource', 'rare', true, 250, true, true, true, true, 'bonewrought_mail', ARRAY['default']::text[], 10)
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
