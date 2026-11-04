-- Kingdom structure downgrade.
--
-- The leader can take a Kingdom Tower, Obelisk, Brick Furnace or Command Board
-- down one level (never below level 1); the treasury is credited 45%
-- (rounded down) of each material of the step being removed. The existing
-- append-only build ledgers record the downgrade as a new operation kind,
-- keyed by the request's operation key like a build, so a replayed request
-- can never refund twice.
--
-- Rows already in the ledgers are builds: the new operation columns default
-- to 'upgrade', and every existing row satisfies the widened checks.

-- Obelisk / Kingdom Tower ledger: downgrade rows carry the refunded
-- quantities in bricks_quantity / material_quantity (material_source is
-- always 'treasury', where the refund lands).
ALTER TABLE kingdom_structure_build_operations
  ADD COLUMN IF NOT EXISTS operation text NOT NULL DEFAULT 'upgrade';
ALTER TABLE kingdom_structure_build_operations
  DROP CONSTRAINT IF EXISTS kingdom_structure_build_operations_operation_valid;
ALTER TABLE kingdom_structure_build_operations
  ADD CONSTRAINT kingdom_structure_build_operations_operation_valid
  CHECK (operation IN ('upgrade', 'downgrade'));
ALTER TABLE kingdom_structure_build_operations
  DROP CONSTRAINT IF EXISTS kingdom_structure_build_operations_from_level_check;
ALTER TABLE kingdom_structure_build_operations
  DROP CONSTRAINT IF EXISTS kingdom_structure_build_operations_from_level_valid;
ALTER TABLE kingdom_structure_build_operations
  ADD CONSTRAINT kingdom_structure_build_operations_from_level_valid
  CHECK (from_level IS NULL OR from_level BETWEEN 1 AND 5);
ALTER TABLE kingdom_structure_build_operations
  DROP CONSTRAINT IF EXISTS kingdom_structure_build_level_step;
ALTER TABLE kingdom_structure_build_operations
  ADD CONSTRAINT kingdom_structure_build_level_step CHECK (
    (operation = 'upgrade' AND ((from_level IS NULL AND to_level = 1) OR (to_level = from_level + 1)))
    OR (operation = 'downgrade' AND from_level IS NOT NULL AND from_level >= 2
        AND to_level = from_level - 1 AND material_source = 'treasury')
  );

-- Brick Furnace ledger: a downgrade records the level it leaves the furnace
-- at and the Glimmer Oil refunded to the treasury.
ALTER TABLE kingdom_brick_furnace_operations
  DROP CONSTRAINT IF EXISTS kingdom_brick_furnace_operations_action_check;
ALTER TABLE kingdom_brick_furnace_operations
  DROP CONSTRAINT IF EXISTS kingdom_brick_furnace_operations_action_valid;
ALTER TABLE kingdom_brick_furnace_operations
  ADD CONSTRAINT kingdom_brick_furnace_operations_action_valid
  CHECK (action IN ('upgrade', 'package', 'downgrade'));
ALTER TABLE kingdom_brick_furnace_operations
  DROP CONSTRAINT IF EXISTS kingdom_brick_furnace_operations_shape;
ALTER TABLE kingdom_brick_furnace_operations
  ADD CONSTRAINT kingdom_brick_furnace_operations_shape CHECK (
    (action = 'upgrade' AND bricks_quantity = 0)
    OR (action = 'package' AND bricks_quantity > 0 AND glimmer_oil_source = 'player')
    OR (action = 'downgrade' AND bricks_quantity = 0 AND glimmer_oil_source = 'treasury')
  );

-- Command Board ledger: materials records each refunded material for a
-- downgrade. A level can now be built again after a downgrade, so the
-- one-build-per-level key goes; the level check under the Command Board row
-- lock still refuses building the same level twice in a row.
ALTER TABLE kingdom_command_board_operations
  ADD COLUMN IF NOT EXISTS operation text NOT NULL DEFAULT 'upgrade';
ALTER TABLE kingdom_command_board_operations
  DROP CONSTRAINT IF EXISTS kingdom_command_board_operations_operation_valid;
ALTER TABLE kingdom_command_board_operations
  ADD CONSTRAINT kingdom_command_board_operations_operation_valid
  CHECK (operation IN ('upgrade', 'downgrade'));
ALTER TABLE kingdom_command_board_operations
  DROP CONSTRAINT IF EXISTS kingdom_command_board_operations_from_level_check;
ALTER TABLE kingdom_command_board_operations
  DROP CONSTRAINT IF EXISTS kingdom_command_board_operations_from_level_valid;
ALTER TABLE kingdom_command_board_operations
  ADD CONSTRAINT kingdom_command_board_operations_from_level_valid
  CHECK (from_level IS NULL OR from_level BETWEEN 1 AND 3);
ALTER TABLE kingdom_command_board_operations
  DROP CONSTRAINT IF EXISTS kingdom_command_board_level_step;
ALTER TABLE kingdom_command_board_operations
  ADD CONSTRAINT kingdom_command_board_level_step CHECK (
    (operation = 'upgrade' AND ((from_level IS NULL AND to_level = 1) OR (to_level = from_level + 1)))
    OR (operation = 'downgrade' AND from_level IS NOT NULL AND from_level >= 2 AND to_level = from_level - 1)
  );
ALTER TABLE kingdom_command_board_operations
  DROP CONSTRAINT IF EXISTS kingdom_command_board_one_build_per_level;
CREATE INDEX IF NOT EXISTS kingdom_command_board_operations_kingdom_idx
  ON kingdom_command_board_operations (kingdom_id, created_at DESC);

ALTER TABLE kingdom_treasury_ledger
  DROP CONSTRAINT IF EXISTS kingdom_treasury_ledger_source_valid;
ALTER TABLE kingdom_treasury_ledger
  ADD CONSTRAINT kingdom_treasury_ledger_source_valid CHECK (
    source_type IN (
      'brick_deposit', 'kingdom_structure_build', 'brick_furnace_upgrade', 'brick_furnace_package',
      'war_surrender_transfer', 'war_surrender_destroyed', 'war_death_loss',
      'kingdom_perk_choose', 'kingdom_perk_change',
      'command_board_upgrade', 'war_structure_build',
      'kingdom_perk_payout',
      'kingdom_structure_downgrade'
    )
  );

COMMENT ON COLUMN kingdom_structure_build_operations.operation IS
  'upgrade: a level built (quantities charged); downgrade: one level removed (quantities refunded to the treasury).';
COMMENT ON COLUMN kingdom_command_board_operations.operation IS
  'upgrade: a level built (materials charged); downgrade: one level removed (materials refunded to the treasury).';
