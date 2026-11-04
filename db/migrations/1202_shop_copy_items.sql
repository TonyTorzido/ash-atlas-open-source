-- Masks and Manor skins become per-copy items (docs/design/GLIMMER_SHOP.md, "Provenance tags").
-- The inventory variant of a face_mask / manor_skin is now its copy id (shop_item_copies.copy_id),
-- never its look, so tagged copies never merge into an anonymous stack and every existing move
-- (market, gifts, drops, storage) carries the exact copy. Equipping names a copy: the Manor keeps
-- skin_copy_id, the player keeps mask_copy_id; that copy stays locked in the inventory.
-- Existing look-variant stacks in player inventories are converted into copies with fresh random
-- tags (original buyer = current holder); the old stack is emptied through the inventory event
-- chain. Look-variant stacks anywhere else stop the migration (server reset planned; resolve by
-- hand). Forward-only and idempotent: a rerun finds nothing left to convert.
SET CONSTRAINTS ALL DEFERRED;

ALTER TABLE shop_item_copies
  ADD COLUMN IF NOT EXISTS display_name text NULL CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 80);

ALTER TABLE players ADD COLUMN IF NOT EXISTS mask_copy_id text NULL;
ALTER TABLE player_manors ADD COLUMN IF NOT EXISTS skin_copy_id text NULL;

-- Copies are exact instances: one market book per copy (like Fishing Rods), never fungible.
UPDATE item_definitions SET market_fungible = false, updated_at = now()
WHERE item_id IN ('face_mask', 'manor_skin') AND market_fungible;

-- Look-variant copies outside inventories and Manor storage cannot be converted safely in SQL.
DO $$
DECLARE
  stranded bigint;
