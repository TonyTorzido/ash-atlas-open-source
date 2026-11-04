-- Project durable equipment identities onto the shared family-owned mechanics catalog.
-- Stable item IDs and every owned equipment instance remain unchanged.

ALTER TABLE item_definitions
  ADD COLUMN equipment_family_id text NULL,
  ADD COLUMN equipment_role text NULL;

UPDATE item_definitions AS item
SET display_name = catalog.display_name,
    equipment_family_id = catalog.family_id,
    equipment_role = catalog.role,
    updated_at = now()
FROM (VALUES
  ('starter_sword', 'Sword', 'sword', 'stock'),
  ('god_sword', 'God Sword', 'god_sword', 'developer'),
  ('starter_bow', 'Bow', 'bow', 'stock'),
  ('starter_staff', 'Staff', 'staff', 'stock'),
  ('starter_shuriken', 'Shuriken', 'shuriken', 'stock'),
  ('starter_wand', 'Wand', 'wand', 'stock'),
  ('padded_tunic', 'Tunic', 'tunic', 'stock'),
  ('leather_armor', 'Leather Armor', 'leather', 'stock'),
  ('chain_armor', 'Chain Mail', 'chain_mail', 'stock'),
  ('breast_plate', 'Breastplate', 'breastplate', 'stock'),
  ('training_axe', 'Axe', 'axe', 'stock'),
  ('double_axe', 'Double Axe', 'axe', 'cosmetic'),
  ('hammer', 'Hammer', 'staff', 'cosmetic'),
  ('training_heavy_helm', 'Heavy Helm', 'heavy_helm', 'stock'),
  ('training_heavy_chest', 'Training Heavy Chest', 'breastplate', 'special'),
  ('training_heavy_gloves', 'Heavy Gloves', 'heavy_gloves', 'stock'),
  ('training_heavy_boots', 'Heavy Boots', 'heavy_boots', 'stock'),
  ('training_light_hood', 'Light Hood', 'light_hood', 'stock'),
  ('training_light_gloves', 'Light Gloves', 'light_gloves', 'stock'),
  ('training_light_boots', 'Light Boots', 'light_boots', 'stock'),
  ('training_ring', 'Training Ring', 'training_ring', 'stock'),
  ('chopping_ring', 'Chopping Ring', 'chopping_ring', 'stock'),
  ('mining_ring', 'Mining Ring', 'mining_ring', 'stock'),
  ('attack_ring', 'Attack Ring', 'attack_ring', 'stock'),
  ('training_shield', 'Melee Shield', 'melee_shield', 'stock'),
  ('ranged_shield', 'Ranged Shield', 'ranged_shield', 'stock')
) AS catalog(item_id, display_name, family_id, role)
WHERE item.item_id = catalog.item_id;

ALTER TABLE item_definitions
  ADD CONSTRAINT item_definitions_equipment_identity_check CHECK (
    (category = 'equipment' AND equipment_family_id IS NOT NULL AND equipment_role IS NOT NULL)
    OR (category <> 'equipment' AND equipment_family_id IS NULL AND equipment_role IS NULL)
  ),
  ADD CONSTRAINT item_definitions_equipment_role_check CHECK (
    equipment_role IS NULL OR equipment_role IN ('stock','cosmetic','special','developer')
  );

CREATE INDEX item_definitions_equipment_family_idx
  ON item_definitions (equipment_family_id, equipment_role, item_id)
  WHERE category = 'equipment';

COMMENT ON COLUMN item_definitions.equipment_family_id IS
  'Shared mechanical family; all combat, matrix, and upgrade behavior derives from this identity.';
COMMENT ON COLUMN item_definitions.equipment_role IS
  'Acquisition role. Cosmetic items inherit family mechanics and are never stock crafting outputs.';
