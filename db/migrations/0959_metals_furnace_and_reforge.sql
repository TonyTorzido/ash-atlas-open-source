-- metals framework (phase 1): per-metal furnace bar recipes and the Jewel Station reforge.
-- Core recipes stay in the constraint only so jobs queued before this change still settle;
-- the server refuses to start them. Skyrise joins once a Zephyr item exists.
ALTER TABLE furnace_smelt_jobs
  DROP CONSTRAINT IF EXISTS furnace_smelt_jobs_recipe_id_check;
ALTER TABLE furnace_smelt_jobs
  ADD CONSTRAINT furnace_smelt_jobs_recipe_id_check CHECK (
    recipe_id IN (
      'iron_bar', 'slag_recovery',
      'revenant_bar', 'expel_bar', 'mirage_bar', 'gale_bar', 'fleet_bar',
      'venomsteel_bar', 'whetted_bar', 'lightning_bar', 'vengeance_bar',
      'gloom_bar', 'fire_bar', 'ice_bar', 'vital_bar',
      'venomsteel_core', 'fire_core', 'lightning_core', 'ice_core'
    )
  );

ALTER TABLE equipment_operations
  DROP CONSTRAINT IF EXISTS equipment_operations_action_check;
ALTER TABLE equipment_operations
  ADD CONSTRAINT equipment_operations_action_check CHECK (
    action IN (
      'starter_loadout', 'equip', 'unequip', 'package_grant',
      'ground_drop', 'ground_pickup', 'ground_expire', 'prepare', 'imbue',
      'craft', 'limited_purchase', 'manor_storage_recovery', 'reforge'
    )
  );
