-- The shared carry/backpack catalog is compiled into this immutable migration.
-- Startup verifies every live item and level against that same shared catalog.
-- Player inventory is now its existing quantity ledger; the old grid is retained
-- as archival data only. No quantities, item variants, or instance IDs are replaced.
LOCK TABLE player_inventory,player_inventory_slots,player_inventory_capacities,
  equipment_instances,player_backpack_instances IN ACCESS EXCLUSIVE MODE;
SET CONSTRAINTS ALL IMMEDIATE;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM player_inventory inventory
    FULL JOIN (
      SELECT player_id,resource_type,variant,sum(quantity) AS quantity
      FROM player_inventory_slots GROUP BY player_id,resource_type,variant
    ) slots USING (player_id,resource_type,variant)
    WHERE COALESCE(inventory.quantity,0)<>COALESCE(slots.quantity,0)
  ) THEN
    RAISE EXCEPTION 'Carry migration refused mismatched inventory balances and slot quantities; reconcile retained records before retrying';
  END IF;
END $$;

ALTER TABLE item_definitions ADD COLUMN unit_weight_grams integer NOT NULL DEFAULT 250
  CHECK(unit_weight_grams>0);
UPDATE item_definitions item SET unit_weight_grams=weight.grams
FROM (VALUES
  ('wood',100),
  ('stone',250),
  ('coal',200),
  ('iron',250),
  ('sulfur',200),
  ('slag',250),
  ('iron_bar',500),
  ('venomsteel_bar',500),
  ('venomsteel_core',250),
  ('fire_feather',10),
  ('tempest_quill',10),
  ('ice_feather',10),
  ('fire_bar',500),
  ('fire_core',250),
  ('lightning_bar',500),
  ('lightning_core',250),
  ('ice_bar',500),
  ('ice_core',250),
  ('food',250),
  ('simple_food',250),
  ('ore',250),
  ('water',250),
  ('flax_fiber',25),
  ('cloth',100),
  ('leather',100),
  ('deer_hide',500),
  ('hog_hide',500),
  ('wolf_pelt',500),
  ('bear_hide',1000),
  ('alligator_hide',1000),
  ('squid_flesh',250),
  ('squid_meat',250),
  ('deer_meat',250),
  ('wolf_meat',250),
  ('hog_meat',250),
  ('bear_meat',250),
  ('alligator_meat',250),
  ('wild_meat',250),
  ('crab_carapace',100),
  ('raw_meat',250),
  ('shell',25),
  ('chitin',25),
  ('balsam_resin',25),
  ('repair_kit',500),
  ('torch',200),
  ('crude_oil',250),
  ('jellyfish_venom',10),
  ('atlas_shrine_shard',50),
  ('enchantment_stone',50),
  ('frog_legs',250),
  ('crab_meat',250),
  ('small_catch',250),
  ('jellyfish_jelly',250),
  ('crawler_flesh',250),
  ('squid_cut',250),
  ('wolf_cut',250),
  ('deer_cut',250),
  ('hog_cut',250),
  ('alligator_tail',250),
  ('bear_cut',250),
  ('elemental_ration',250),
  ('scorching_bird_meat',250),
  ('zappy_bird_meat',250),
  ('freezing_bird_meat',250),
  ('field_ration',250),
  ('hearty_ration',250),
  ('xoral_essence',250),
  ('starter_sword',1500),
  ('god_sword',1500),
  ('starter_bow',1500),
  ('starter_staff',1500),
  ('starter_shuriken',1500),
  ('starter_wand',1500),
  ('padded_tunic',1500),
  ('chain_armor',1500),
  ('training_axe',1500),
  ('training_heavy_helm',1500),
  ('training_heavy_chest',1500),
  ('training_heavy_gloves',1500),
  ('training_heavy_boots',1500),
  ('training_light_hood',1500),
  ('training_light_gloves',1500),
  ('training_light_boots',1500),
  ('training_ring',50),
  ('chopping_ring',50),
  ('mining_ring',50),
  ('attack_ring',50),
  ('training_shield',1500),
  ('ranged_shield',1500),
  ('double_axe',1500),
  ('breast_plate',1500),
  ('hammer',1500),
  ('leather_armor',1500),
  ('cloth-armor-grey',1500),
  ('leather-armor-',1500),
  ('breastplate-armor',1500)
) AS weight(item_id,grams) WHERE item.item_id=weight.item_id;