BEGIN
  SELECT
    (SELECT count(*) FROM world_item_drops
      WHERE item_id IN ('face_mask', 'manor_skin') AND status = 'active'
        AND variant !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    + (SELECT count(*) FROM market_order_escrows
      WHERE item_id IN ('face_mask', 'manor_skin') AND remaining_amount > 0
        AND variant !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    + (SELECT count(*) FROM player_package_items item
      JOIN player_packages package ON package.id = item.package_id
      WHERE item.canonical_item_id IN ('face_mask', 'manor_skin') AND package.status <> 'claimed'
        AND COALESCE(item.variant, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    + (SELECT count(*) FROM city_warehouse_stacks
      WHERE item_id IN ('face_mask', 'manor_skin')
        AND variant !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    + (SELECT count(*) FROM manor_storage_stacks
      WHERE item_id IN ('face_mask', 'manor_skin') AND quantity > 0)
  INTO stranded;
  IF stranded > 0 THEN
    RAISE EXCEPTION '1202: % mask/skin stack(s) are on the ground, in market escrow, unclaimed packages or storage; resolve them before converting to per-copy items', stranded;
  END IF;
END $$;

LOCK TABLE player_inventory, inventory_operations, inventory_events IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  stack record;
  copy_value text;
  tag_value text;
  operation_key_value text;
  migration_now timestamptz := clock_timestamp();
  copy_name text;
  first_copy text;
BEGIN
  FOR stack IN
    SELECT inventory.player_id, inventory.resource_type, inventory.variant, inventory.quantity,
           COALESCE(inventory.version, 0) AS version, player.username
    FROM player_inventory inventory
    JOIN players player ON player.id = inventory.player_id
    WHERE inventory.resource_type IN ('face_mask', 'manor_skin') AND inventory.quantity > 0
      AND inventory.variant !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ORDER BY inventory.player_id, inventory.resource_type, inventory.variant
  LOOP
    operation_key_value := 'migration:1202:copies:' || stack.player_id || ':' || stack.resource_type || ':' || stack.variant;
    INSERT INTO inventory_operations (operation_key, player_id, source, source_entity_type, source_entity_id, metadata)
    VALUES (operation_key_value, stack.player_id, 'shop_copy_migration', 'inventory_stack',
            stack.resource_type || ':' || stack.variant, jsonb_build_object('migration', '1202'))
    ON CONFLICT (operation_key) DO NOTHING;
    copy_name := CASE stack.resource_type
      WHEN 'face_mask' THEN CASE stack.variant
        WHEN 'mask-1' THEN 'Oni Mask' WHEN 'mask-2' THEN 'Rebel Mask' WHEN 'mask-3' THEN 'Calavera Mask'
        WHEN 'hockey-mask' THEN 'Hockey Mask' WHEN 'kitsune-mask' THEN 'Kitsune Mask' ELSE 'Mask' END
      ELSE initcap(replace(stack.variant, '_', ' ')) || ' Skin' END;
    first_copy := NULL;
    FOR unit IN 1..stack.quantity LOOP
      copy_value := gen_random_uuid()::text;
      LOOP
        tag_value := shop_copy_random_tag();
        EXIT WHEN NOT EXISTS (SELECT 1 FROM shop_item_copies WHERE tag = tag_value);
      END LOOP;
      INSERT INTO shop_item_copies (copy_id, item_id, look, tag, original_buyer_player_id, original_buyer_name, display_name)
      VALUES (copy_value, stack.resource_type, stack.variant, tag_value, stack.player_id, left(stack.username, 80), copy_name);
      INSERT INTO player_inventory (player_id, resource_type, variant, quantity, version, updated_at)
      VALUES (stack.player_id, stack.resource_type, copy_value, 1, 1, migration_now);
      INSERT INTO inventory_events (operation_key, player_id, item_id, variant, delta_quantity, quantity_after,
        version_after, source, source_entity_type, source_entity_id, metadata)
      VALUES (operation_key_value, stack.player_id, stack.resource_type, copy_value, 1, 1, 1,
        'shop_copy_migration', 'inventory_stack', stack.resource_type || ':' || stack.variant,
        jsonb_build_object('migration', '1202', 'look', stack.variant));
      first_copy := COALESCE(first_copy, copy_value);
    END LOOP;
    -- Keep what was equipped equipped, now on a named copy.
    IF stack.resource_type = 'manor_skin' THEN
      UPDATE player_manors SET skin_copy_id = first_copy
      WHERE owner_player_id = stack.player_id AND manor_type_id = stack.variant AND skin_copy_id IS NULL;
    ELSE
      UPDATE players SET mask_copy_id = first_copy
      WHERE id = stack.player_id AND mask_appearance_id = stack.variant AND mask_copy_id IS NULL;
    END IF;
    -- Empty the old look stack through the event chain (rows are never deleted).
    UPDATE player_inventory
    SET quantity = 0, version = stack.version + 1, updated_at = migration_now
    WHERE player_id = stack.player_id AND resource_type = stack.resource_type AND variant = stack.variant;
    INSERT INTO inventory_events (operation_key, player_id, item_id, variant, delta_quantity, quantity_after,
      version_after, source, source_entity_type, source_entity_id, metadata)
    VALUES (operation_key_value, stack.player_id, stack.resource_type, stack.variant, -stack.quantity, 0,
      stack.version + 1, 'shop_copy_migration', 'inventory_stack',
      stack.resource_type || ':' || stack.variant, jsonb_build_object('migration', '1202'));
  END LOOP;
END $$;

-- A per-copy row must name an existing copy of the same item, one unit per row.
CREATE OR REPLACE FUNCTION enforce_shop_copy_row() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  item_value text := CASE WHEN TG_TABLE_NAME = 'player_inventory' THEN NEW.resource_type ELSE NEW.item_id END;
BEGIN
  -- Legacy look stacks (emptied by this migration) may stay at zero.
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

DROP TRIGGER IF EXISTS player_inventory_shop_copy_guard ON player_inventory;
CREATE TRIGGER player_inventory_shop_copy_guard
BEFORE INSERT OR UPDATE ON player_inventory
FOR EACH ROW WHEN (NEW.resource_type IN ('face_mask', 'manor_skin'))
EXECUTE FUNCTION enforce_shop_copy_row();

DROP TRIGGER IF EXISTS city_warehouse_shop_copy_guard ON city_warehouse_stacks;
CREATE TRIGGER city_warehouse_shop_copy_guard
BEFORE INSERT OR UPDATE ON city_warehouse_stacks
FOR EACH ROW WHEN (NEW.item_id IN ('face_mask', 'manor_skin'))
EXECUTE FUNCTION enforce_shop_copy_row();

-- "Worn => owned" now names the copy (replaces the 1200 look-based check).
CREATE OR REPLACE FUNCTION enforce_face_mask_worn_owned() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  owner_id text;
  removed_variant text;
  worn_copy text;
  worn_look text;
  copy_look text;
  held bigint;
BEGIN
  IF TG_TABLE_NAME = 'players' THEN
    owner_id := NEW.id;
    removed_variant := NULL;
  ELSE
    owner_id := OLD.player_id;
    removed_variant := OLD.variant;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('face-mask-worn:' || owner_id, 1200));
  SELECT mask_copy_id, mask_appearance_id INTO worn_copy, worn_look FROM players WHERE id = owner_id;
  IF worn_look IS NULL AND worn_copy IS NULL THEN
    RETURN NULL;
  END IF;
  IF removed_variant IS NOT NULL AND removed_variant IS DISTINCT FROM worn_copy THEN
    RETURN NULL;
  END IF;
  SELECT look INTO copy_look FROM shop_item_copies WHERE copy_id = worn_copy AND item_id = 'face_mask';
  SELECT COALESCE(sum(quantity), 0) INTO held
  FROM player_inventory
  WHERE player_id = owner_id AND resource_type = 'face_mask' AND variant = worn_copy;
  IF held < 1 OR copy_look IS DISTINCT FROM worn_look THEN
    RAISE EXCEPTION 'That mask is being worn. Take it off first.'
      USING ERRCODE = '23514', CONSTRAINT = 'player_face_mask_worn';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS players_face_mask_worn_guard ON players;
CREATE CONSTRAINT TRIGGER players_face_mask_worn_guard
AFTER INSERT OR UPDATE OF mask_appearance_id, mask_copy_id ON players
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW.mask_appearance_id IS NOT NULL OR NEW.mask_copy_id IS NOT NULL)
EXECUTE FUNCTION enforce_face_mask_worn_owned();

-- "Equipped => owned" for Manor skins now names the copy (replaces the 1083 look-based check).
CREATE OR REPLACE FUNCTION enforce_manor_skin_equipped_owned() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  owner_id text;
  removed_variant text;
  equipped text;
  equipped_copy text;
  copy_look text;
  held bigint;
BEGIN
  IF TG_TABLE_NAME = 'player_manors' THEN
    owner_id := NEW.owner_player_id;
    removed_variant := NULL;
  ELSE
    owner_id := OLD.player_id;
    removed_variant := OLD.variant;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('manor-skin-equip:' || owner_id, 1083));
  SELECT manor_type_id, skin_copy_id INTO equipped, equipped_copy FROM player_manors WHERE owner_player_id = owner_id;
  IF equipped IS NULL OR (equipped = 'manor_lobby' AND equipped_copy IS NULL) THEN
    RETURN NULL;
  END IF;
  IF removed_variant IS NOT NULL AND removed_variant IS DISTINCT FROM equipped_copy THEN
    RETURN NULL;
  END IF;
  SELECT look INTO copy_look FROM shop_item_copies WHERE copy_id = equipped_copy AND item_id = 'manor_skin';
  SELECT COALESCE(sum(quantity), 0) INTO held
  FROM player_inventory
  WHERE player_id = owner_id AND resource_type = 'manor_skin' AND variant = equipped_copy;
  IF held < 1 OR copy_look IS DISTINCT FROM equipped THEN
    RAISE EXCEPTION 'That Manor skin is equipped on your Manor. Unequip it first.'
      USING ERRCODE = '23514', CONSTRAINT = 'player_manor_skin_equipped';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS player_manors_skin_equipped_guard ON player_manors;
CREATE CONSTRAINT TRIGGER player_manors_skin_equipped_guard
AFTER INSERT OR UPDATE OF manor_type_id, skin_copy_id ON player_manors
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW.manor_type_id <> 'manor_lobby' OR NEW.skin_copy_id IS NOT NULL)
EXECUTE FUNCTION enforce_manor_skin_equipped_owned();
