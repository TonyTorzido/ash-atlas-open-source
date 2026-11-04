-- Register published armor appearances as cosmetic equipment definitions.
-- This migration does not grant or modify equipment owned by players.
INSERT INTO item_definitions (
  item_id, display_name, category, equipment_family_id, equipment_role, rarity,
  stackable, max_stack, droppable, manor_storable,
  market_tradable, market_fungible, market_identity, supported_variants
)
VALUES
  (
    'cloth-armor-grey', 'Cloth Armor Grey', 'equipment', 'tunic', 'cosmetic', 'common',
    false, 1, true, true, false, false, NULL, ARRAY['default']::text[]
  ),
  (
    'leather-armor-', 'Leather Armor', 'equipment', 'leather', 'cosmetic', 'common',
    false, 1, true, true, false, false, NULL, ARRAY['default']::text[]
  ),
  (
    'breastplate-armor', 'Breastplate Armor', 'equipment', 'breastplate', 'cosmetic', 'common',
    false, 1, true, true, false, false, NULL, ARRAY['default']::text[]
  )
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
  updated_at = now();