CREATE TABLE backpack_level_definitions (
  level smallint PRIMARY KEY CHECK(level BETWEEN 0 AND 10),
  capacity_bonus_grams bigint NOT NULL CHECK(capacity_bonus_grams>=0),
  leather_cost bigint NOT NULL CHECK(leather_cost>=0),
  gold_cost bigint NOT NULL CHECK(gold_cost>=0),
  effects jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(effects)='object')
);
INSERT INTO backpack_level_definitions VALUES
  (0,2500,50,100,'{}'::jsonb),
  (1,7500,100,500,'{}'::jsonb),
  (2,17500,250,1000,'{}'::jsonb),
  (3,37500,500,5000,'{}'::jsonb),
  (4,60000,750,10000,'{}'::jsonb),
  (5,85000,1000,20000,'{}'::jsonb),
  (6,115000,1500,35000,'{}'::jsonb),
  (7,150000,2000,55000,'{}'::jsonb),
  (8,190000,3000,80000,'{}'::jsonb),
  (9,235000,4000,120000,'{}'::jsonb),
  (10,285000,5000,175000,'{}'::jsonb);
CREATE TABLE inventory_carry_rules (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  default_base_capacity_grams bigint NOT NULL CHECK(default_base_capacity_grams>0),
  backpack_unit_weight_grams integer NOT NULL CHECK(backpack_unit_weight_grams>0)
);
INSERT INTO inventory_carry_rules VALUES(true,100000,1000);

ALTER TABLE player_inventory_capacities
  ADD COLUMN base_capacity_grams bigint NOT NULL DEFAULT 100000
    CHECK(base_capacity_grams>0 AND base_capacity_grams<=9007199253600991);
UPDATE player_inventory_capacities
SET base_capacity_grams=GREATEST(100000,base_slots::bigint*2500);

ALTER TABLE player_backpack_instances ADD COLUMN upgrade_level smallint NOT NULL DEFAULT 0
  REFERENCES backpack_level_definitions(level);
UPDATE player_backpack_instances SET upgrade_level=CASE definition_id
  WHEN 'starter_backpack' THEN 0 WHEN 'traveler_backpack' THEN 1
  WHEN 'explorer_backpack' THEN 2 WHEN 'trailblazer_backpack' THEN 3 END;

ALTER TABLE player_inventory ADD COLUMN entry_id uuid;
UPDATE player_inventory inventory SET entry_id=COALESCE((
  SELECT stack_id FROM player_inventory_slots slots
  WHERE slots.player_id=inventory.player_id AND slots.resource_type=inventory.resource_type
    AND slots.variant=inventory.variant ORDER BY slots.slot_index,slots.stack_id LIMIT 1
),gen_random_uuid());
ALTER TABLE player_inventory ALTER COLUMN entry_id SET DEFAULT gen_random_uuid(),
  ALTER COLUMN entry_id SET NOT NULL;
CREATE UNIQUE INDEX player_inventory_entry_id_idx ON player_inventory(entry_id);

DROP TRIGGER player_inventory_slots_sync ON player_inventory;
DROP TRIGGER player_inventory_slots_advance_revision ON player_inventory_slots;
DROP TRIGGER player_inventory_stack_maximum ON player_inventory_slots;
DROP TRIGGER player_inventory_slots_avoid_equipment ON player_inventory_slots;
DROP FUNCTION sync_player_inventory_slots();
DROP FUNCTION keep_resource_slot_clear_of_equipment();
ALTER TABLE player_inventory_slots RENAME TO legacy_player_inventory_slots;
COMMENT ON TABLE legacy_player_inventory_slots IS
  'Read-only migration archive. Runtime inventory uses player_inventory balances; no capacity/stack mechanics apply here.';
