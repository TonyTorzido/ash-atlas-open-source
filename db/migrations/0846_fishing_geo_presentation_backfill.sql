-- Forward-only completion of durable presentation provenance for retained
-- fishing rows. 0845 established the nullable columns and canonical identity
-- backfill; this migration fills display metadata without changing identity.

UPDATE fishing_encounters
SET presentation_name = COALESCE(NULLIF(BTRIM(presentation_name), ''), NULLIF(BTRIM(waterbody_name), '')),
    presentation_relation = COALESCE(
      presentation_relation,
      CASE WHEN NULLIF(BTRIM(waterbody_source_id), '') IS NOT NULL THEN 'exact' ELSE NULL END
    ),
    presentation_distance_m = COALESCE(
      presentation_distance_m,
      CASE WHEN NULLIF(BTRIM(waterbody_source_id), '') IS NOT NULL THEN 0 ELSE NULL END
    )
WHERE presentation_name IS NULL
   OR presentation_relation IS NULL
   OR presentation_distance_m IS NULL;

UPDATE fishing_catch_records AS catches
SET presentation_name = COALESCE(
      NULLIF(BTRIM(catches.presentation_name), ''),
      NULLIF(BTRIM(encounters.presentation_name), ''),
      NULLIF(BTRIM(catches.waterbody_name), ''),
      NULLIF(BTRIM(encounters.waterbody_name), '')
    ),
    presentation_relation = COALESCE(
      catches.presentation_relation,
      encounters.presentation_relation,
      CASE WHEN NULLIF(BTRIM(catches.waterbody_source_id), '') IS NOT NULL THEN 'exact' ELSE NULL END
    ),
    presentation_distance_m = COALESCE(
      catches.presentation_distance_m,
      encounters.presentation_distance_m,
      CASE WHEN NULLIF(BTRIM(catches.waterbody_source_id), '') IS NOT NULL THEN 0 ELSE NULL END
    )
FROM fishing_encounters AS encounters
WHERE catches.encounter_id = encounters.encounter_id
  AND (
    catches.presentation_name IS NULL
    OR catches.presentation_relation IS NULL
    OR catches.presentation_distance_m IS NULL
  );
