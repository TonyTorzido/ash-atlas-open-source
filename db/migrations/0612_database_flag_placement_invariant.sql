-- Preserve the established rule: a newly written flag center may not be inside
-- an existing flag's claim. Claim edges may overlap when the new center is legal.
DO $$
DECLARE
  conflict_newer uuid;
  conflict_existing uuid;
BEGIN
  SELECT newer.id, existing.id
  INTO conflict_newer, conflict_existing
  FROM flags newer
  JOIN flags existing
    ON existing.id <> newer.id
   AND (newer.created_at, newer.id) > (existing.created_at, existing.id)
  WHERE ST_DWithin(
    existing.geom::geography,
    newer.geom::geography,
    existing.claim_radius_m + 0.05
  )
  ORDER BY newer.created_at, newer.id, existing.created_at, existing.id
  LIMIT 1;

  IF conflict_newer IS NOT NULL THEN
    RAISE EXCEPTION
      'existing flag % has a center inside the claim of older flag %',
      conflict_newer,
      conflict_existing
      USING ERRCODE = '23514',
            CONSTRAINT = 'flags_center_outside_existing_claim';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION enforce_flag_center_outside_existing_claim()
RETURNS trigger AS $$
DECLARE
  covering_flag_id uuid;
BEGIN
  -- The transaction lock makes the spatial check and subsequent row write one
  -- serializable placement decision across every application process.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ash-atlas-flag-placement-v1', 0)
  );

  SELECT existing.id
  INTO covering_flag_id
  FROM flags existing
  WHERE existing.id <> NEW.id
    AND ST_DWithin(
      existing.geom::geography,
      NEW.geom::geography,
      existing.claim_radius_m + 0.05
    )
  ORDER BY ST_Distance(existing.geom::geography, NEW.geom::geography), existing.id
  LIMIT 1;

  IF covering_flag_id IS NOT NULL THEN
    RAISE EXCEPTION
      'flag center is inside existing claim %',
      covering_flag_id
      USING ERRCODE = '23514',
            CONSTRAINT = 'flags_center_outside_existing_claim';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS flags_center_outside_existing_claim ON flags;
CREATE TRIGGER flags_center_outside_existing_claim
BEFORE INSERT OR UPDATE OF lat, lon, geom ON flags
FOR EACH ROW
EXECUTE FUNCTION enforce_flag_center_outside_existing_claim();
