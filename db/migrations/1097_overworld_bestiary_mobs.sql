-- Overworld bestiary additions (Dire Wolf, Woolly Mammoth, Ash Drake, Ember
-- Dragon, Snapjaw Flytrap, Cairn Golem): the nine new drop items. Item catalog
-- rows only; they match packages/shared/src/mobDropItems.ts, are market
-- tradable and carry no other state. Forward-only and idempotent.

LOCK TABLE item_definitions IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO item_definitions (
  item_id, display_name, category, rarity, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants, unit_weight_grams
)
VALUES
  ('drake_scale', 'Drake Scale', 'resource', 'common', true, 250, true, true, true, true, 'drake_scale', ARRAY['default']::text[], 100),
  ('snapjaw_nectar', 'Snapjaw Nectar', 'resource', 'common', true, 250, true, true, true, true, 'snapjaw_nectar', ARRAY['default']::text[], 100),
  ('dire_wolf_pelt', 'Dire Wolf Pelt', 'resource', 'uncommon', true, 250, true, true, true, true, 'dire_wolf_pelt', ARRAY['default']::text[], 250),
  ('drake_tail_spike', 'Drake Tail Spike', 'resource', 'uncommon', true, 250, true, true, true, true, 'drake_tail_spike', ARRAY['default']::text[], 250),
  ('ember_scale', 'Ember Scale', 'resource', 'uncommon', true, 250, true, true, true, true, 'ember_scale', ARRAY['default']::text[], 100),
  ('fire_gland', 'Fire Gland', 'resource', 'uncommon', true, 250, true, true, true, true, 'fire_gland', ARRAY['default']::text[], 100),
  ('golem_heartstone', 'Golem Heartstone', 'resource', 'uncommon', true, 250, true, true, true, true, 'golem_heartstone', ARRAY['default']::text[], 100),
  ('mammoth_tusk', 'Mammoth Tusk', 'resource', 'rare', true, 250, true, true, true, true, 'mammoth_tusk', ARRAY['default']::text[], 250),
  ('ember_dragon_horn', 'Ember Dragon Horn', 'resource', 'rare', true, 25, true, true, true, true, 'ember_dragon_horn', ARRAY['default']::text[], 250)
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
