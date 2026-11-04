-- weapon families (phase 4): stock items for spear, dagger, brass knuckles, crossbow,
-- blowdart and sling. Shape, weight and rarity mirror training_axe and the shared equipment
-- catalog (packages/shared/src/equipment.ts, inventoryWeight.ts, inventoryCatalog.ts); the boot
-- catalog check compares them. Nothing here grants or modifies owned equipment.
INSERT INTO item_definitions (
  item_id, display_name, category, equipment_family_id, equipment_role, rarity,
  stackable, max_stack, droppable, manor_storable,
  market_tradable, market_fungible, market_identity, supported_variants, unit_weight_grams
) VALUES
  ('training_spear', 'Spear', 'equipment', 'spear', 'stock', 'common', false, 1, true, true, false, false, NULL, ARRAY['default']::text[], 1500),
  ('training_dagger', 'Dagger', 'equipment', 'dagger', 'stock', 'common', false, 1, true, true, false, false, NULL, ARRAY['default']::text[], 1500),
  ('training_knuckles', 'Brass Knuckles', 'equipment', 'brass_knuckles', 'stock', 'common', false, 1, true, true, false, false, NULL, ARRAY['default']::text[], 1500),
  ('training_crossbow', 'Crossbow', 'equipment', 'crossbow', 'stock', 'common', false, 1, true, true, false, false, NULL, ARRAY['default']::text[], 1500),
  ('training_blowdart', 'Blowdart', 'equipment', 'blowdart', 'stock', 'common', false, 1, true, true, false, false, NULL, ARRAY['default']::text[], 1500),
  ('training_sling', 'Sling', 'equipment', 'sling', 'stock', 'common', false, 1, true, true, false, false, NULL, ARRAY['default']::text[], 1500)
ON CONFLICT (item_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  category = EXCLUDED.category,
  equipment_family_id = EXCLUDED.equipment_family_id,
  equipment_role = EXCLUDED.equipment_role,
  rarity = EXCLUDED.rarity,
  stackable = EXCLUDED.stackable,
  max_stack = EXCLUDED.max_stack,
  droppable = EXCLUDED.droppable,
  manor_storable = EXCLUDED.manor_storable,
  market_tradable = EXCLUDED.market_tradable,
  market_fungible = EXCLUDED.market_fungible,
  market_identity = EXCLUDED.market_identity,
  supported_variants = EXCLUDED.supported_variants,
  unit_weight_grams = EXCLUDED.unit_weight_grams;