CREATE FUNCTION reject_legacy_inventory_grid_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM players WHERE id=OLD.player_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Legacy inventory grid is archival; mutate player_inventory quantity balances';
END $$;
CREATE TRIGGER legacy_inventory_grid_read_only BEFORE INSERT OR UPDATE OR DELETE
ON legacy_player_inventory_slots FOR EACH ROW EXECUTE FUNCTION reject_legacy_inventory_grid_write();

ALTER TABLE equipment_instances DROP CONSTRAINT equipment_instances_location_fields_check;
UPDATE equipment_instances SET inventory_slot_index=NULL WHERE inventory_slot_index IS NOT NULL;
ALTER TABLE equipment_instances ADD CONSTRAINT equipment_instances_location_fields_check CHECK (
  inventory_slot_index IS NULL AND (
    (location='equipped' AND equipped_slot IS NOT NULL AND manor_id IS NULL AND manor_slot_index IS NULL
      AND market_listing_id IS NULL AND market_collection_id IS NULL)
    OR (location='inventory' AND equipped_slot IS NULL AND manor_id IS NULL AND manor_slot_index IS NULL
      AND market_listing_id IS NULL AND market_collection_id IS NULL)
    OR (location='manor_storage' AND equipped_slot IS NULL AND manor_id IS NOT NULL AND manor_slot_index IS NOT NULL
      AND market_listing_id IS NULL AND market_collection_id IS NULL)
    OR (location='market_escrow' AND equipped_slot IS NULL AND manor_id IS NULL AND manor_slot_index IS NULL
      AND market_listing_id IS NOT NULL AND market_collection_id IS NULL)
    OR (location='market_collection' AND equipped_slot IS NULL AND manor_id IS NULL AND manor_slot_index IS NULL
      AND market_listing_id IS NOT NULL AND market_collection_id IS NOT NULL)
    OR (location IN ('world_drop','destroyed') AND equipped_slot IS NULL AND manor_id IS NULL AND manor_slot_index IS NULL
      AND market_listing_id IS NULL AND market_collection_id IS NULL)
  )
);
ALTER TABLE player_backpack_instances DROP CONSTRAINT player_backpack_instances_location_check;
UPDATE player_backpack_instances SET inventory_slot_index=NULL WHERE inventory_slot_index IS NOT NULL;
ALTER TABLE player_backpack_instances ADD CONSTRAINT player_backpack_instances_location_check CHECK (
  inventory_slot_index IS NULL AND (
    (location='inventory' AND equipped_slot IS NULL AND manor_id IS NULL AND manor_slot_index IS NULL)
    OR (location='equipped' AND equipped_slot BETWEEN 0 AND 3 AND manor_id IS NULL AND manor_slot_index IS NULL)
    OR (location='manor_storage' AND equipped_slot IS NULL AND manor_id IS NOT NULL AND manor_slot_index BETWEEN 0 AND 59)
    OR (location='destroyed' AND equipped_slot IS NULL AND manor_id IS NULL AND manor_slot_index IS NULL)
  )
);
DROP INDEX equipment_instances_inventory_slot_idx;
DROP INDEX player_backpack_inventory_slot_idx;

-- numeric aggregation is intentional: safe protocol quantities multiplied by grams
-- can exceed bigint and Number.MAX_SAFE_INTEGER without losing precision.
CREATE FUNCTION player_inventory_weight_grams(target_player_id text) RETURNS numeric
LANGUAGE sql VOLATILE AS $$
  SELECT COALESCE(sum(weight),0) FROM (
    SELECT inventory.quantity::numeric*definition.unit_weight_grams AS weight
    FROM player_inventory inventory JOIN item_definitions definition ON definition.item_id=inventory.resource_type
    WHERE inventory.player_id=target_player_id
    UNION ALL
    SELECT definition.unit_weight_grams::numeric
    FROM equipment_instances equipment JOIN item_definitions definition ON definition.item_id=equipment.definition_id
    WHERE equipment.owner_player_id=target_player_id AND equipment.location IN ('inventory','equipped')
    UNION ALL
    SELECT rules.backpack_unit_weight_grams::numeric
    FROM player_backpack_instances backpack CROSS JOIN inventory_carry_rules rules
    WHERE backpack.owner_player_id=target_player_id AND backpack.location IN ('inventory','equipped')
  ) carried;
