-- Global package spatial interest. Legacy regional rows intentionally remain readable and null here;
-- they are assigned a canonical package/zone only after an authoritative position is loaded.
ALTER TABLE players
  ADD COLUMN IF NOT EXISTS spatial_package_id text,
  ADD COLUMN IF NOT EXISTS spatial_zone_id text;

UPDATE players
SET spatial_package_id = region_code,
    spatial_zone_id = 'world:' || region_code
WHERE spatial_package_id IS NULL
  AND region_code ~ '^world_v1_lat-?[0-9]+_lon-?[0-9]+$';

CREATE INDEX IF NOT EXISTS players_spatial_zone_online_idx
  ON players (spatial_zone_id)
  WHERE online;
