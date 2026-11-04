-- Greenhouse crafting inputs and Skeleton loot are durable inventory identities.
-- Their acquisition rules remain server-authoritative: Bone comes from Skeleton
-- combat rewards, while Fertilizer and Flux Plant are not package grants.
INSERT INTO item_definitions (
  item_id, display_name, category, rarity, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants, unit_weight_grams
)
VALUES
  ('bone', 'Bone', 'resource', 'common', true, 250,
   true, true, false, false, NULL, ARRAY['default']::text[], 100),
  ('fertilizer', 'Fertilizer', 'resource', 'common', true, 250,
   true, true, false, false, NULL, ARRAY['default']::text[], 250),
  ('flux_plant', 'Flux Plant', 'resource', 'common', true, 250,
   true, true, false, false, NULL, ARRAY['default']::text[], 25)
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
