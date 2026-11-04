ALTER TABLE kingdoms
  ADD COLUMN IF NOT EXISTS display_color text NOT NULL DEFAULT '#7c3aed';

ALTER TABLE kingdoms
  DROP CONSTRAINT IF EXISTS kingdoms_display_color_valid,
  ADD CONSTRAINT kingdoms_display_color_valid
    CHECK (display_color ~ '^#[0-9a-fA-F]{6}$');

ALTER TABLE flags
  ADD COLUMN IF NOT EXISTS control_type text NOT NULL DEFAULT 'personal',
  ADD COLUMN IF NOT EXISTS original_owner_player_id text NULL,
  ADD COLUMN IF NOT EXISTS contributed_by_player_id text NULL,
  ADD COLUMN IF NOT EXISTS original_personal_color text NULL;

UPDATE flags flag
SET control_type = 'kingdom',
    original_owner_player_id = COALESCE(flag.original_owner_player_id, flag.owner_id),
    contributed_by_player_id = COALESCE(
      flag.contributed_by_player_id,
      flag.kingdom_affiliated_by_player_id,
      flag.owner_id
    ),
    original_personal_color = COALESCE(
      flag.original_personal_color,
      player.display_color,
      '#d83a3a'
    )
FROM players player
WHERE flag.kingdom_id IS NOT NULL
  AND player.id = flag.owner_id;

UPDATE flags
SET control_type = 'personal'
WHERE kingdom_id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'flags'::regclass
      AND conname = 'flags_original_owner_player_id_fkey'
  ) THEN
    ALTER TABLE flags
      ADD CONSTRAINT flags_original_owner_player_id_fkey
      FOREIGN KEY (original_owner_player_id) REFERENCES players(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'flags'::regclass
      AND conname = 'flags_contributed_by_player_id_fkey'
  ) THEN
    ALTER TABLE flags
      ADD CONSTRAINT flags_contributed_by_player_id_fkey
      FOREIGN KEY (contributed_by_player_id) REFERENCES players(id) ON DELETE RESTRICT;
  END IF;
END
$$;

ALTER TABLE flags
  DROP CONSTRAINT IF EXISTS flags_control_type_valid,
  ADD CONSTRAINT flags_control_type_valid
    CHECK (control_type IN ('personal', 'kingdom')),
  DROP CONSTRAINT IF EXISTS flags_control_state_valid,
  ADD CONSTRAINT flags_control_state_valid CHECK (
    (
      control_type = 'personal'
      AND kingdom_id IS NULL
      AND kingdom_affiliated_at IS NULL
    )
    OR
    (
      control_type = 'kingdom'
      AND kingdom_id IS NOT NULL
      AND kingdom_affiliated_at IS NOT NULL
      AND original_owner_player_id IS NOT NULL
      AND contributed_by_player_id IS NOT NULL
    )
  ),
  DROP CONSTRAINT IF EXISTS flags_original_personal_color_valid,
  ADD CONSTRAINT flags_original_personal_color_valid CHECK (
    original_personal_color IS NULL
    OR original_personal_color ~ '^#[0-9a-fA-F]{6}$'
  );

CREATE INDEX IF NOT EXISTS flags_control_type_idx
  ON flags (control_type, id);

CREATE INDEX IF NOT EXISTS flags_kingdom_controller_idx
  ON flags (kingdom_id, control_type, id)
  WHERE control_type = 'kingdom';

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
        AND kingdom_flag.control_type = 'kingdom'
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

DROP TRIGGER IF EXISTS flags_mixed_control_geometry ON flags;
CREATE CONSTRAINT TRIGGER flags_mixed_control_geometry
AFTER INSERT OR UPDATE ON flags
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION enforce_mixed_flag_control_geometry();

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
         AND ST_Distance(NEW.geom::geography, personal_flag.geom::geography)
               < NEW.territory_radius_m + personal_flag.claim_radius_m - tolerance_m
     ) THEN
    RAISE EXCEPTION 'Completed Kingdom Seat territory overlaps a personal flag'
      USING ERRCODE = '23514', CONSTRAINT = 'kingdom_seat_personal_flag_nonoverlap';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS kingdom_seats_personal_flag_geometry ON kingdom_seats;
CREATE CONSTRAINT TRIGGER kingdom_seats_personal_flag_geometry
AFTER INSERT OR UPDATE ON kingdom_seats
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION enforce_kingdom_seat_personal_geometry();

ALTER TABLE kingdom_flag_affiliation_history
  DROP CONSTRAINT IF EXISTS kingdom_flag_affiliation_history_action_valid,
  ADD CONSTRAINT kingdom_flag_affiliation_history_action_valid CHECK (
    action IN (
      'affiliated', 'removed', 'released', 'pruned', 'flag_deleted',
      'kingdom_dissolved', 'restored_on_dissolution'
    )
  );
