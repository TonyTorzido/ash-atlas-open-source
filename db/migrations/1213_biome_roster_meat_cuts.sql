-- Biome roster phase C: the meat cuts of the ten new land animals (Field Hare, Arctic Hare,
-- Capybara, Armadillo, Red Fox, Wolverine, Ostrich, Golden Eagle, Musk Ox, Seal).
-- Same policy and weight as every other species cut (see 1020_mob_wave_1_items.sql). Kitchen jobs
-- accept any recipe id since 1062, so only the item catalog rows are needed. Forward-only and
-- idempotent.

INSERT INTO item_definitions (
  item_id, display_name, category, rarity, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants, unit_weight_grams
)
VALUES
  ('field_hare_cut', 'Field Hare Cut', 'resource', 'common', true, 250, true, true, true, true, 'field_hare_cut', ARRAY['default']::text[], 250),
  ('arctic_hare_cut', 'Arctic Hare Cut', 'resource', 'common', true, 250, true, true, true, true, 'arctic_hare_cut', ARRAY['default']::text[], 250),
  ('capybara_cut', 'Capybara Cut', 'resource', 'common', true, 250, true, true, true, true, 'capybara_cut', ARRAY['default']::text[], 250),
  ('armadillo_cut', 'Armadillo Cut', 'resource', 'common', true, 250, true, true, true, true, 'armadillo_cut', ARRAY['default']::text[], 250),
  ('red_fox_cut', 'Red Fox Cut', 'resource', 'common', true, 250, true, true, true, true, 'red_fox_cut', ARRAY['default']::text[], 250),
  ('wolverine_cut', 'Wolverine Cut', 'resource', 'common', true, 250, true, true, true, true, 'wolverine_cut', ARRAY['default']::text[], 250),
  ('ostrich_cut', 'Ostrich Cut', 'resource', 'common', true, 250, true, true, true, true, 'ostrich_cut', ARRAY['default']::text[], 250),
  ('golden_eagle_cut', 'Golden Eagle Cut', 'resource', 'common', true, 250, true, true, true, true, 'golden_eagle_cut', ARRAY['default']::text[], 250),
  ('musk_ox_cut', 'Musk Ox Cut', 'resource', 'common', true, 250, true, true, true, true, 'musk_ox_cut', ARRAY['default']::text[], 250),
  ('seal_cut', 'Seal Cut', 'resource', 'common', true, 250, true, true, true, true, 'seal_cut', ARRAY['default']::text[], 250)
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
