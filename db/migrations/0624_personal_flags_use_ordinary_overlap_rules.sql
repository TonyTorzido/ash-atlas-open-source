-- Ordinary personal-flag placement uses the same center-outside-existing-claim
-- invariant for personal, Kingdom Flag, and Kingdom Seat rows. Mixed-control
-- geometry remains relevant only when an existing personal flag is converted.
CREATE OR REPLACE FUNCTION enforce_mixed_flag_control_geometry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  tolerance_m constant double precision := 0.05;
BEGIN
  IF NEW.control_type <> 'personal'
     AND EXISTS (
       SELECT 1
       FROM flags personal_flag
       WHERE personal_flag.id <> NEW.id
         AND personal_flag.control_type = 'personal'
         AND ST_Distance(NEW.geom::geography, personal_flag.geom::geography)
               < NEW.claim_radius_m + personal_flag.claim_radius_m - tolerance_m
     ) THEN
    RAISE EXCEPTION 'Kingdom conversion would overlap a personal flag territory'
      USING ERRCODE = '23514', CONSTRAINT = 'flags_kingdom_personal_flag_nonoverlap';
  END IF;
  RETURN NEW;
END;
$$;
