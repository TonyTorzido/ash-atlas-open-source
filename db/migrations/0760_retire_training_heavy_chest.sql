-- Training Heavy Chest is no longer an active equipment definition. Preserve every
-- retained instance by converting it to the canonical Breastplate stock item.

LOCK TABLE item_definitions, equipment_instances, world_equipment_drops
  IN SHARE ROW EXCLUSIVE MODE;

UPDATE world_equipment_drops
SET item_id = 'breast_plate'
WHERE item_id = 'training_heavy_chest';

UPDATE equipment_instances
SET definition_id = 'breast_plate',
    updated_at = now()
WHERE definition_id = 'training_heavy_chest';

-- Keep the definition only as an FK-safe retired tombstone for immutable audit
-- records. The compiled catalog hides it from normal authoring and stock routes.
UPDATE item_definitions
SET display_name = 'Training Heavy Chest',
    market_tradable = false,
    market_fungible = false,
    equipment_role = 'special',
    updated_at = now()
WHERE item_id = 'training_heavy_chest';
