-- Mending Resin: a consumable (Alchemy rank 1) that restores 12% condition (17% with Alchemy)
-- on chest armor. Condition stays capped at 100 (equipment_instances_condition_check). The repair
-- is recorded as a 'resin_repair' operation for replay safety. Forward-only and idempotent.

LOCK TABLE item_definitions IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO item_definitions (
  item_id, display_name, category, rarity, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants, unit_weight_grams
)
VALUES
  ('mending_resin', 'Mending Resin', 'consumable', 'uncommon', true, 100, true, true, true, true, 'mending_resin', ARRAY['default']::text[], 100)
ON CONFLICT (item_id) DO NOTHING;

ALTER TABLE equipment_repair_operations
  DROP CONSTRAINT IF EXISTS equipment_repair_operations_action_check;
ALTER TABLE equipment_repair_operations
  ADD CONSTRAINT equipment_repair_operations_action_check
  CHECK (action IN ('death_wear', 'repair', 'craft_repair_kit', 'resin_repair'));
