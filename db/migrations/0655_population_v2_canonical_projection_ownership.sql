-- Fix forward: assign legacy projections to the same half-open physical owner
-- used by populationZoneV2IdForPoint. Inclusive polygon coverage is ambiguous
-- on shared latitude-band, column, and antimeridian boundaries.

CREATE OR REPLACE FUNCTION population_zone_v2_owner_address_v2(
  latitude double precision,
  longitude double precision
)
RETURNS integer[]
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
DECLARE
  earth_radius_m constant double precision := 6371008.8;
  band_count constant integer :=
    round(pi() * earth_radius_m / 1000.0)::integer;
  radians_per_band constant double precision := pi() / band_count;
  degrees_per_band constant double precision := 180.0 / band_count;
  band_index integer;
  south_radians double precision;
  north_radians double precision;
  band_area_m2 double precision;
  column_count integer;
  normalized_longitude double precision;
  column_index integer;
BEGIN
  IF latitude < -90 OR latitude > 90
     OR longitude < -180 OR longitude > 180
     OR latitude = 'NaN'::double precision
     OR longitude = 'NaN'::double precision THEN
    RAISE EXCEPTION 'population zone coordinate is outside its canonical domain'
      USING ERRCODE = '22023';
  END IF;

  band_index := CASE
    WHEN latitude = 90 THEN band_count - 1
    ELSE LEAST(
      band_count - 1,
      GREATEST(0, floor((latitude + 90.0) / degrees_per_band)::integer)
    )
  END;
  south_radians := -pi() / 2.0 + band_index * radians_per_band;
  north_radians := CASE
    WHEN band_index = band_count - 1 THEN pi() / 2.0
    ELSE south_radians + radians_per_band
  END;
  band_area_m2 := 2.0 * pi() * earth_radius_m * earth_radius_m
    * (sin(north_radians) - sin(south_radians));
  column_count := GREATEST(
    1,
    round(band_area_m2 / 1000000.0)::integer
  );

  IF abs(latitude) = 90 THEN
    column_index := 0;
  ELSE
    normalized_longitude := longitude
      - 360.0 * floor((longitude + 180.0) / 360.0);
    column_index := LEAST(
      column_count - 1,
      floor(
        ((normalized_longitude + 180.0) / 360.0) * column_count
      )::integer
    );
  END IF;

  RETURN ARRAY[band_index, column_index];
END;
$$;

CREATE OR REPLACE FUNCTION classify_v1_population_projection_cutover_v2()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  generated_v1 boolean := false;
  selected_zone_id text;
  selected_revision bigint;
BEGIN
  IF NEW.population_v2_entity_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'collectible_nodes' THEN
    generated_v1 := NEW.source_flag_id IS NOT NULL
      OR NEW.source_population_area_id IS NOT NULL;
  ELSIF TG_TABLE_NAME = 'generated_world_mobs' THEN
    generated_v1 := NEW.source_population_area_id IS NOT NULL;
  ELSIF TG_TABLE_NAME = 'repeatable_resource_nodes' THEN
    generated_v1 := true;
  END IF;
  IF NOT generated_v1 THEN
    RETURN NEW;
  END IF;

  SELECT cutover.zone_id, cutover.cutover_revision
  INTO selected_zone_id, selected_revision
  FROM population_zone_cutovers_v2 AS cutover
  JOIN population_zones_v2 AS plan
    ON plan.plan_id = cutover.selected_plan_id
  WHERE cutover.serving_version = 'v2'
    AND ARRAY[plan.band_index, plan.column_index] =
      population_zone_v2_owner_address_v2(NEW.lat, NEW.lon)
  ORDER BY cutover.cutover_revision DESC, cutover.zone_id
  LIMIT 1;

  IF selected_zone_id IS NULL THEN
    NEW.population_cutover_suppressed := false;
  ELSE
    NEW.physical_population_zone_v2_id := selected_zone_id;
    NEW.population_cutover_revision := selected_revision;
    NEW.population_cutover_suppressed := true;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION population_zone_v2_owner_address_v2(
  double precision,
  double precision
) IS
  'Canonical half-open equal-area latitude-band owner address [band,column].';
