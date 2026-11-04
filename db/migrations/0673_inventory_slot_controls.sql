ALTER TABLE inventory_stack_operations
  DROP CONSTRAINT inventory_stack_operations_action_check;

ALTER TABLE inventory_stack_operations
  ALTER COLUMN stack_id DROP NOT NULL,
  ADD COLUMN target_slot integer NULL CHECK (target_slot IS NULL OR target_slot >= 0),
  ADD CONSTRAINT inventory_stack_operations_action_check
    CHECK (action IN ('split', 'restack', 'move', 'reorganize'));
