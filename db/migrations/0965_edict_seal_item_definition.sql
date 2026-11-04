-- Edict Seal: the Fallen Prison token and Vengeance metal ingredient.
-- Same id, name and catalog shape as the metals migration (0958), so whichever lands
-- first wins and the other is a no-op. Never an upsert here: 0958 owns the row if present.
INSERT INTO item_definitions (
  item_id, display_name, category, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants, unit_weight_grams, rarity
) VALUES (
  'edict_seal', 'Edict Seal', 'resource', true, 500,
  true, true, true, true, 'edict_seal', ARRAY['default']::text[], 5, 'uncommon'
)
ON CONFLICT (item_id) DO NOTHING;

-- Prison Key Fragment: Trifang Warden chest drop, no use yet.
INSERT INTO item_definitions (
  item_id, display_name, category, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants, unit_weight_grams, rarity
) VALUES (
  'prison_key_fragment', 'Prison Key Fragment', 'resource', true, 25,
  true, true, true, true, 'prison_key_fragment', ARRAY['default']::text[], 5, 'rare'
)
ON CONFLICT (item_id) DO NOTHING;
