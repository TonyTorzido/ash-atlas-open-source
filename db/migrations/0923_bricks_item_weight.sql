-- Bricks weigh 10 g each, matching packages/shared/src/inventoryWeight.ts.
-- 0917 inserted them with the 250 g column default, which fails the item
-- catalog check at boot.
UPDATE item_definitions
SET unit_weight_grams = 10,
    updated_at = now()
WHERE item_id = 'bricks'
  AND unit_weight_grams IS DISTINCT FROM 10;
