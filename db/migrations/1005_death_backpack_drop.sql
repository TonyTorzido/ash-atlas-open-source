-- Death backpack drop: on death a player drops their lowest-level
-- backpack plus whatever they can no longer carry, onto the overworld ground
-- at the death spot. Overworld backpack drops are pickable by anyone and
-- despawn on the normal ground-drop timer, so they need an 'expired' status
-- (the backpack is destroyed) next to the Manor recovery pile's persistent
-- rows. One row per death operation key records the outcome so a replayed
-- death never moves anything twice.

ALTER TABLE backpack_drop_operations
  DROP CONSTRAINT IF EXISTS backpack_drop_operations_action_check;
ALTER TABLE backpack_drop_operations
  ADD CONSTRAINT backpack_drop_operations_action_check
  CHECK (action IN ('manor_storage_recovery', 'pickup', 'death_drop'));

ALTER TABLE world_backpack_drops
  ADD COLUMN IF NOT EXISTS expired_at timestamptz NULL;

DO $$
DECLARE
  existing record;
BEGIN
  -- The original inline status and pickup-state checks have generated names.
  FOR existing IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'world_backpack_drops'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%picked_up%'
  LOOP
    EXECUTE format('ALTER TABLE world_backpack_drops DROP CONSTRAINT %I', existing.conname);
  END LOOP;
END $$;

ALTER TABLE world_backpack_drops
  ADD CONSTRAINT world_backpack_drops_status_check
  CHECK (status IN ('active', 'picked_up', 'expired'));
ALTER TABLE world_backpack_drops
  ADD CONSTRAINT world_backpack_drops_custody_state_check CHECK (
    (status = 'active' AND pickup_operation_key IS NULL
      AND picked_up_by IS NULL AND picked_up_at IS NULL AND expired_at IS NULL)
    OR (status = 'picked_up' AND pickup_operation_key IS NOT NULL
      AND picked_up_by IS NOT NULL AND picked_up_at IS NOT NULL AND expired_at IS NULL)
    OR (status = 'expired' AND manor_id IS NULL AND pickup_operation_key IS NULL
      AND picked_up_by IS NULL AND picked_up_at IS NULL AND expired_at IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS world_backpack_drops_active_world_expiry_idx
  ON world_backpack_drops (expires_at, id)
  WHERE status = 'active' AND manor_id IS NULL;
CREATE INDEX IF NOT EXISTS world_backpack_drops_active_world_geom_idx
  ON world_backpack_drops USING gist (geom)
  WHERE status = 'active' AND manor_id IS NULL;

CREATE TABLE IF NOT EXISTS player_death_backpack_drops (
  operation_key text PRIMARY KEY CHECK (length(operation_key) BETWEEN 1 AND 240),
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  outcome text NOT NULL CHECK (outcome IN (
    'dropped', 'protected', 'dungeon', 'interior', 'disabled',
    'unknown_context', 'no_backpack', 'cannot_fit'
  )),
  backpack_instance_id uuid NULL REFERENCES player_backpack_instances(instance_id) ON DELETE RESTRICT,
  backpack_drop_id uuid NULL REFERENCES world_backpack_drops(id) ON DELETE RESTRICT,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT player_death_backpack_drops_dropped_check CHECK (
    (outcome = 'dropped') = (backpack_instance_id IS NOT NULL AND backpack_drop_id IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS player_death_backpack_drops_player_idx
  ON player_death_backpack_drops (player_id, created_at DESC);
