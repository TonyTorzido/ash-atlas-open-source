-- Gathering tools (owner request 2026-10-06): a new equippable `tool` slot and five starter
-- tools. Looks only: they add no stats and nothing requires them. Each tool is the stock item of
-- its own gameplay family (packages/shared/src/equipment.ts GATHERING_TOOL_FAMILIES), crafted
-- from wood, stone and flax. This migration registers the catalog rows and widens the slot
-- CHECKs; it does not grant, move or modify any owned equipment.
INSERT INTO item_definitions (
  item_id, display_name, category, equipment_family_id, equipment_role, rarity,
  stackable, max_stack, droppable, manor_storable,
  market_tradable, market_fungible, market_identity, supported_variants, unit_weight_grams
)
VALUES
  ('wooden_axe', 'Wooden Axe', 'equipment', 'wooden_axe', 'stock', 'common',
    false, 1, true, true, false, false, NULL, ARRAY['default']::text[], 1500),
  ('stone_axe', 'Stone Axe', 'equipment', 'stone_axe', 'stock', 'common',
    false, 1, true, true, false, false, NULL, ARRAY['default']::text[], 1500),
  ('wooden_pickaxe', 'Wooden Pickaxe', 'equipment', 'wooden_pickaxe', 'stock', 'common',
    false, 1, true, true, false, false, NULL, ARRAY['default']::text[], 1500),
  ('stone_pickaxe', 'Stone Pickaxe', 'equipment', 'stone_pickaxe', 'stock', 'common',
    false, 1, true, true, false, false, NULL, ARRAY['default']::text[], 1500),
  ('starter_fishing_pole', 'Starter Fishing Pole', 'equipment', 'starter_fishing_pole', 'stock', 'common',
    false, 1, true, true, false, false, NULL, ARRAY['default']::text[], 1500)
ON CONFLICT (item_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  category = EXCLUDED.category,
  equipment_family_id = EXCLUDED.equipment_family_id,
  equipment_role = EXCLUDED.equipment_role,
  rarity = EXCLUDED.rarity,
  stackable = EXCLUDED.stackable,
  max_stack = EXCLUDED.max_stack,
  droppable = EXCLUDED.droppable,
  manor_storable = EXCLUDED.manor_storable,
  market_tradable = EXCLUDED.market_tradable,
  market_fungible = EXCLUDED.market_fungible,
  market_identity = EXCLUDED.market_identity,
  supported_variants = EXCLUDED.supported_variants,
  unit_weight_grams = EXCLUDED.unit_weight_grams,
  updated_at = now();

-- The tool slot joins every slot list (latest definitions: 1070_random_rings.sql).
ALTER TABLE equipment_instances
  DROP CONSTRAINT IF EXISTS equipment_instances_equipped_slot_check;
ALTER TABLE equipment_instances
  ADD CONSTRAINT equipment_instances_equipped_slot_check
    CHECK (
      equipped_slot IS NULL
      OR equipped_slot IN (
        'head', 'chest', 'gloves', 'boots', 'ring', 'ring_2', 'melee', 'secondary', 'tool'
      )
    );

ALTER TABLE equipment_operations
  DROP CONSTRAINT IF EXISTS equipment_operations_requested_slot_check;
ALTER TABLE equipment_operations
  ADD CONSTRAINT equipment_operations_requested_slot_check
  CHECK (
    requested_slot IS NULL
    OR requested_slot IN (
      'weapon', 'head', 'chest', 'gloves', 'boots', 'ring', 'ring_2', 'melee', 'secondary', 'tool'
    )
  );

ALTER TABLE combat_kit_items
  DROP CONSTRAINT IF EXISTS combat_kit_items_equipment_slot_check;
ALTER TABLE combat_kit_items
  ADD CONSTRAINT combat_kit_items_equipment_slot_check
    CHECK (
      equipment_slot IN (
        'head', 'chest', 'gloves', 'boots', 'ring', 'ring_2', 'melee', 'secondary', 'tool'
      )
    );
