-- Giving Berries inherit the former resin consumable role. Resin custody and recipes remain intact.
UPDATE item_definitions SET category = 'resource', updated_at = now()
WHERE item_id = 'balsam_resin' AND category IS DISTINCT FROM 'resource';

INSERT INTO item_definitions (
  item_id, display_name, category, stackable, max_stack, market_tradable,
  market_fungible, market_identity, supported_variants, unit_weight_grams, rarity,
  droppable, manor_storable
)
SELECT 'giving_berry', 'Giving Berry', 'consumable', stackable, max_stack,
  market_tradable, market_fungible, 'giving_berry', supported_variants,
  unit_weight_grams, rarity, droppable, manor_storable
FROM item_definitions WHERE item_id = 'balsam_resin'
ON CONFLICT (item_id) DO NOTHING;
