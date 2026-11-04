-- Greenhouse crop identity is durable, while the server catalog owns which
-- IDs can be planted and the exact seed/produce inventory identity for each.
ALTER TABLE greenhouse_plants
  ADD COLUMN crop_id text;

UPDATE greenhouse_plants
SET crop_id = 'wheat'
WHERE crop_id IS NULL;

ALTER TABLE greenhouse_plants
  ALTER COLUMN crop_id SET NOT NULL,
  ADD CONSTRAINT greenhouse_plants_crop_id_check
    CHECK (crop_id ~ '^[a-z][a-z0-9_]{0,47}$');

-- Generic crop identities use their cropId as the inventory variant. Legacy
-- wheat balances remain under wheat_seed and wheat, with no inventory rewrite.
INSERT INTO item_definitions (
  item_id, display_name, category, rarity, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants, unit_weight_grams
)
VALUES
  ('seed', 'Seed', 'resource', 'common', true, 250,
   false, true, false, false, NULL, ARRAY['default']::text[], 1),
  ('produce', 'Produce', 'resource', 'common', true, 250,
   false, true, false, false, NULL, ARRAY['default']::text[], 250)
ON CONFLICT (item_id) DO UPDATE SET
  display_name=EXCLUDED.display_name,
  category=EXCLUDED.category,
  rarity=EXCLUDED.rarity,
  stackable=EXCLUDED.stackable,
  max_stack=EXCLUDED.max_stack,
  droppable=EXCLUDED.droppable,
  manor_storable=EXCLUDED.manor_storable,
  market_tradable=EXCLUDED.market_tradable,
  market_fungible=EXCLUDED.market_fungible,
  market_identity=EXCLUDED.market_identity,
  supported_variants=EXCLUDED.supported_variants,
  unit_weight_grams=EXCLUDED.unit_weight_grams,
  updated_at=now();
