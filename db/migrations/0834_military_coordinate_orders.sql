-- Durable, server-owned movement intent for field Sieges.  The location state
-- remains the lifecycle state; this orthogonal order records whether the group
-- is following its owner or travelling to a planned point.
ALTER TABLE military_units
  ADD COLUMN IF NOT EXISTS movement_order text NOT NULL DEFAULT 'NONE',
  ADD COLUMN IF NOT EXISTS movement_target_lat double precision NULL,
  ADD COLUMN IF NOT EXISTS movement_target_lon double precision NULL;

ALTER TABLE military_unit_groups
  ADD COLUMN IF NOT EXISTS movement_order text NOT NULL DEFAULT 'NONE',
  ADD COLUMN IF NOT EXISTS movement_target_lat double precision NULL,
  ADD COLUMN IF NOT EXISTS movement_target_lon double precision NULL;

-- Preserve the legacy FOLLOWING_PLAYER lifecycle as an explicit durable
-- order for snapshots and the server movement tick.
UPDATE military_units
SET movement_order='FOLLOW_PLAYER'
WHERE unit_type='field_ballista'
  AND location_state='FOLLOWING_PLAYER'
  AND movement_order='NONE';

UPDATE military_unit_groups
SET movement_order='FOLLOW_PLAYER'
WHERE unit_type='field_ballista'
  AND location_state='FOLLOWING_PLAYER'
  AND movement_order='NONE';

ALTER TABLE military_units
  DROP CONSTRAINT IF EXISTS military_units_movement_order_check,
  ADD CONSTRAINT military_units_movement_order_check CHECK (
    movement_order IN ('NONE','FOLLOW_PLAYER','MOVE_TO_COORDINATE')
    AND (
      movement_order = 'MOVE_TO_COORDINATE'
      AND movement_target_lat IS NOT NULL
      AND movement_target_lon IS NOT NULL
      OR movement_order <> 'MOVE_TO_COORDINATE'
      AND movement_target_lat IS NULL
      AND movement_target_lon IS NULL
    )
  ),
  DROP CONSTRAINT IF EXISTS military_units_movement_target_domain,
  ADD CONSTRAINT military_units_movement_target_domain CHECK (
    movement_target_lat IS NULL OR movement_target_lat BETWEEN -90 AND 90
  ),
  ADD CONSTRAINT military_units_movement_target_lon_domain CHECK (
    movement_target_lon IS NULL OR movement_target_lon BETWEEN -180 AND 180
  );

ALTER TABLE military_unit_groups
  DROP CONSTRAINT IF EXISTS military_unit_groups_movement_order_check,
  ADD CONSTRAINT military_unit_groups_movement_order_check CHECK (
    movement_order IN ('NONE','FOLLOW_PLAYER','MOVE_TO_COORDINATE')
    AND (
      movement_order = 'MOVE_TO_COORDINATE'
      AND movement_target_lat IS NOT NULL
      AND movement_target_lon IS NOT NULL
      OR movement_order <> 'MOVE_TO_COORDINATE'
      AND movement_target_lat IS NULL
      AND movement_target_lon IS NULL
    )
  ),
  DROP CONSTRAINT IF EXISTS military_unit_groups_movement_target_domain,
  ADD CONSTRAINT military_unit_groups_movement_target_domain CHECK (
    movement_target_lat IS NULL OR movement_target_lat BETWEEN -90 AND 90
  ),
  ADD CONSTRAINT military_unit_groups_movement_target_lon_domain CHECK (
    movement_target_lon IS NULL OR movement_target_lon BETWEEN -180 AND 180
  );

CREATE INDEX IF NOT EXISTS military_unit_groups_movement_order_idx
  ON military_unit_groups (movement_order, owner_player_id, created_at, group_id)
  WHERE movement_order <> 'NONE';

ALTER TABLE military_unit_operations
  DROP CONSTRAINT IF EXISTS military_unit_operations_action_check;

ALTER TABLE military_unit_operations
  ADD CONSTRAINT military_unit_operations_action_check CHECK (action IN (
    'combine','split','load_bombers','build_war_camp','call_troops',
    'relocate_war_camp','remove_war_camp','follow','deploy','return','stop',
    'stay','repair_ballista','attack','developer_spawn','move_to_position','pack_up'
  ));
