-- Dissolution restores the transformed source flag to personal control while
-- retaining the archived Seat as history. Only an active Seat owns the live
-- source relationship, so a restored flag may anchor a later Kingdom.
DROP INDEX IF EXISTS kingdom_seats_source_flag_unique_idx;

CREATE UNIQUE INDEX kingdom_seats_source_flag_unique_idx
  ON kingdom_seats (source_flag_id)
  WHERE source_flag_id IS NOT NULL AND status = 'active';

CREATE OR REPLACE FUNCTION enforce_kingdom_seat_source_flag()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  tolerance_m constant double precision := 0.05;
BEGIN
  IF NEW.status = 'active'
     AND NEW.source_flag_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM flags source
       WHERE source.id = NEW.source_flag_id
         AND source.control_type = 'kingdom_seat'
         AND source.kingdom_id = NEW.kingdom_id
         AND source.claim_radius_m = NEW.territory_radius_m
         AND ST_DWithin(
           source.geom::geography,
           NEW.geom::geography,
           source.claim_radius_m + tolerance_m
         )
     ) THEN
    RAISE EXCEPTION 'Active Kingdom Seat must remain inside its transformed source flag territory'
      USING ERRCODE = '23514', CONSTRAINT = 'kingdom_seats_source_flag_identity';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_source_flag_kingdom_seat_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  tolerance_m constant double precision := 0.05;
BEGIN
  IF NEW.control_type = 'kingdom_seat' AND NOT EXISTS (
    SELECT 1
    FROM kingdom_seats seat
    WHERE seat.source_flag_id = NEW.id
      AND seat.kingdom_id = NEW.kingdom_id
      AND seat.status = 'active'
      AND seat.territory_radius_m = NEW.claim_radius_m
      AND ST_DWithin(
        NEW.geom::geography,
        seat.geom::geography,
        NEW.claim_radius_m + tolerance_m
      )
  ) THEN
    RAISE EXCEPTION 'Transformed source flag must contain its active linked Kingdom Seat'
      USING ERRCODE = '23514', CONSTRAINT = 'flags_kingdom_seat_source_identity';
  END IF;
  RETURN NEW;
END;
$$;
