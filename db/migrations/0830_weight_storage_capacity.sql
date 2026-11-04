-- Storage capacity is authoritative in integer grams. Existing positions remain
-- ordering metadata so retained holdings survive the removal of slot limits.
LOCK TABLE inventory_carry_rules, player_inventory_capacities,
  manor_storage_stacks, manor_storage_overflow, equipment_instances,
  player_backpack_instances, city_warehouse_stacks IN ACCESS EXCLUSIVE MODE;
SET CONSTRAINTS ALL IMMEDIATE;

UPDATE inventory_carry_rules
SET default_base_capacity_grams = 1000000
WHERE singleton = true;

ALTER TABLE inventory_carry_rules
  ALTER COLUMN default_base_capacity_grams SET DEFAULT 1000000;

ALTER TABLE player_inventory_capacities
  ALTER COLUMN base_capacity_grams SET DEFAULT 1000000;

-- Preserve larger bespoke capacity rows while moving every old baseline to 1,000 kg.
UPDATE player_inventory_capacities
SET base_capacity_grams = GREATEST(base_capacity_grams, 1000000);

-- Promote the migration-retained manor overflow into the active storage ledger
-- before removing the 60-position constraint. The stack IDs and quantities are
-- retained; the old overflow rows are then empty but remain available for audit.
DROP TRIGGER IF EXISTS manor_storage_overflow_immutable ON manor_storage_overflow;
ALTER TABLE manor_storage_stacks
  DROP CONSTRAINT IF EXISTS manor_storage_stacks_slot_unique,
  DROP CONSTRAINT IF EXISTS manor_storage_stacks_slot_index_check;

WITH bases AS (
  SELECT overflow.manor_id, COALESCE(MAX(stack.slot_index), -1) AS base_position
  FROM manor_storage_overflow overflow
  LEFT JOIN manor_storage_stacks stack ON stack.manor_id = overflow.manor_id
  GROUP BY overflow.manor_id
), numbered AS (
  SELECT overflow.stack_id,
         overflow.manor_id,
         overflow.item_id,
         overflow.variant,
         overflow.quantity,
         overflow.legacy_version,
         overflow.created_at,
         bases.base_position + row_number() OVER (
           PARTITION BY overflow.manor_id ORDER BY overflow.source_order
         ) AS slot_index
  FROM manor_storage_overflow overflow
  JOIN bases ON bases.manor_id = overflow.manor_id
)
INSERT INTO manor_storage_stacks
  (stack_id, manor_id, slot_index, item_id, variant, quantity, manual_split,
   version, created_at, updated_at)
SELECT stack_id, manor_id, slot_index::integer, item_id, variant, quantity, false,
       GREATEST(legacy_version, 1), created_at, now()
FROM numbered;

DELETE FROM manor_storage_overflow;

ALTER TABLE manor_storage_stacks
  ADD CONSTRAINT manor_storage_stacks_slot_index_nonnegative CHECK (slot_index >= 0);

DROP TRIGGER IF EXISTS manor_storage_material_slot_clear ON manor_storage_stacks;
DROP TRIGGER IF EXISTS manor_storage_equipment_slot_clear ON equipment_instances;
DROP FUNCTION IF EXISTS validate_manor_material_slot();
DROP FUNCTION IF EXISTS validate_manor_equipment_slot();

ALTER TABLE equipment_instances
  DROP CONSTRAINT IF EXISTS equipment_instances_manor_slot_index_check;
DROP INDEX IF EXISTS equipment_instances_manor_slot_idx;

ALTER TABLE player_backpack_instances
  DROP CONSTRAINT IF EXISTS player_backpack_instances_location_check;
ALTER TABLE player_backpack_instances
  ADD CONSTRAINT player_backpack_instances_location_check CHECK (
    (location = 'inventory'
      AND inventory_slot_index IS NULL
      AND equipped_slot IS NULL
      AND manor_id IS NULL
      AND manor_slot_index IS NULL)
    OR
    (location = 'equipped'
      AND equipped_slot BETWEEN 0 AND 3
      AND inventory_slot_index IS NULL
      AND manor_id IS NULL
      AND manor_slot_index IS NULL)
    OR
    (location = 'manor_storage'
      AND manor_id IS NOT NULL
      AND manor_slot_index IS NOT NULL
      AND equipped_slot IS NULL
      AND inventory_slot_index IS NULL)
    OR
    (location = 'destroyed'
      AND equipped_slot IS NULL
      AND inventory_slot_index IS NULL
      AND manor_id IS NULL
      AND manor_slot_index IS NULL)
  );
DROP INDEX IF EXISTS player_backpack_manor_slot_idx;

ALTER TABLE city_warehouse_stacks
  DROP CONSTRAINT IF EXISTS city_warehouse_stacks_city_id_slot_index_key;
