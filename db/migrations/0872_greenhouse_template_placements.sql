-- Move greenhouse presentation authority from the legacy room anchor/hotspot
-- fields to the Studio-authored reusable placement templates.  Existing rows
-- are snapshotted in place; crops, timers and tank water are never rewritten.

UPDATE greenhouse_plant_anchors AS anchor
SET custom_positioned = true,
    updated_at = now()
WHERE anchor.placed = true
  AND anchor.custom_positioned = false;

-- Rows created before durable tank placement used the published legacy
-- hotspot.  Snapshot that position once so later catalog edits do not move an
-- existing tank.  New builds intentionally leave tank_placed=false and NULL
-- coordinates, so they must be placed by the owner first.
UPDATE player_greenhouses AS greenhouse
SET tank_x = COALESCE(tank_x, 1020),
    tank_y = COALESCE(tank_y, 720),
    updated_at = now()
WHERE greenhouse.removed_at IS NULL
  AND greenhouse.tank_placed = true
  AND (greenhouse.tank_x IS NULL OR greenhouse.tank_y IS NULL);

CREATE INDEX IF NOT EXISTS player_greenhouses_tank_placed_idx
  ON player_greenhouses(owner_player_id, tank_placed)
  WHERE removed_at IS NULL;
