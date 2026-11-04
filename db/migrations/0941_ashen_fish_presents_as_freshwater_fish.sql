-- Ashen is retired. The legacy ashen_fish item id stays so stored holdings still resolve, but it now
-- presents as an ordinary freshwater fish. Keep item_definitions in step with the compiled catalog.
UPDATE item_definitions
SET display_name = 'Freshwater Fish',
    rarity = 'common'
WHERE item_id = 'ashen_fish'
  AND (display_name IS DISTINCT FROM 'Freshwater Fish' OR rarity IS DISTINCT FROM 'common');
