-- Allow one live Monument of each supported type while preserving legacy rows.

UPDATE city_structures
SET district_type = 'mining'
WHERE structure_type = 'monument'
  AND district_type = 'fashion';

UPDATE cities
SET selected_district = 'mining'
WHERE selected_district = 'fashion';

DROP INDEX IF EXISTS city_structures_one_reserved_monument_idx;

CREATE UNIQUE INDEX city_structures_one_reserved_monument_idx
  ON city_structures (city_id, district_type)
  WHERE structure_type = 'monument'
    AND state IN ('constructing', 'active');

ALTER TABLE city_structures
  DROP CONSTRAINT city_structures_district_shape_check;

ALTER TABLE city_structures
  ADD CONSTRAINT city_structures_district_shape_check CHECK (
    (
      structure_type = 'monument'
      AND district_type IN ('mining', 'forestry', 'hunting')
    )
    OR (structure_type <> 'monument' AND district_type IS NULL)
  );

ALTER TABLE cities
  DROP CONSTRAINT cities_selected_district_valid;

ALTER TABLE cities
  ADD CONSTRAINT cities_selected_district_valid CHECK (
    selected_district IS NULL
    OR selected_district IN ('mining', 'forestry', 'hunting')
  );
