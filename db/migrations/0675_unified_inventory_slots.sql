ALTER TABLE equipment_instances
  ADD COLUMN inventory_slot_index integer NULL
    CHECK (inventory_slot_index IS NULL OR inventory_slot_index >= 0);

WITH resource_extents AS (
  SELECT player_id, COALESCE(max(slot_index), -1) AS highest_slot
  FROM player_inventory_slots
  GROUP BY player_id
),
ordered_equipment AS (
  SELECT equipment.instance_id,
         COALESCE(resource_extents.highest_slot, -1) +
           row_number() OVER (
           PARTITION BY equipment.owner_player_id
             ORDER BY equipment.definition_id,
                      equipment.item_level DESC,
                      equipment.instance_id
           ) AS slot_index
  FROM equipment_instances equipment
  LEFT JOIN resource_extents
    ON resource_extents.player_id = equipment.owner_player_id
  WHERE equipment.location <> 'destroyed'
)
UPDATE equipment_instances equipment
SET inventory_slot_index = ordered_equipment.slot_index,
    updated_at = now()
FROM ordered_equipment
WHERE ordered_equipment.instance_id = equipment.instance_id;

CREATE UNIQUE INDEX equipment_instances_inventory_slot_idx
  ON equipment_instances (owner_player_id, inventory_slot_index)
  WHERE location <> 'destroyed' AND inventory_slot_index IS NOT NULL;

CREATE OR REPLACE FUNCTION keep_resource_slot_clear_of_equipment()
RETURNS trigger AS $$
DECLARE
  effective_capacity integer;
  free_slot integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM equipment_instances equipment
    WHERE equipment.owner_player_id = NEW.player_id
      AND equipment.location <> 'destroyed'
      AND equipment.inventory_slot_index = NEW.slot_index
  ) THEN
    RETURN NEW;
  END IF;

  SELECT capacity.unlocked_slots + count(equipment.instance_id)::integer
  INTO effective_capacity
  FROM player_inventory_capacities capacity
  LEFT JOIN equipment_instances equipment
    ON equipment.owner_player_id = capacity.player_id
   AND equipment.location <> 'destroyed'
  WHERE capacity.player_id = NEW.player_id
  GROUP BY capacity.unlocked_slots;

  SELECT candidate.slot_index
  INTO free_slot
  FROM generate_series(0, effective_capacity - 1) candidate(slot_index)
  LEFT JOIN player_inventory_slots resource
    ON resource.player_id = NEW.player_id
   AND resource.slot_index = candidate.slot_index
  LEFT JOIN equipment_instances equipment
    ON equipment.owner_player_id = NEW.player_id
   AND equipment.location <> 'destroyed'
   AND equipment.inventory_slot_index = candidate.slot_index
  WHERE resource.stack_id IS NULL
    AND equipment.instance_id IS NULL
  ORDER BY candidate.slot_index
  LIMIT 1;

  IF free_slot IS NULL THEN
    RAISE EXCEPTION 'Inventory does not have enough free slots'
      USING ERRCODE = '23514';
  END IF;

  NEW.slot_index := free_slot;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER player_inventory_slots_avoid_equipment
BEFORE INSERT ON player_inventory_slots
FOR EACH ROW
EXECUTE FUNCTION keep_resource_slot_clear_of_equipment();
