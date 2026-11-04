-- Dungeon token items are rare, matching packages/shared/src/inventoryCatalog.ts.
-- 0900-0903 inserted them with the column default ('common'), which fails the item catalog check at boot.
UPDATE item_definitions
SET rarity = 'rare',
    updated_at = now()
WHERE item_id IN ('brood_silk', 'raptor_scale', 'giant_egg', 'elder_acorn');
