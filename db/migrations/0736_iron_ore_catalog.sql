UPDATE item_definitions
SET display_name = 'Iron Ore'
WHERE item_id = 'iron'
  AND display_name IS DISTINCT FROM 'Iron Ore';
