-- Preserve each occupant's authoritative local manor position across reconnects.

ALTER TABLE player_manor_presence
  ADD COLUMN IF NOT EXISTS local_position_x double precision,
  ADD COLUMN IF NOT EXISTS local_position_y double precision;

ALTER TABLE player_manor_presence
  DROP CONSTRAINT IF EXISTS player_manor_presence_local_position_pair_check,
  DROP CONSTRAINT IF EXISTS player_manor_presence_local_position_bounds_check;

ALTER TABLE player_manor_presence
  ADD CONSTRAINT player_manor_presence_local_position_pair_check CHECK (
    (local_position_x IS NULL) = (local_position_y IS NULL)
  ),
  ADD CONSTRAINT player_manor_presence_local_position_bounds_check CHECK (
    local_position_x IS NULL OR (
      local_position_x > '-Infinity'::double precision
      AND local_position_x < 'Infinity'::double precision
      AND local_position_y > '-Infinity'::double precision
      AND local_position_y < 'Infinity'::double precision
      AND local_position_x BETWEEN 24 AND 976
      AND local_position_y BETWEEN 24 AND 976
    )
  );

COMMENT ON COLUMN player_manor_presence.local_position_x IS
  'Last coalesced authoritative local manor X coordinate; null uses the normal spawn.';
COMMENT ON COLUMN player_manor_presence.local_position_y IS
  'Last coalesced authoritative local manor Y coordinate; null uses the normal spawn.';
