-- Manor skins are equipment: the skin item stays in the owner's inventory and
-- player_manors.manor_type_id is the skin equipped from it (the default timber
-- type needs no item). Under 1082 installing moved the item out of the
-- inventory into the Manor; give each such skin back to its owner and keep it
-- equipped. The database then guarantees "equipped => owned": an equipped skin
-- can never leave the inventory (drop, trade, market, gift, storage, any
-- future path) and a Manor can only switch to a skin its owner holds.
SET CONSTRAINTS ALL DEFERRED;

LOCK TABLE player_manors, player_inventory, inventory_operations, inventory_events
  IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  migration_now timestamptz := clock_timestamp();
  manor_row record;
  stack_row record;
  operation_key_value text;
  skin_weight numeric;
  current_weight numeric;
  maximum_weight numeric;
  baselines jsonb;
BEGIN
  SELECT unit_weight_grams::numeric INTO skin_weight FROM item_definitions WHERE item_id = 'manor_skin';
  FOR manor_row IN
    SELECT manor.id::text AS manor_id, manor.owner_player_id, manor.manor_type_id
    FROM player_manors manor
    JOIN players player ON player.id = manor.owner_player_id
    WHERE manor.manor_type_id <> 'manor_lobby'
    ORDER BY manor.owner_player_id
  LOOP
    operation_key_value := 'migration:1083:manor-skin-return:' || manor_row.manor_id;
    INSERT INTO inventory_operations (
      operation_key, player_id, source, source_entity_type, source_entity_id, metadata
    ) VALUES (
      operation_key_value, manor_row.owner_player_id, 'manor_skin_equip_migration',
      'player_manor', manor_row.manor_id,
      jsonb_build_object('manorTypeId', manor_row.manor_type_id, 'migration', '1083')
    ) ON CONFLICT (operation_key) DO NOTHING;
    IF EXISTS (SELECT 1 FROM inventory_events WHERE operation_key = operation_key_value) THEN
      CONTINUE;
    END IF;

    -- The returned skin must never be lost to a full inventory: record the
    -- pre-grant carry baseline as already over capacity when the skin does
    -- not fit, which the carry guard honours as allowed over-capacity (the
    -- owner can carry it but cannot add more until they make room).
    current_weight := player_inventory_weight_grams(manor_row.owner_player_id);
    maximum_weight := player_inventory_maximum_grams(manor_row.owner_player_id);
    IF current_weight + COALESCE(skin_weight, 0) > maximum_weight THEN
      baselines := COALESCE(NULLIF(current_setting('ash_atlas.carry_baselines', true), '')::jsonb, '{}'::jsonb);
      baselines := baselines || jsonb_build_object(manor_row.owner_player_id, jsonb_build_object(
        'weight', (current_weight + skin_weight)::text,
        'maximum', maximum_weight::text));
      PERFORM set_config('ash_atlas.carry_baselines', baselines::text, true);
    END IF;

    INSERT INTO player_inventory (player_id, resource_type, variant, quantity, version, updated_at)
    VALUES (manor_row.owner_player_id, 'manor_skin', manor_row.manor_type_id, 0, 0, migration_now)
    ON CONFLICT (player_id, resource_type, variant) DO NOTHING;

    UPDATE player_inventory
    SET quantity = quantity + 1,
        version = COALESCE(version, 0) + 1,
        updated_at = migration_now
    WHERE player_id = manor_row.owner_player_id
      AND resource_type = 'manor_skin'
      AND variant = manor_row.manor_type_id
    RETURNING quantity::bigint, version::bigint INTO stack_row;

    INSERT INTO inventory_events (
      operation_key, player_id, item_id, variant, delta_quantity,
      quantity_after, version_after, source, source_entity_type,
      source_entity_id, metadata
    ) VALUES (
      operation_key_value, manor_row.owner_player_id, 'manor_skin', manor_row.manor_type_id, 1,
      stack_row.quantity, stack_row.version, 'manor_skin_equip_migration',
      'player_manor', manor_row.manor_id,
      jsonb_build_object('manorTypeId', manor_row.manor_type_id, 'migration', '1083')
    );
  END LOOP;
END $$;

-- "Equipped => owned", checked at commit under one per-owner lock so an equip
-- and a removal of the same skin serialize: whichever commits second re-reads
-- the other's committed state and is refused.
CREATE OR REPLACE FUNCTION enforce_manor_skin_equipped_owned() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  owner_id text;
  removed_variant text;
  equipped text;
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
  SELECT manor_type_id INTO equipped FROM player_manors WHERE owner_player_id = owner_id;
  IF equipped IS NULL OR equipped = 'manor_lobby' THEN
    RETURN NULL;
  END IF;
  IF removed_variant IS NOT NULL AND removed_variant <> equipped THEN
    RETURN NULL;
  END IF;
  SELECT COALESCE(sum(quantity), 0) INTO held
  FROM player_inventory
  WHERE player_id = owner_id AND resource_type = 'manor_skin' AND variant = equipped;
  IF held < 1 THEN
    RAISE EXCEPTION 'That Manor skin is equipped on your Manor. Unequip it first.'
      USING ERRCODE = '23514', CONSTRAINT = 'player_manor_skin_equipped';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS player_inventory_manor_skin_equipped_guard ON player_inventory;
CREATE CONSTRAINT TRIGGER player_inventory_manor_skin_equipped_guard
AFTER UPDATE OR DELETE ON player_inventory
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (OLD.resource_type = 'manor_skin')
EXECUTE FUNCTION enforce_manor_skin_equipped_owned();

DROP TRIGGER IF EXISTS player_manors_skin_equipped_guard ON player_manors;
CREATE CONSTRAINT TRIGGER player_manors_skin_equipped_guard
AFTER INSERT OR UPDATE OF manor_type_id ON player_manors
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW.manor_type_id <> 'manor_lobby')
EXECUTE FUNCTION enforce_manor_skin_equipped_owned();

-- Skin requests record equips/unequips under the existing 'install' action.
COMMENT ON TABLE manor_skin_operations IS
  'Replay record of Manor skin purchases and equips (action install: manor_type_id is the skin equipped, manor_lobby = unequip).';
