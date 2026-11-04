DO $$
DECLARE
  invalid_id text;
BEGIN
  SELECT id::text
  INTO invalid_id
  FROM flags
  WHERE lat NOT BETWEEN -90 AND 90
     OR lon NOT BETWEEN -180 AND 180
     OR ST_IsEmpty(geom)
     OR abs(ST_Y(geom) - lat) > 0.000000001
     OR abs(ST_X(geom) - lon) > 0.000000001
  ORDER BY id
  LIMIT 1;
  IF invalid_id IS NOT NULL THEN
    RAISE EXCEPTION 'flag % has invalid or inconsistent coordinates', invalid_id
      USING ERRCODE = '23514', CONSTRAINT = 'flags_coordinate_domain';
  END IF;

  SELECT id
  INTO invalid_id
  FROM players
  WHERE lat NOT BETWEEN -90 AND 90
     OR lon NOT BETWEEN -180 AND 180
     OR anchor_lat NOT BETWEEN -90 AND 90
     OR anchor_lon NOT BETWEEN -180 AND 180
     OR ST_IsEmpty(geom)
     OR abs(ST_Y(geom) - lat) > 0.000000001
     OR abs(ST_X(geom) - lon) > 0.000000001
  ORDER BY id
  LIMIT 1;
  IF invalid_id IS NOT NULL THEN
    RAISE EXCEPTION 'player % has invalid or inconsistent coordinates', invalid_id
      USING ERRCODE = '23514', CONSTRAINT = 'players_coordinate_domain';
  END IF;

  SELECT f.id::text
  INTO invalid_id
  FROM flags f
  LEFT JOIN players p ON p.id = f.owner_id
  WHERE p.id IS NULL
  ORDER BY f.id
  LIMIT 1;
  IF invalid_id IS NOT NULL THEN
    RAISE EXCEPTION 'flag % has no matching player owner', invalid_id
      USING ERRCODE = '23503', CONSTRAINT = 'flags_owner_id_fkey';
  END IF;
END
$$;

ALTER TABLE flags
  ADD CONSTRAINT flags_coordinate_domain
  CHECK (
    lat BETWEEN -90 AND 90
    AND lon BETWEEN -180 AND 180
    AND NOT ST_IsEmpty(geom)
    AND abs(ST_Y(geom) - lat) <= 0.000000001
    AND abs(ST_X(geom) - lon) <= 0.000000001
  ) NOT VALID;

ALTER TABLE players
  ADD CONSTRAINT players_coordinate_domain
  CHECK (
    lat BETWEEN -90 AND 90
    AND lon BETWEEN -180 AND 180
    AND anchor_lat BETWEEN -90 AND 90
    AND anchor_lon BETWEEN -180 AND 180
    AND NOT ST_IsEmpty(geom)
    AND abs(ST_Y(geom) - lat) <= 0.000000001
    AND abs(ST_X(geom) - lon) <= 0.000000001
  ) NOT VALID;

ALTER TABLE flags
  ADD CONSTRAINT flags_owner_id_fkey
  FOREIGN KEY (owner_id) REFERENCES players(id) ON DELETE RESTRICT NOT VALID;

ALTER TABLE flags VALIDATE CONSTRAINT flags_coordinate_domain;
ALTER TABLE players VALIDATE CONSTRAINT players_coordinate_domain;
ALTER TABLE flags VALIDATE CONSTRAINT flags_owner_id_fkey;
