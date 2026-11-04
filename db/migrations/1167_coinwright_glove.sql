-- Coinwright Glove (gold-crafted utility gear, gloves slot). Forward-only and idempotent.
INSERT INTO item_definitions (
  item_id, display_name, category, equipment_family_id, equipment_role, rarity,
  stackable, max_stack, droppable, manor_storable,
  market_tradable, market_fungible, market_identity, supported_variants, unit_weight_grams
) VALUES
  ('coinwright_glove', 'Coinwright Glove', 'equipment', 'utility_glove', 'special', 'rare', false, 1, true, true, false, false, NULL, ARRAY['default']::text[], 1000)
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

ALTER TABLE equipment_instances
  DROP CONSTRAINT IF EXISTS equipment_instances_uses_remaining_check;
ALTER TABLE equipment_instances
  ADD CONSTRAINT equipment_instances_uses_remaining_check CHECK (
    CASE
      WHEN definition_id IN ('lumber_glove', 'delver_glove', 'artisan_glove', 'lodestone_boot', 'coinwright_glove')
        THEN uses_remaining IS NOT NULL AND uses_remaining >= 0
      ELSE uses_remaining IS NULL
    END
  );

