-- Dungeon token items are light (10 g), matching packages/shared/src/inventoryWeight.ts.
-- 0900-0903 inserted them with the 250 g column default, which fails the item catalog check at boot.
UPDATE item_definitions
SET unit_weight_grams = 10,
    updated_at = now()
WHERE item_id IN ('brood_silk', 'raptor_scale', 'giant_egg', 'elder_acorn');