$$;
CREATE FUNCTION player_inventory_maximum_grams(target_player_id text) RETURNS numeric
LANGUAGE sql VOLATILE AS $$
  SELECT capacity.base_capacity_grams::numeric+COALESCE((
    SELECT sum(level.capacity_bonus_grams) FROM player_backpack_instances backpack
    JOIN backpack_level_definitions level ON level.level=backpack.upgrade_level
    WHERE backpack.owner_player_id=target_player_id AND backpack.location='equipped'
  ),0) FROM player_inventory_capacities capacity WHERE capacity.player_id=target_player_id;
$$;

-- BEFORE every mutation, serialize ownership and remember the pre-transaction state.
-- The transaction-local baseline lets crafts spend inputs before adding outputs and
-- lets retained overweight players reduce their load without deleting their items.
CREATE FUNCTION lock_player_inventory_carry(target_player_id text) RETURNS numeric
LANGUAGE plpgsql VOLATILE AS $$
DECLARE baselines jsonb; maximum_grams numeric; BEGIN
  INSERT INTO player_inventory_capacities(player_id) VALUES(target_player_id)
    ON CONFLICT(player_id) DO NOTHING;
  PERFORM 1 FROM player_inventory_capacities WHERE player_id=target_player_id FOR UPDATE;
  maximum_grams:=player_inventory_maximum_grams(target_player_id);
  baselines:=COALESCE(NULLIF(current_setting('ash_atlas.carry_baselines',true),'')::jsonb,'{}'::jsonb);
  IF NOT baselines ? target_player_id THEN
    baselines:=baselines || jsonb_build_object(target_player_id,jsonb_build_object(
      'weight',player_inventory_weight_grams(target_player_id)::text,'maximum',maximum_grams::text));
    PERFORM set_config('ash_atlas.carry_baselines',baselines::text,true);
  END IF;
  RETURN maximum_grams;
END $$;
CREATE FUNCTION player_inventory_allowed_grams(target_player_id text) RETURNS numeric
LANGUAGE plpgsql VOLATILE AS $$
DECLARE baseline jsonb; maximum_grams numeric; BEGIN
  maximum_grams:=player_inventory_maximum_grams(target_player_id);
  baseline:=COALESCE(NULLIF(current_setting('ash_atlas.carry_baselines',true),'')::jsonb,'{}'::jsonb)->target_player_id;
  IF baseline IS NOT NULL AND (baseline->>'weight')::numeric>(baseline->>'maximum')::numeric
     AND maximum_grams>=(baseline->>'maximum')::numeric THEN
    RETURN GREATEST(maximum_grams,(baseline->>'weight')::numeric);
  END IF;
  RETURN maximum_grams;
END $$;

