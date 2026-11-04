-- Repair catch snapshot fields introduced after the original fishing rows were
-- written. The encounter is the retained cast-time authority for these
-- values; no new waterbody identity is inferred here.
UPDATE fishing_catch_records AS catches
SET fish_species = CASE
      WHEN catches.ashen THEN 'ashen_fish'
      WHEN catches.waterbody_kind = 'ocean' THEN 'ocean_fish'
      ELSE 'freshwater_fish'
    END,
    percentile = COALESCE(encounters.size_percentile, catches.percentile),
    region_name = CASE
      WHEN NULLIF(BTRIM(encounters.region_name), '') IS NOT NULL
        THEN BTRIM(encounters.region_name)
      ELSE catches.region_name
    END,
    country_name = CASE
      WHEN NULLIF(BTRIM(encounters.country_name), '') IS NOT NULL
        THEN BTRIM(encounters.country_name)
      ELSE catches.country_name
    END
FROM fishing_encounters AS encounters
WHERE catches.encounter_id = encounters.encounter_id;
