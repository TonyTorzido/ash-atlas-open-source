-- Own-meat cuts for the overworld bestiary additions (Dire Wolf, Ash Drake,
-- Ember Dragon, Giant Larva). Item catalog rows only; they match
-- packages/shared/src/mobDropItems.ts and universalFood.ts, are market
-- tradable and carry no other state. Kitchen recipe ids are free-form since
-- 1062. Forward-only and idempotent.

LOCK TABLE item_definitions IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO item_definitions (
  item_id, display_name, category, rarity, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants, unit_weight_grams
)
VALUES
  ('dire_wolf_cut', 'Dire Wolf Cut', 'resource', 'uncommon', true, 250, true, true, true, true, 'dire_wolf_cut', ARRAY['default']::text[], 250),
  ('drake_cut', 'Drake Cut', 'resource', 'uncommon', true, 250, true, true, true, true, 'drake_cut', ARRAY['default']::text[], 250),
  ('dragon_cut', 'Dragon Cut', 'resource', 'rare', true, 250, true, true, true, true, 'dragon_cut', ARRAY['default']::text[], 250),
  ('grub_meat', 'Grub Meat', 'resource', 'uncommon', true, 250, true, true, true, true, 'grub_meat', ARRAY['default']::text[], 250)
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