CREATE FUNCTION lock_inventory_carry_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous_player text; next_player text; target_player text; BEGIN
  IF TG_TABLE_NAME IN ('player_inventory','player_inventory_capacities') THEN
    previous_player:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE OLD.player_id END;
    next_player:=CASE WHEN TG_OP='DELETE' THEN NULL ELSE NEW.player_id END;
  ELSE
    previous_player:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE OLD.owner_player_id END;
    next_player:=CASE WHEN TG_OP='DELETE' THEN NULL ELSE NEW.owner_player_id END;
  END IF;
  FOR target_player IN SELECT DISTINCT player_id FROM unnest(ARRAY[previous_player,next_player]) player_id
    WHERE player_id IS NOT NULL ORDER BY player_id
  LOOP
    -- ON DELETE CASCADE may run after its player row was removed. Never recreate capacity for it.
    IF EXISTS(SELECT 1 FROM players WHERE id=target_player) THEN
      PERFORM lock_player_inventory_carry(target_player);
    END IF;
  END LOOP;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE FUNCTION validate_inventory_carry_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous_player text; next_player text; target_player text; actual_grams numeric; allowed_grams numeric; BEGIN
  IF TG_TABLE_NAME IN ('player_inventory','player_inventory_capacities') THEN
    previous_player:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE OLD.player_id END;
    next_player:=CASE WHEN TG_OP='DELETE' THEN NULL ELSE NEW.player_id END;
  ELSE
    previous_player:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE OLD.owner_player_id END;
    next_player:=CASE WHEN TG_OP='DELETE' THEN NULL ELSE NEW.owner_player_id END;
  END IF;
  FOR target_player IN SELECT DISTINCT player_id FROM unnest(ARRAY[previous_player,next_player]) player_id
    WHERE player_id IS NOT NULL ORDER BY player_id
  LOOP
    IF NOT EXISTS(SELECT 1 FROM players WHERE id=target_player) THEN CONTINUE; END IF;
    actual_grams:=player_inventory_weight_grams(target_player);
    allowed_grams:=player_inventory_allowed_grams(target_player);
    IF actual_grams>allowed_grams THEN
      RAISE EXCEPTION 'Inventory carrying capacity exceeded' USING ERRCODE='23514',
        CONSTRAINT='player_inventory_carry_capacity',
        DETAIL=jsonb_build_object('currentWeightGrams',actual_grams::text,
          'maximumWeightGrams',player_inventory_maximum_grams(target_player)::text)::text;
    END IF;
  END LOOP;
  RETURN NULL;
END $$;

CREATE TRIGGER player_inventory_carry_lock BEFORE INSERT OR UPDATE OR DELETE ON player_inventory
FOR EACH ROW EXECUTE FUNCTION lock_inventory_carry_mutation();
CREATE CONSTRAINT TRIGGER player_inventory_carry_guard AFTER INSERT OR UPDATE OR DELETE ON player_inventory
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_inventory_carry_mutation();
CREATE TRIGGER equipment_inventory_carry_lock BEFORE INSERT OR UPDATE OR DELETE ON equipment_instances
FOR EACH ROW EXECUTE FUNCTION lock_inventory_carry_mutation();
CREATE CONSTRAINT TRIGGER equipment_inventory_carry_guard AFTER INSERT OR UPDATE OR DELETE ON equipment_instances
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_inventory_carry_mutation();
CREATE TRIGGER backpack_inventory_carry_lock BEFORE INSERT OR UPDATE OR DELETE ON player_backpack_instances
FOR EACH ROW EXECUTE FUNCTION lock_inventory_carry_mutation();
CREATE CONSTRAINT TRIGGER backpack_inventory_carry_guard AFTER INSERT OR UPDATE OR DELETE ON player_backpack_instances
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_inventory_carry_mutation();
CREATE TRIGGER capacity_inventory_carry_lock BEFORE UPDATE OF base_capacity_grams ON player_inventory_capacities
FOR EACH ROW EXECUTE FUNCTION lock_inventory_carry_mutation();
CREATE CONSTRAINT TRIGGER capacity_inventory_carry_guard AFTER UPDATE OF base_capacity_grams ON player_inventory_capacities
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_inventory_carry_mutation();
CREATE TRIGGER player_inventory_balance_advance_revision AFTER INSERT OR UPDATE OR DELETE ON player_inventory
FOR EACH ROW EXECUTE FUNCTION advance_resource_inventory_revision();

CREATE OR REPLACE FUNCTION advance_inventory_capacity_revision() RETURNS trigger AS $$ BEGIN
  IF NEW.base_capacity_grams IS DISTINCT FROM OLD.base_capacity_grams
     AND NEW.inventory_revision=OLD.inventory_revision THEN
    NEW.inventory_revision:=OLD.inventory_revision+1;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
