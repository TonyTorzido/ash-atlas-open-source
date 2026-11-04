ALTER TABLE flags
  ADD COLUMN IF NOT EXISTS kingdom_founding_request_id text NULL,
  ADD COLUMN IF NOT EXISTS kingdom_founding_reserved_at timestamptz NULL;

ALTER TABLE kingdom_seats
  ADD COLUMN IF NOT EXISTS source_flag_id uuid NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'kingdom_seats'::regclass
      AND conname = 'kingdom_seats_source_flag_id_fkey'
  ) THEN
    ALTER TABLE kingdom_seats
      ADD CONSTRAINT kingdom_seats_source_flag_id_fkey
      FOREIGN KEY (source_flag_id) REFERENCES flags(id) ON DELETE RESTRICT;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS kingdom_seats_source_flag_unique_idx
  ON kingdom_seats (source_flag_id)
  WHERE source_flag_id IS NOT NULL;

ALTER TABLE flags
  DROP CONSTRAINT IF EXISTS flags_control_type_valid,
  ADD CONSTRAINT flags_control_type_valid
    CHECK (control_type IN ('personal', 'kingdom', 'kingdom_seat')),
  DROP CONSTRAINT IF EXISTS flags_control_state_valid,
  ADD CONSTRAINT flags_control_state_valid CHECK (
    (
      control_type = 'personal'
      AND kingdom_id IS NULL
      AND kingdom_affiliated_at IS NULL
      AND kingdom_founding_request_id IS NULL
      AND kingdom_founding_reserved_at IS NULL
    )
    OR
    (
      control_type = 'kingdom'
      AND kingdom_id IS NOT NULL
      AND kingdom_affiliated_at IS NOT NULL
      AND original_owner_player_id IS NOT NULL
      AND contributed_by_player_id IS NOT NULL
      AND kingdom_founding_request_id IS NULL
      AND kingdom_founding_reserved_at IS NULL
    )
    OR
    (
      control_type = 'kingdom_seat'
      AND kingdom_id IS NOT NULL
      AND kingdom_affiliated_at IS NOT NULL
      AND original_owner_player_id IS NOT NULL
      AND contributed_by_player_id IS NULL
      AND (
        (kingdom_founding_request_id IS NULL AND kingdom_founding_reserved_at IS NULL)
        OR
        (kingdom_founding_request_id IS NOT NULL AND kingdom_founding_reserved_at IS NOT NULL)
      )
    )
  );

CREATE INDEX IF NOT EXISTS flags_kingdom_seat_controller_idx
  ON flags (kingdom_id, id)
  WHERE control_type = 'kingdom_seat';

CREATE INDEX IF NOT EXISTS flags_kingdom_founding_reservation_idx
  ON flags (kingdom_founding_reserved_at, id)
  WHERE kingdom_founding_request_id IS NOT NULL;

CREATE OR REPLACE FUNCTION enforce_kingdom_seat_source_flag()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.source_flag_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM flags source
    WHERE source.id = NEW.source_flag_id
      AND source.control_type = 'kingdom_seat'
      AND source.kingdom_id = NEW.kingdom_id
      AND source.lat = NEW.lat
      AND source.lon = NEW.lon
      AND source.claim_radius_m = NEW.territory_radius_m
      AND ST_Equals(source.geom, NEW.geom)
  ) THEN
    RAISE EXCEPTION 'Kingdom Seat must preserve its transformed source flag geometry and radius'
      USING ERRCODE = '23514', CONSTRAINT = 'kingdom_seats_source_flag_identity';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS kingdom_seats_source_flag_identity ON kingdom_seats;
CREATE CONSTRAINT TRIGGER kingdom_seats_source_flag_identity
AFTER INSERT OR UPDATE ON kingdom_seats
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION enforce_kingdom_seat_source_flag();

CREATE OR REPLACE FUNCTION enforce_source_flag_kingdom_seat_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.control_type = 'kingdom_seat' AND NOT EXISTS (
    SELECT 1
    FROM kingdom_seats seat
    WHERE seat.source_flag_id = NEW.id
      AND seat.kingdom_id = NEW.kingdom_id
      AND seat.lat = NEW.lat
      AND seat.lon = NEW.lon
      AND seat.territory_radius_m = NEW.claim_radius_m
      AND ST_Equals(seat.geom, NEW.geom)
  ) THEN
    RAISE EXCEPTION 'Transformed source flag must preserve its linked Kingdom Seat geometry and radius'
      USING ERRCODE = '23514', CONSTRAINT = 'flags_kingdom_seat_source_identity';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS flags_kingdom_seat_source_identity ON flags;
CREATE CONSTRAINT TRIGGER flags_kingdom_seat_source_identity
AFTER INSERT OR UPDATE ON flags
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_source_flag_kingdom_seat_identity();

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
      FROM kingdom_seats seat
      JOIN kingdoms kingdom ON kingdom.id = seat.kingdom_id
      WHERE seat.status = 'active'
        AND seat.construction_state = 'complete'
        AND kingdom.status = 'active'
        AND seat.source_flag_id IS DISTINCT FROM NEW.id
        AND ST_Distance(NEW.geom::geography, seat.geom::geography)
              < NEW.claim_radius_m + seat.territory_radius_m - tolerance_m
    ) THEN
      RAISE EXCEPTION 'Personal flag territory overlaps a completed Kingdom Seat'
        USING ERRCODE = '23514', CONSTRAINT = 'flags_personal_kingdom_seat_nonoverlap';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM flags kingdom_flag
      WHERE kingdom_flag.id <> NEW.id
        AND kingdom_flag.control_type IN ('kingdom', 'kingdom_seat')
        AND ST_Distance(NEW.geom::geography, kingdom_flag.geom::geography)
              < NEW.claim_radius_m + kingdom_flag.claim_radius_m - tolerance_m
    ) THEN
      RAISE EXCEPTION 'Personal flag territory overlaps a Kingdom-controlled flag'
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

CREATE OR REPLACE FUNCTION enforce_kingdom_seat_personal_geometry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  tolerance_m constant double precision := 0.05;
BEGIN
  IF NEW.status = 'active'
     AND NEW.construction_state = 'complete'
     AND EXISTS (SELECT 1 FROM kingdoms WHERE id = NEW.kingdom_id AND status = 'active')
     AND EXISTS (
       SELECT 1
       FROM flags personal_flag
       WHERE personal_flag.control_type = 'personal'
         AND personal_flag.id IS DISTINCT FROM NEW.source_flag_id
         AND ST_Distance(NEW.geom::geography, personal_flag.geom::geography)
               < NEW.territory_radius_m + personal_flag.claim_radius_m - tolerance_m
     ) THEN
    RAISE EXCEPTION 'Completed Kingdom Seat territory overlaps a personal flag'
      USING ERRCODE = '23514', CONSTRAINT = 'kingdom_seat_personal_flag_nonoverlap';
  END IF;
  RETURN NEW;
END;
$$;
