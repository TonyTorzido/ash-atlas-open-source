-- Gathering tool slots (owner request 2026-10-06): the single `tool` slot from
-- 1190_gathering_tools.sql becomes three slots so an axe, a pickaxe and a fishing pole can be
-- equipped together. Each slot takes only its kind (packages/shared/src/equipment.ts
-- GATHERING_TOOL_SLOT_BY_KIND): chop -> tool_axe, mine -> tool_pickaxe, fish -> tool_fishing_pole.
-- Anything equipped or saved in a gear set under `tool` moves to its kind's slot. One tool per
-- player and per kit could ever sit in `tool`, so the move cannot collide. An equipped non-tool in
-- `tool` (never allowed by the server) is left alone so the final CHECK fails loudly instead of
-- guessing. Idempotent: a second run finds no `tool` rows and re-creates the same constraints.
-- Production never had the `tool` slot; only feature-runtime databases have rows to move.

-- Widen first so rows can move while both the old and new names are valid. The operations
-- CHECK is final here: like 'weapon', 'tool' stays legal there as a historical request value.
ALTER TABLE equipment_instances
  DROP CONSTRAINT IF EXISTS equipment_instances_equipped_slot_check;
ALTER TABLE equipment_instances
  ADD CONSTRAINT equipment_instances_equipped_slot_check
    CHECK (
      equipped_slot IS NULL
      OR equipped_slot IN (
        'head', 'chest', 'gloves', 'boots', 'ring', 'ring_2', 'melee', 'secondary',
        'tool', 'tool_axe', 'tool_pickaxe', 'tool_fishing_pole'
      )
    );
ALTER TABLE combat_kit_items
  DROP CONSTRAINT IF EXISTS combat_kit_items_equipment_slot_check;
ALTER TABLE combat_kit_items
  ADD CONSTRAINT combat_kit_items_equipment_slot_check
    CHECK (
      equipment_slot IN (
        'head', 'chest', 'gloves', 'boots', 'ring', 'ring_2', 'melee', 'secondary',
        'tool', 'tool_axe', 'tool_pickaxe', 'tool_fishing_pole'
      )
    );
ALTER TABLE equipment_operations
  DROP CONSTRAINT IF EXISTS equipment_operations_requested_slot_check;
ALTER TABLE equipment_operations
  ADD CONSTRAINT equipment_operations_requested_slot_check
  CHECK (
    requested_slot IS NULL
    OR requested_slot IN (
      'weapon', 'tool', 'head', 'chest', 'gloves', 'boots', 'ring', 'ring_2', 'melee', 'secondary',
      'tool_axe', 'tool_pickaxe', 'tool_fishing_pole'
    )
  );

UPDATE equipment_instances AS equipment
SET equipped_slot = mapping.slot
FROM item_definitions AS item
JOIN (VALUES
  ('wooden_axe', 'tool_axe'),
  ('stone_axe', 'tool_axe'),
  ('wooden_pickaxe', 'tool_pickaxe'),
  ('stone_pickaxe', 'tool_pickaxe'),
  ('starter_fishing_pole', 'tool_fishing_pole')
) AS mapping(equipment_family_id, slot)
  ON mapping.equipment_family_id = item.equipment_family_id
WHERE equipment.equipped_slot = 'tool'
  AND item.item_id = equipment.definition_id;

UPDATE combat_kit_items AS kit
SET equipment_slot = mapping.slot
FROM equipment_instances AS equipment
JOIN item_definitions AS item ON item.item_id = equipment.definition_id
JOIN (VALUES
  ('wooden_axe', 'tool_axe'),
  ('stone_axe', 'tool_axe'),
  ('wooden_pickaxe', 'tool_pickaxe'),
  ('stone_pickaxe', 'tool_pickaxe'),
  ('starter_fishing_pole', 'tool_fishing_pole')
) AS mapping(equipment_family_id, slot)
  ON mapping.equipment_family_id = item.equipment_family_id
WHERE kit.equipment_slot = 'tool'
  AND equipment.instance_id = kit.instance_id;

DELETE FROM combat_kit_items
WHERE equipment_slot = 'tool';

-- Operation history keeps a request's slot for replay checks; rewrite tool requests to the slot
-- the instance now uses where it can be resolved. Like 'weapon', 'tool' stays a legal historical
-- value for requests whose instance can no longer be resolved.
UPDATE equipment_operations AS operation
SET requested_slot = mapping.slot
FROM equipment_instances AS equipment
JOIN item_definitions AS item ON item.item_id = equipment.definition_id
JOIN (VALUES
  ('wooden_axe', 'tool_axe'),
  ('stone_axe', 'tool_axe'),
  ('wooden_pickaxe', 'tool_pickaxe'),
  ('stone_pickaxe', 'tool_pickaxe'),
  ('starter_fishing_pole', 'tool_fishing_pole')
) AS mapping(equipment_family_id, slot)
  ON mapping.equipment_family_id = item.equipment_family_id
WHERE operation.requested_slot = 'tool'
  AND equipment.instance_id = operation.instance_id;

-- The moves queue deferred constraint-trigger checks; run them now so the tables can be altered.
SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE equipment_instances
  DROP CONSTRAINT IF EXISTS equipment_instances_equipped_slot_check;
ALTER TABLE equipment_instances
  ADD CONSTRAINT equipment_instances_equipped_slot_check
    CHECK (
      equipped_slot IS NULL
      OR equipped_slot IN (
        'head', 'chest', 'gloves', 'boots', 'ring', 'ring_2', 'melee', 'secondary',
        'tool_axe', 'tool_pickaxe', 'tool_fishing_pole'
      )
    );

ALTER TABLE combat_kit_items
  DROP CONSTRAINT IF EXISTS combat_kit_items_equipment_slot_check;
ALTER TABLE combat_kit_items
  ADD CONSTRAINT combat_kit_items_equipment_slot_check
    CHECK (
      equipment_slot IN (
        'head', 'chest', 'gloves', 'boots', 'ring', 'ring_2', 'melee', 'secondary',
        'tool_axe', 'tool_pickaxe', 'tool_fishing_pole'
      )
    );
