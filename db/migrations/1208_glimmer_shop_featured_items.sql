-- Owner feedback (2026-10-07): the Featured tab lists every featured item below the carousel; the two
-- manor skins and the two masks start out featured.
UPDATE glimmer_shop_catalog SET featured = true, updated_at = now()
WHERE kind IN ('manor_skin', 'mask') AND featured = false;
