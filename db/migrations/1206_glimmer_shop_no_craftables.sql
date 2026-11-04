-- Owner rule (2026-10-06): nothing craftable is sold in the Glimmer Shop. A weapon/armour row is either
-- craftable and not sold ('craft') or sold and not craftable ('shop'); the old 'both' option is gone.
-- Rows that were 'both' fall back to 'craft' (recipe kept, not sold) until the owner picks 'shop'.
UPDATE glimmer_shop_catalog SET source = 'craft', updated_at = now() WHERE source = 'both';

ALTER TABLE glimmer_shop_catalog DROP CONSTRAINT IF EXISTS glimmer_shop_catalog_source_check;
ALTER TABLE glimmer_shop_catalog DROP CONSTRAINT IF EXISTS glimmer_shop_catalog_source_no_craftables;
ALTER TABLE glimmer_shop_catalog ADD CONSTRAINT glimmer_shop_catalog_source_no_craftables
  CHECK (source IS NULL OR source IN ('craft', 'shop'));
