-- metals framework (phase 1): 11 new materials and 10 new metal bars.
-- Stack, weight and rarity mirror packages/shared/src/collectibles.ts,
-- inventoryWeight.ts and inventoryCatalog.ts; the boot catalog check compares them.
-- Edict Seal also ships with the Fallen Prison migration (0965): same row, never an upsert.
INSERT INTO item_definitions (
  item_id, display_name, category, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants, unit_weight_grams, rarity
) VALUES (
  'edict_seal', 'Edict Seal', 'resource', true, 500,
  true, true, true, true, 'edict_seal', ARRAY['default']::text[], 5, 'uncommon'
)
ON CONFLICT (item_id) DO NOTHING;

INSERT INTO item_definitions (
  item_id, display_name, category, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants, unit_weight_grams, rarity
) VALUES
  ('lichen', 'Lichen', 'resource', true, 250, true, true, true, true, 'lichen', ARRAY['default']::text[], 10, 'common'),
  ('thistle', 'Thistle', 'resource', true, 250, true, true, true, true, 'thistle', ARRAY['default']::text[], 10, 'common'),
  ('umbral_essence', 'Umbral Essence', 'resource', true, 250, true, true, true, true, 'umbral_essence', ARRAY['default']::text[], 10, 'uncommon'),
  ('dusk_heart', 'Dusk Heart', 'resource', true, 25, true, true, true, true, 'dusk_heart', ARRAY['default']::text[], 10, 'rare'),
  ('bloom_petal', 'Bloom Petal', 'resource', true, 250, true, true, true, true, 'bloom_petal', ARRAY['default']::text[], 10, 'uncommon'),
  ('gearwork_essence', 'Gearwork Essence', 'resource', true, 500, true, true, true, true, 'gearwork_essence', ARRAY['default']::text[], 5, 'common'),
  ('gale_splinter', 'Gale Splinter', 'resource', true, 500, true, true, true, true, 'gale_splinter', ARRAY['default']::text[], 5, 'common'),
  ('griffin_plume', 'Griffin Plume', 'resource', true, 250, true, true, true, true, 'griffin_plume', ARRAY['default']::text[], 10, 'rare'),
  ('skyrise_stone', 'Skyrise Stone', 'resource', true, 25, true, true, true, true, 'skyrise_stone', ARRAY['default']::text[], 100, 'rare'),
  ('mist_drop', 'Mist Drop', 'resource', true, 1000, true, true, true, true, 'mist_drop', ARRAY['default']::text[], 2, 'common'),
  ('revenant_bar', 'Revenant Bar', 'resource', true, 50, true, true, true, true, 'revenant_bar', ARRAY['default']::text[], 500, 'rare'),
  ('expel_bar', 'Expel Bar', 'resource', true, 50, true, true, true, true, 'expel_bar', ARRAY['default']::text[], 500, 'rare'),
  ('mirage_bar', 'Mirage Bar', 'resource', true, 50, true, true, true, true, 'mirage_bar', ARRAY['default']::text[], 500, 'rare'),
  ('gale_bar', 'Gale Bar', 'resource', true, 50, true, true, true, true, 'gale_bar', ARRAY['default']::text[], 500, 'rare'),
  ('fleet_bar', 'Fleet Bar', 'resource', true, 50, true, true, true, true, 'fleet_bar', ARRAY['default']::text[], 500, 'rare'),
  ('whetted_bar', 'Whetted Bar', 'resource', true, 50, true, true, true, true, 'whetted_bar', ARRAY['default']::text[], 500, 'rare'),
  ('vengeance_bar', 'Vengeance Bar', 'resource', true, 50, true, true, true, true, 'vengeance_bar', ARRAY['default']::text[], 500, 'rare'),
  ('gloom_bar', 'Gloom Bar', 'resource', true, 50, true, true, true, true, 'gloom_bar', ARRAY['default']::text[], 500, 'rare'),
  ('skyrise_bar', 'Skyrise Bar', 'resource', true, 50, true, true, true, true, 'skyrise_bar', ARRAY['default']::text[], 500, 'rare'),
  ('vital_bar', 'Vital Bar', 'resource', true, 50, true, true, true, true, 'vital_bar', ARRAY['default']::text[], 500, 'rare')
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
