-- Preserve durable Follow intent for every field military group so the
-- authoritative movement tick can assign stable formation slots after a
-- restart or reconnect. This is forward-only and idempotent.
UPDATE military_unit_groups
SET movement_order='FOLLOW_PLAYER'
WHERE location_state='FOLLOWING_PLAYER' AND movement_order='NONE';

UPDATE military_units
SET movement_order='FOLLOW_PLAYER'
WHERE location_state='FOLLOWING_PLAYER' AND movement_order='NONE';
