-- Stack capacity is durable item metadata. Existing oversized stacks are
-- grandfathered: they may remain or shrink, but may never grow above policy.

UPDATE item_definitions AS item
SET max_stack = policy.max_stack,
    stackable = policy.stackable,
    updated_at = now()
FROM (VALUES
  ('wood', 500, true),
  ('stone', 250, true),
  ('coal', 250, true),
  ('iron', 250, true),
  ('ore', 250, true),
  ('iron_bar', 50, true),
  ('venomsteel_bar', 50, true),
  ('venomsteel_core', 1, false),
  ('leather', 500, true),
  ('deer_hide', 125, true),
  ('hog_hide', 125, true),
  ('wolf_pelt', 125, true),
  ('bear_hide', 125, true),
  ('alligator_hide', 125, true),
  ('squid_flesh', 125, true),
  ('crab_carapace', 125, true),
  ('raw_meat', 500, true),
  ('shell', 500, true),
  ('balsam_resin', 100, true),
  ('crude_oil', 250, true),
  ('jellyfish_venom', 25, true),
  ('atlas_shrine_shard', 25, true),
  ('enchantment_stone', 1, false)
) AS policy(item_id, max_stack, stackable)
WHERE item.item_id = policy.item_id;

CREATE OR REPLACE FUNCTION validate_grandfathered_item_stack()
RETURNS trigger AS $$
DECLARE
  maximum_stack bigint;
  new_item_id text;
  old_item_id text;
BEGIN
  new_item_id := COALESCE(to_jsonb(NEW)->>'item_id', to_jsonb(NEW)->>'resource_type');
  IF TG_OP = 'UPDATE' THEN
    old_item_id := COALESCE(to_jsonb(OLD)->>'item_id', to_jsonb(OLD)->>'resource_type');
  END IF;
  SELECT max_stack::bigint
  INTO maximum_stack
  FROM item_definitions
  WHERE item_id = new_item_id;

  IF maximum_stack IS NULL THEN
    RAISE EXCEPTION 'Item stack has no max_stack policy'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.quantity > maximum_stack AND (
    TG_OP = 'INSERT'
    OR new_item_id IS DISTINCT FROM old_item_id
    OR NEW.quantity > OLD.quantity
  ) THEN
    RAISE EXCEPTION 'Item stack exceeds max_stack'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS manor_storage_stack_maximum ON manor_storage_stacks;
DROP FUNCTION IF EXISTS validate_manor_storage_stack();
CREATE TRIGGER manor_storage_stack_maximum
BEFORE INSERT OR UPDATE OF item_id, quantity ON manor_storage_stacks
FOR EACH ROW EXECUTE FUNCTION validate_grandfathered_item_stack();

CREATE TRIGGER player_inventory_stack_maximum
BEFORE INSERT OR UPDATE OF resource_type, quantity ON player_inventory_slots
FOR EACH ROW EXECUTE FUNCTION validate_grandfathered_item_stack();

CREATE TRIGGER city_warehouse_stack_maximum
BEFORE INSERT OR UPDATE OF item_id, quantity ON city_warehouse_stacks
FOR EACH ROW EXECUTE FUNCTION validate_grandfathered_item_stack();
