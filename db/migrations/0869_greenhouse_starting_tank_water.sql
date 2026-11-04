-- Newly completed greenhouses start with a five-gallon tank.  Older empty
-- greenhouses are eligible only when no player tank operation has ever been
-- recorded, so an intentionally emptied or otherwise player-modified tank is
-- never silently refilled.  This migration is one-time and forward-only.
UPDATE player_greenhouses AS greenhouse
SET tank_water_tenths = 50,
    updated_at = now()
WHERE greenhouse.removed_at IS NULL
  AND greenhouse.tank_water_tenths = 0
  AND NOT EXISTS (
    SELECT 1
    FROM greenhouse_operations AS operation
    WHERE operation.greenhouse_id = greenhouse.greenhouse_id
      AND operation.action IN ('deposit', 'refill')
  );
