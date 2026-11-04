ALTER TABLE world_item_drops
  ADD COLUMN IF NOT EXISTS zone_id text NULL,
  ADD COLUMN IF NOT EXISTS pile_id text NULL,
  ADD COLUMN IF NOT EXISTS pile_order integer NULL;

UPDATE world_item_drops
SET zone_id = 'world:' || region_code,
    pile_id = 'drop:' || id::text,
    pile_order = 0
WHERE zone_id IS NULL OR pile_id IS NULL OR pile_order IS NULL;

SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE world_item_drops
  ALTER COLUMN zone_id SET NOT NULL,
  ALTER COLUMN pile_id SET NOT NULL,
  ALTER COLUMN pile_order SET NOT NULL,
  ADD CONSTRAINT world_item_drops_zone_id_nonempty CHECK (zone_id <> ''),
  ADD CONSTRAINT world_item_drops_pile_id_nonempty CHECK (pile_id <> ''),
  ADD CONSTRAINT world_item_drops_pile_order_nonnegative CHECK (pile_order >= 0);

CREATE INDEX IF NOT EXISTS world_item_drops_active_zone_pile_idx
  ON world_item_drops (zone_id, pile_id, pile_order, created_at, id)
  WHERE status = 'active';
