-- Correct the initial world-mob migration's shared Wolf return anchor.
-- anchor_lat/anchor_lon are the durable member-specific home slot for every mob.

DROP TRIGGER IF EXISTS generated_world_mobs_protect_history ON generated_world_mobs;

UPDATE generated_world_mobs
SET anchor_lat = lat,
    anchor_lon = lon
WHERE mob_archetype = 'wolf'
  AND (anchor_lat IS DISTINCT FROM lat OR anchor_lon IS DISTINCT FROM lon);

CREATE TRIGGER generated_world_mobs_protect_history
BEFORE UPDATE ON generated_world_mobs
FOR EACH ROW EXECUTE FUNCTION protect_generated_world_mob();

COMMENT ON COLUMN generated_world_mobs.anchor_lat IS
  'Immutable latitude of this individual mob body''s personal return-home slot.';
COMMENT ON COLUMN generated_world_mobs.anchor_lon IS
  'Immutable longitude of this individual mob body''s personal return-home slot.';
