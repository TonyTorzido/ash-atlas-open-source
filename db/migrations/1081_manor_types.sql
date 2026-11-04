-- Manor types: every player Manor uses one Studio-authored Manor type (a
-- `kind: "manor"` interior space id, e.g. the timber `manor_lobby`). Existing
-- Manors keep the timber Manor. The type only selects content (rooms, floor
-- art, overworld building); acquisition rules live in server code.
ALTER TABLE player_manors
  ADD COLUMN IF NOT EXISTS manor_type_id text NOT NULL DEFAULT 'manor_lobby';

ALTER TABLE player_manors DROP CONSTRAINT IF EXISTS player_manors_manor_type_id_format;
ALTER TABLE player_manors ADD CONSTRAINT player_manors_manor_type_id_format
  CHECK (manor_type_id ~ '^[a-z0-9]+([-_][a-z0-9]+)*$' AND length(manor_type_id) <= 128);

-- The timber Manor's basement hallway becomes its single Lower Room and the six
-- basement rooms are retired. Keep any placement made there by moving it into
-- the Lower Room (the server snaps it onto that room's floor on next load).
UPDATE manor_decoration_placements
SET room_id = 'basement_hallway', updated_at = now()
WHERE room_id IN ('basement_room_1', 'basement_room_2', 'basement_room_3',
                  'basement_room_4', 'basement_room_5', 'basement_room_6');
