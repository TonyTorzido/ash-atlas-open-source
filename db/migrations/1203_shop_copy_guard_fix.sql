-- Fix forward for 1202: the per-copy row guard referenced NEW.item_id on player_inventory (which
-- names the item resource_type), so every face_mask / manor_skin inventory write failed. Read the
-- item column per table through the row's JSON instead.
CREATE OR REPLACE FUNCTION enforce_shop_copy_row() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  item_value text := COALESCE(to_jsonb(NEW)->>'resource_type', to_jsonb(NEW)->>'item_id');
BEGIN
  -- Legacy look stacks (emptied by 1202) may stay at zero.
  IF NEW.quantity = 0 THEN
    RETURN NEW;
  END IF;
  IF NEW.quantity > 1 THEN
    RAISE EXCEPTION 'A tagged copy is one item and cannot stack.'
      USING ERRCODE = '23514', CONSTRAINT = 'shop_copy_single_unit';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM shop_item_copies WHERE copy_id = NEW.variant AND item_id = item_value) THEN
    RAISE EXCEPTION 'That copy does not exist.'
      USING ERRCODE = '23503', CONSTRAINT = 'shop_copy_known';
  END IF;
  RETURN NEW;
END $$;
