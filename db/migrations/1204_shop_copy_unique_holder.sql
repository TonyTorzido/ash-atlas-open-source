-- A tagged copy (face_mask / manor_skin, 1202) is held by at most one player at a time: the copy
-- id may appear on only one live inventory row. Every move debits the old holder before the new
-- holder is credited (market escrow, gifts, drops, warehouses), so this never blocks a real move;
-- it stops any path that would duplicate a copy.
CREATE UNIQUE INDEX IF NOT EXISTS player_inventory_shop_copy_single_holder
  ON player_inventory (variant)
  WHERE resource_type IN ('face_mask', 'manor_skin') AND quantity > 0;
