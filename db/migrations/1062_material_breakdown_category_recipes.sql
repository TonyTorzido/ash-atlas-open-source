-- Mob value pass step B2: breakdown of graded materials at the Tannery, Loom and Kitchen, the
-- Furnace's instant breakdown action, and the Skyrise Bar (Mana Shard replaces "Zephyr").
-- Recipe ids and per-recipe yields are now owned by the shared catalog (materialGrades.ts) and
-- enforced by the server; the tables keep shape and bounds checks only. Breakdown recipe ids are
-- the input item ids. Legacy pinned rules (multiples of 10, Loom pairs) are kept for their recipes.

ALTER TABLE tannery_jobs
  DROP CONSTRAINT IF EXISTS tannery_jobs_recipe_id_check;
ALTER TABLE tannery_jobs
  ADD CONSTRAINT tannery_jobs_recipe_id_check
    CHECK (recipe_id ~ '^[a-z][a-z0-9_]{0,63}$');

ALTER TABLE loom_jobs
  DROP CONSTRAINT IF EXISTS loom_jobs_recipe_id_check,
  DROP CONSTRAINT IF EXISTS loom_jobs_requested_input_quantity_check,
  DROP CONSTRAINT IF EXISTS loom_jobs_check;
ALTER TABLE loom_jobs
  ADD CONSTRAINT loom_jobs_recipe_id_check
    CHECK (recipe_id ~ '^[a-z][a-z0-9_]{0,63}$'),
  ADD CONSTRAINT loom_jobs_requested_input_quantity_check
    CHECK (
      requested_input_quantity BETWEEN 1 AND 25
      AND (recipe_id <> 'flax_fiber' OR (
        requested_input_quantity BETWEEN 2 AND 24 AND requested_input_quantity % 2 = 0
      ))
    ),
  ADD CONSTRAINT loom_jobs_output_quantity_check
    CHECK (
      output_quantity BETWEEN 1 AND 1000
      AND (recipe_id <> 'flax_fiber' OR output_quantity * 2 = requested_input_quantity)
    );

ALTER TABLE kitchen_jobs
  DROP CONSTRAINT IF EXISTS kitchen_jobs_recipe_id_check,
  DROP CONSTRAINT IF EXISTS kitchen_jobs_requested_input_quantity_check,
  DROP CONSTRAINT IF EXISTS kitchen_jobs_output_quantity_check;
ALTER TABLE kitchen_jobs
  ADD CONSTRAINT kitchen_jobs_recipe_id_check
    CHECK (recipe_id ~ '^[a-z][a-z0-9_]{0,63}$'),
  ADD CONSTRAINT kitchen_jobs_requested_input_quantity_check
    CHECK (
      requested_input_quantity BETWEEN 1 AND 50
      AND (recipe_id NOT IN (
        'deer_meat', 'wolf_meat', 'hog_meat', 'bear_meat', 'alligator_meat',
        'wild_meat', 'squid_meat', 'freshwater_fish'
      ) OR requested_input_quantity % 10 = 0)
    ),
  ADD CONSTRAINT kitchen_jobs_output_quantity_check
    CHECK (
      output_quantity BETWEEN 1 AND 1000
      AND (recipe_id NOT IN (
        'deer_meat', 'wolf_meat', 'hog_meat', 'bear_meat', 'alligator_meat',
        'wild_meat', 'squid_meat', 'freshwater_fish'
      ) OR output_quantity * 10 = requested_input_quantity)
    );

ALTER TABLE furnace_smelt_jobs
  DROP CONSTRAINT IF EXISTS furnace_smelt_jobs_recipe_id_check;
ALTER TABLE furnace_smelt_jobs
  ADD CONSTRAINT furnace_smelt_jobs_recipe_id_check CHECK (
    recipe_id IN (
      'iron_bar', 'slag_recovery',
      'revenant_bar', 'expel_bar', 'mirage_bar', 'gale_bar', 'fleet_bar',
      'venomsteel_bar', 'whetted_bar', 'lightning_bar', 'vengeance_bar',
      'gloom_bar', 'fire_bar', 'ice_bar', 'vital_bar', 'skyrise_bar',
      'venomsteel_core', 'fire_core', 'lightning_core', 'ice_core'
    )
  );

ALTER TABLE furnace_operations
  DROP CONSTRAINT IF EXISTS furnace_operations_action_check;
ALTER TABLE furnace_operations
  ADD CONSTRAINT furnace_operations_action_check
  CHECK (action IN ('build', 'start', 'collect', 'refine', 'breakdown'));
