-- Register the published Double Axe and Breast Plate definitions in the
-- authoritative inventory catalog. This does not grant or modify equipment.
INSERT INTO item_definitions (
  item_id, display_name, category, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants
)
VALUES
  (
    'double_axe', 'Double Axe', 'equipment', false, 1,
    false, true, false, false, NULL, ARRAY['default']::text[]
  ),
  (
    'breast_plate', 'Breast Plate', 'equipment', false, 1,
    false, true, false, false, NULL, ARRAY['default']::text[]
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
  updated_at = now();
