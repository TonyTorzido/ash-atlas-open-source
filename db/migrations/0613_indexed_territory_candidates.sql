DO $$
DECLARE
  invalid_flag_id uuid;
  invalid_radius double precision;
BEGIN
  SELECT id, claim_radius_m
  INTO invalid_flag_id, invalid_radius
  FROM flags
  WHERE claim_radius_m <= 0
     OR claim_radius_m > 10000
  ORDER BY id
  LIMIT 1;

  IF invalid_flag_id IS NOT NULL THEN
    RAISE EXCEPTION
      'flag % has invalid claim_radius_m %; expected (0, 10000]',
      invalid_flag_id,
      invalid_radius
      USING ERRCODE = '23514',
            CONSTRAINT = 'flags_claim_radius_m_domain';
  END IF;
END
$$;

ALTER TABLE flags
  ADD CONSTRAINT flags_claim_radius_m_domain
  CHECK (claim_radius_m > 0 AND claim_radius_m <= 10000);

CREATE INDEX flags_geography_gix
  ON flags
  USING gist ((geom::geography));
