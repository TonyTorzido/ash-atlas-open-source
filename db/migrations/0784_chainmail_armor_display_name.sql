UPDATE item_definitions
SET display_name = 'Chainmail Armor',
    updated_at = now()
WHERE item_id = 'chain_armor'
  AND display_name IS DISTINCT FROM 'Chainmail Armor';
