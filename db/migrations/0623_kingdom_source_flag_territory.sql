-- A Kingdom Seat is lifecycle and travel metadata for its transformed source
-- flag. The source flag is the sole physical territory authority.
CREATE OR REPLACE FUNCTION enforce_mixed_flag_control_geometry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  tolerance_m constant double precision := 0.05;
BEGIN
  IF NEW.control_type = 'personal' THEN
    IF EXISTS (
      SELECT 1
      FROM flags kingdom_flag
      JOIN kingdoms kingdom
        ON kingdom.id = kingdom_flag.kingdom_id
       AND kingdom.status = 'active'
      WHERE kingdom_flag.id <> NEW.id
        AND kingdom_flag.control_type IN ('kingdom', 'kingdom_seat')
        AND ST_Distance(NEW.geom::geography, kingdom_flag.geom::geography)
              < NEW.claim_radius_m + kingdom_flag.claim_radius_m - tolerance_m
    ) THEN
      RAISE EXCEPTION 'Personal flag territory overlaps a Kingdom-controlled source flag'
        USING ERRCODE = '23514', CONSTRAINT = 'flags_personal_kingdom_flag_nonoverlap';
    END IF;
  ELSE
    IF EXISTS (
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
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS kingdom_seats_personal_flag_geometry ON kingdom_seats;
DROP FUNCTION IF EXISTS enforce_kingdom_seat_personal_geometry();
