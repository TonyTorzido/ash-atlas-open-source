-- Gift Box: bought for Gold anywhere, consumed when sending a player gift.
-- Not tradable, droppable, giftable or package-grantable; Gold is its only source.
INSERT INTO item_definitions (
  item_id, display_name, category, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants, unit_weight_grams, rarity
) VALUES (
  'gift_box', 'Gift Box', 'resource', true, 100,
  false, true, false, false, NULL, ARRAY['default']::text[], 100, 'common'
)
ON CONFLICT (item_id) DO NOTHING;
