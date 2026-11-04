-- Owner feedback (2026-10-06): the shop sells only Hockey Mask and Kitsune Mask, and the Featured tab
-- rotates the newest items, so every catalog row records when it was added.
DELETE FROM glimmer_shop_catalog_audit
WHERE sku IN ('mask_oni', 'mask_rebel', 'mask_calavera');
DELETE FROM glimmer_shop_catalog
WHERE sku IN ('mask_oni', 'mask_rebel', 'mask_calavera');

ALTER TABLE glimmer_shop_catalog ADD COLUMN IF NOT EXISTS added_at timestamptz NOT NULL DEFAULT now();

-- Existing rows: the swag weapons are oldest, then the two masks, then the two manor skins (newest).
UPDATE glimmer_shop_catalog SET added_at = timestamptz '2026-09-01 00:00:00+00' WHERE kind IN ('weapon', 'armour');
UPDATE glimmer_shop_catalog SET added_at = timestamptz '2026-10-06 12:00:00+00' WHERE kind = 'mask';
UPDATE glimmer_shop_catalog SET added_at = timestamptz '2026-10-06 13:00:00+00'
WHERE sku = 'manor_skin_samurai';
UPDATE glimmer_shop_catalog SET added_at = timestamptz '2026-10-06 14:00:00+00'
WHERE sku = 'manor_skin_haunted';
