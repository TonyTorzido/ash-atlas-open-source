-- Glimmer Oil: the player-facing name of the dungeon torch oil (internal item
-- id stays `refined_oil`). It is refined instantly at a Furnace from
-- 1 Crude Oil + 1 Glimmer, recorded as a `refine` Furnace operation.

UPDATE item_definitions
SET display_name = 'Glimmer Oil',
    updated_at = now()
WHERE item_id = 'refined_oil'
  AND display_name IS DISTINCT FROM 'Glimmer Oil';

ALTER TABLE furnace_operations
  DROP CONSTRAINT IF EXISTS furnace_operations_action_check;
ALTER TABLE furnace_operations
  ADD CONSTRAINT furnace_operations_action_check
  CHECK (action IN ('build', 'start', 'collect', 'refine'));
