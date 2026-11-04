-- Fix forward: backfill the independent ocean Sulfur family for ready plans
-- that were completed before the density-domain compiler existed. The
-- migration repeats the compiler's equal-area domain, candidate ranking, and
-- UUID identity rules from retained habitat snapshots. It never edits a
-- ready plan or an existing immutable authority row.

CREATE OR REPLACE FUNCTION population_ocean_sulfur_hash_parts_v1(
  VARIADIC parts text[]
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
DECLARE
  part text;
  serialized text := '';
BEGIN
  FOREACH part IN ARRAY parts LOOP
    serialized := serialized
      || octet_length(convert_to(part, 'UTF8'))::text
      || ':' || part || '|';
  END LOOP;
  RETURN encode(sha256(convert_to(serialized, 'UTF8')), 'hex');
END;
$$;

CREATE OR REPLACE FUNCTION population_ocean_sulfur_hash_unit_v1(
  VARIADIC parts text[]
)
RETURNS double precision
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
DECLARE
  digest text := population_ocean_sulfur_hash_parts_v1(VARIADIC parts);
  value double precision := 0;
  digit integer;
  index integer;
BEGIN
  FOR index IN 1..13 LOOP
    digit := strpos('0123456789abcdef', substr(digest, index, 1)) - 1;
    value := value * 16 + digit;
  END LOOP;
  RETURN value / 4503599627370496.0;
END;
$$;

CREATE OR REPLACE FUNCTION population_ocean_sulfur_base36_v1(
  input_value integer
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
DECLARE
  value integer := input_value;
  remainder integer;
  result text := '';
  alphabet constant text := '0123456789abcdefghijklmnopqrstuvwxyz';
BEGIN
  IF value < 0 THEN
    RAISE EXCEPTION 'ocean Sulfur base36 value must be non-negative'
      USING ERRCODE = '22023';
  END IF;
  IF value = 0 THEN RETURN '0'; END IF;
  WHILE value > 0 LOOP
    remainder := value % 36;
    result := substr(alphabet, remainder + 1, 1) || result;
    value := value / 36;
  END LOOP;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION population_ocean_sulfur_domain_v1(
  latitude double precision,
  longitude double precision
)
RETURNS TABLE (
  domain_id text,
  center_latitude double precision,
  center_longitude double precision,
  area_km2 double precision,
  south_latitude double precision,
  north_latitude double precision,
  west_longitude double precision,
  east_longitude double precision
)
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
DECLARE
  earth_radius_m constant double precision := 6371008.8;
  target_area_m2 constant double precision := 30000000.0;
  band_count constant integer :=
    round(pi() * earth_radius_m / sqrt(target_area_m2))::integer;
  radians_per_band constant double precision := pi() / band_count;
  degrees_per_band constant double precision := 180.0 / band_count;
  band_index integer;
  south_radians double precision;
  north_radians double precision;
  band_area_m2 double precision;
  column_count integer;
  normalized_longitude double precision;
  column_index integer;
  longitude_span double precision;
BEGIN
  IF latitude < -90 OR latitude > 90
     OR longitude < -180 OR longitude > 180
     OR latitude = 'NaN'::double precision
     OR longitude = 'NaN'::double precision THEN
    RAISE EXCEPTION 'ocean Sulfur coordinate is outside its canonical domain'
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
    round(band_area_m2 / target_area_m2)::integer
  );
  normalized_longitude := longitude
    - 360.0 * floor((longitude + 180.0) / 360.0);
  IF normalized_longitude = -180 AND longitude > 0 THEN
    normalized_longitude := 180;
  END IF;
  column_index := CASE
    WHEN abs(latitude) = 90 THEN 0
    ELSE LEAST(
      column_count - 1,
      floor(
        ((normalized_longitude + 180.0) / 360.0) * column_count
      )::integer
    )
  END;
  longitude_span := 360.0 / column_count;

  domain_id := 'ocean-sulfur-domain-v1/'
    || population_ocean_sulfur_base36_v1(band_index)
    || '/' || population_ocean_sulfur_base36_v1(column_index);
  center_latitude := degrees(
    asin((sin(south_radians) + sin(north_radians)) / 2.0)
  );
  center_longitude := -180.0 + column_index * longitude_span
    + longitude_span / 2.0;
  IF center_longitude >= 180 THEN center_longitude := -180; END IF;
  area_km2 := band_area_m2 / column_count / 1000000.0;
  south_latitude := degrees(south_radians);
  north_latitude := degrees(north_radians);
  west_longitude := -180.0 + column_index * longitude_span;
  east_longitude := CASE
    WHEN column_index = column_count - 1 THEN 180.0
    ELSE west_longitude + longitude_span
  END;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION population_ocean_sulfur_domain_slot_v1(
  domain_id text,
  world_environment_identity_key text,
  south_latitude double precision,
  north_latitude double precision,
  west_longitude double precision,
  east_longitude double precision
)
RETURNS TABLE (
  latitude double precision,
  longitude double precision
)
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
DECLARE
  latitude_unit double precision := population_ocean_sulfur_hash_unit_v1(
    'ocean-sulfur-domain-slot-v1', world_environment_identity_key,
    domain_id, 'latitude'
  );
  longitude_unit double precision := population_ocean_sulfur_hash_unit_v1(
    'ocean-sulfur-domain-slot-v1', world_environment_identity_key,
    domain_id, 'longitude'
  );
  south_sine double precision := sin(radians(south_latitude));
  north_sine double precision := sin(radians(north_latitude));
BEGIN
  latitude := degrees(asin(
    south_sine + (north_sine - south_sine) * latitude_unit
  ));
  longitude := west_longitude
    + (east_longitude - west_longitude) * longitude_unit;
  IF longitude >= 180 THEN longitude := -180; END IF;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION population_ocean_sulfur_uuid_v8_v1(
  namespace text,
  value jsonb
)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  WITH canonical AS (
    SELECT CASE WHEN value ? 'slotId' THEN
      '{"candidateId":' || to_json(value->>'candidateId')::text
      || ',"domainId":' || to_json(value->>'domainId')::text
      || ',"ownerZoneId":' || to_json(value->>'ownerZoneId')::text
      || ',"placementVersion":' || to_json(value->>'placementVersion')::text
      || ',"slotId":' || to_json(value->>'slotId')::text
      || ',"worldEnvironmentIdentityKey":'
      || to_json(value->>'worldEnvironmentIdentityKey')::text || '}'
    ELSE
      '{"candidateId":' || to_json(value->>'candidateId')::text
      || ',"domainId":' || to_json(value->>'domainId')::text
      || ',"ownerZoneId":' || to_json(value->>'ownerZoneId')::text
      || ',"placementVersion":' || to_json(value->>'placementVersion')::text
      || ',"worldEnvironmentIdentityKey":'
      || to_json(value->>'worldEnvironmentIdentityKey')::text || '}'
    END AS serialized
  )
  , digest AS (
    SELECT encode(
      substr(
        sha256(
          convert_to(namespace, 'UTF8')
          || decode('00', 'hex')
          || convert_to(canonical.serialized, 'UTF8')
        ),
        1, 16
      ),
      'hex'
    ) AS hex
    FROM canonical
  )
  SELECT (
    overlay(
      overlay(hex PLACING '8' FROM 13 FOR 1)
      PLACING substr(
        '89ab',
        ((strpos('0123456789abcdef', substr(hex, 17, 1)) - 1) % 4) + 1,
        1
      ) FROM 17 FOR 1
    )::text
  )::uuid
  FROM digest;
$$;

LOCK TABLE population_zones_v2,
  population_spawn_slots_v2,
  population_ocean_sulfur_authority_v1,
  population_plan_ocean_sulfur_v1,
  population_entity_state_v2,
  population_zone_cutovers_v2,
  repeatable_resource_nodes
IN SHARE ROW EXCLUSIVE MODE;

-- Ready plans and their slots are immutable during normal operation. This
-- migration is the authorized forward repair, so temporarily suspend only
-- the slot trigger while preserving the ready-plan trigger itself.
DROP TRIGGER IF EXISTS population_spawn_slots_v2_protect_ready
  ON population_spawn_slots_v2;

CREATE TEMP TABLE population_ocean_sulfur_backfill_v1 (
  plan_id uuid NOT NULL,
  zone_id text NOT NULL,
  world_environment_identity_key text NOT NULL,
  region_code text NOT NULL,
  candidate_layout_version text NOT NULL,
  domain_id text NOT NULL,
  site_id text NOT NULL,
  latitude double precision NOT NULL,
  longitude double precision NOT NULL,
  environment_snapshot jsonb NOT NULL,
  candidate_id text NOT NULL,
  slot_id uuid NOT NULL,
  entity_id uuid NOT NULL,
  PRIMARY KEY (plan_id, entity_id)
) ON COMMIT DROP;

WITH source_sites AS (
  SELECT plan.plan_id AS source_plan_id,
         plan.zone_id AS source_zone_id,
         plan.world_environment_identity_key,
         plan.region_code,
         plan.candidate_layout_version,
         site.value AS site_json
  FROM population_zones_v2 AS plan
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(plan.habitat_snapshot->'candidateSites') = 'array'
        THEN plan.habitat_snapshot->'candidateSites'
      ELSE '[]'::jsonb
    END
  ) AS site(value)
  WHERE plan.status = 'ready'
    AND jsonb_typeof(plan.habitat_snapshot) = 'object'
), eligible_sites AS (
  SELECT source_sites.*,
         site_json->>'siteId' AS site_id,
         (site_json->'position'->>'lat')::double precision AS latitude,
         (site_json->'position'->>'lon')::double precision AS longitude
  FROM source_sites
  WHERE jsonb_typeof(site_json) = 'object'
    AND site_json->>'siteId' IS NOT NULL
    AND jsonb_typeof(site_json->'position') = 'object'
    AND site_json->'position'->>'lat' ~ '^-?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)$'
    AND site_json->'position'->>'lon' ~ '^-?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)$'
    AND (site_json->'position'->>'lat')::double precision BETWEEN -90 AND 90
    AND (site_json->'position'->>'lon')::double precision BETWEEN -180 AND 180
    AND site_json->>'surfaceType' = 'ocean'
    AND site_json->>'isSaltwater' = 'true'
    AND site_json->>'insideMajorLake' = 'false'
    AND jsonb_typeof(site_json->'surfaceAuthority') = 'object'
), deduplicated_sites AS (
  SELECT eligible_sites.*,
         row_number() OVER (
           PARTITION BY source_plan_id,
             round(latitude::numeric, 9), round(longitude::numeric, 9)
           ORDER BY site_id
         ) AS position_rank
  FROM eligible_sites
), domainized_sites AS (
  SELECT deduplicated_sites.*,
         domain.domain_id,
         domain.south_latitude,
         domain.north_latitude,
         domain.west_longitude,
         domain.east_longitude
  FROM deduplicated_sites
  CROSS JOIN LATERAL population_ocean_sulfur_domain_v1(
    latitude, longitude
  ) AS domain
  WHERE position_rank = 1
), domain_slots AS (
  -- The stable slot and its physical owner depend only on the world/domain.
  -- Materialize one row per domain before choosing a ready plan.  Looking up
  -- the owner once per candidate site makes this repair scale with occupied
  -- domains instead of repeatedly scanning every ready plan.
  SELECT DISTINCT ON (
    domainized_sites.world_environment_identity_key,
    domainized_sites.domain_id
  )
    domainized_sites.world_environment_identity_key,
    domainized_sites.domain_id,
    domainized_sites.south_latitude,
    domainized_sites.north_latitude,
    domainized_sites.west_longitude,
    domainized_sites.east_longitude,
    slot.latitude AS slot_latitude,
    slot.longitude AS slot_longitude,
    (population_zone_v2_owner_address_v2(slot.latitude, slot.longitude))[1]
      AS owner_band_index,
    (population_zone_v2_owner_address_v2(slot.latitude, slot.longitude))[2]
      AS owner_column_index
  FROM domainized_sites
  CROSS JOIN LATERAL population_ocean_sulfur_domain_slot_v1(
    domain_id,
    world_environment_identity_key,
    south_latitude,
    north_latitude,
    west_longitude,
    east_longitude
  ) AS slot
  ORDER BY domainized_sites.world_environment_identity_key,
           domainized_sites.domain_id
), owner_plans AS (
  SELECT DISTINCT ON (
    domain_slots.world_environment_identity_key,
    domain_slots.domain_id
  )
    domain_slots.world_environment_identity_key,
    domain_slots.domain_id,
    plan.plan_id AS owner_plan_id,
    plan.zone_id AS owner_zone_id
  FROM domain_slots
  JOIN population_zones_v2 AS plan
    ON plan.status = 'ready'
   AND plan.world_environment_identity_key
     = domain_slots.world_environment_identity_key
   AND plan.band_index = domain_slots.owner_band_index
   AND plan.column_index = domain_slots.owner_column_index
  LEFT JOIN population_zone_cutovers_v2 AS cutover
    ON cutover.zone_id = plan.zone_id
   AND cutover.geometry_version = plan.geometry_version
   AND cutover.serving_version = 'v2'
   AND cutover.status = 'stable'
   AND cutover.selected_plan_id = plan.plan_id
  ORDER BY domain_slots.world_environment_identity_key,
           domain_slots.domain_id,
           (cutover.selected_plan_id IS NOT NULL) DESC,
           plan.ready_at DESC NULLS LAST,
           plan.plan_id
), domain_candidates AS (
  SELECT domainized_sites.*,
         owner_plans.owner_plan_id,
         owner_plans.owner_zone_id
  FROM domainized_sites
  JOIN owner_plans
    ON owner_plans.world_environment_identity_key
      = domainized_sites.world_environment_identity_key
   AND owner_plans.domain_id = domainized_sites.domain_id
   AND owner_plans.owner_plan_id = domainized_sites.source_plan_id
), ranked_candidates AS (
  SELECT domain_candidates.*,
         row_number() OVER (
           PARTITION BY owner_plan_id, world_environment_identity_key,
             domain_id
           ORDER BY population_ocean_sulfur_hash_parts_v1(
             'ocean-sulfur-candidate-selection-v1',
             world_environment_identity_key, domain_id, site_id
           ), site_id
         ) AS selection_rank
  FROM domain_candidates
), selected_candidates AS (
  SELECT ranked_candidates.*,
         'ocean-sulfur/' || substring(
           population_ocean_sulfur_hash_parts_v1(
             'ocean-sulfur-placement-v1',
             world_environment_identity_key, domain_id, site_id
           ) FROM 1 FOR 40
         ) AS candidate_id
  FROM ranked_candidates
  WHERE selection_rank = 1
), identities AS (
  SELECT selected_candidates.*,
         jsonb_build_object(
           'candidateId', candidate_id,
           'domainId', domain_id,
           'ownerZoneId', owner_zone_id,
           'placementVersion', 'ocean-sulfur-placement-v1',
           'worldEnvironmentIdentityKey', world_environment_identity_key
         ) AS identity
  FROM selected_candidates
), materialized AS (
  SELECT identities.*,
         population_ocean_sulfur_uuid_v8_v1(
           'ocean-sulfur-deposit-slot-id-v1', identity
         ) AS slot_id
  FROM identities
), final_rows AS (
  SELECT materialized.*,
         population_ocean_sulfur_uuid_v8_v1(
           'ocean-sulfur-deposit-entity-id-v1',
           identity || jsonb_build_object('slotId', slot_id::text)
         ) AS entity_id,
         jsonb_build_object(
           'placementVersion', 'ocean-sulfur-placement-v1',
           'domainId', domain_id,
           'eligibilityRule',
             'ocean-saltwater-outside-major-lake-with-surface-authority',
           'siteId', site_json->>'siteId',
           'source', site_json->>'source',
           'sourceSampleId', site_json->>'sourceSampleId',
           'sourceCellId', site_json->'sourceCellId',
           'sourceSlotId', site_json->'sourceSlotId',
           'candidateSlotVersion', site_json->'candidateSlotVersion',
           'placementTags', COALESCE(site_json->'placementTags', '[]'::jsonb),
           'isSaltwater', (site_json->>'isSaltwater')::boolean,
           'insideMajorLake', (site_json->>'insideMajorLake')::boolean,
           'surfaceType', site_json->'surfaceType',
           'surfaceAuthority', site_json->'surfaceAuthority',
           'elevationBand', site_json->'elevationBand',
           'terrainClass', site_json->'terrainClass',
           'landCoverClass', site_json->'landCoverClass',
           'biomeId', site_json->'biomeId',
           'ecoregionId', site_json->'ecoregionId',
           'spawnProfileKey', site_json->>'spawnProfileKey'
         ) AS environment_snapshot
  FROM materialized
)
INSERT INTO population_ocean_sulfur_backfill_v1 (
  plan_id, zone_id, world_environment_identity_key, region_code,
  candidate_layout_version, domain_id, site_id, latitude, longitude,
  environment_snapshot, candidate_id, slot_id, entity_id
)
SELECT owner_plan_id, owner_zone_id, world_environment_identity_key,
       region_code, candidate_layout_version, domain_id, site_id,
       latitude, longitude, environment_snapshot, candidate_id,
       slot_id, entity_id
FROM final_rows;

-- Existing generated data may already contain a matching Sulfur identity from
-- a retried deployment. Reject an identity mismatch instead of silently
-- accepting it; this is the same immutable-authority rule used by the runtime.
DO $$
DECLARE
  conflict_rows text;
BEGIN
  SELECT jsonb_agg(to_jsonb(conflict) ORDER BY conflict.entity_id)::text
  INTO conflict_rows
  FROM (
    SELECT expected.entity_id::text,
           'spawn-slot' AS conflict_type,
           stored.plan_id::text AS stored_plan_id,
           expected.plan_id::text AS expected_plan_id
    FROM population_ocean_sulfur_backfill_v1 AS expected
    JOIN population_spawn_slots_v2 AS stored
      ON stored.entity_id = expected.entity_id
    WHERE stored.plan_id IS DISTINCT FROM expected.plan_id
       OR stored.slot_id IS DISTINCT FROM expected.slot_id
       OR stored.candidate_id IS DISTINCT FROM expected.candidate_id
       OR stored.entity_kind IS DISTINCT FROM 'sulfur'
       OR stored.archetype IS DISTINCT FROM 'sulfur_mine'
       OR stored.generation_id IS NOT NULL
       OR stored.latitude IS DISTINCT FROM expected.latitude
       OR stored.longitude IS DISTINCT FROM expected.longitude
       OR stored.anchor_latitude IS DISTINCT FROM expected.latitude
       OR stored.anchor_longitude IS DISTINCT FROM expected.longitude
       OR stored.environment_snapshot IS DISTINCT FROM expected.environment_snapshot
       OR stored.suppression_class IS DISTINCT FROM 'none'
    UNION ALL
    SELECT expected.entity_id::text,
           'authority' AS conflict_type,
           stored.owner_zone_id AS stored_plan_id,
           expected.zone_id AS expected_plan_id
    FROM population_ocean_sulfur_backfill_v1 AS expected
    JOIN population_ocean_sulfur_authority_v1 AS stored
      ON stored.entity_id = expected.entity_id
    WHERE stored.slot_id IS DISTINCT FROM expected.slot_id
       OR stored.candidate_id IS DISTINCT FROM expected.candidate_id
       OR stored.owner_zone_id IS DISTINCT FROM expected.zone_id
       OR stored.entity_kind IS DISTINCT FROM 'sulfur'
       OR stored.archetype IS DISTINCT FROM 'sulfur_mine'
       OR stored.placement_version IS DISTINCT FROM 'ocean-sulfur-placement-v1'
       OR stored.world_environment_identity_key
            IS DISTINCT FROM expected.world_environment_identity_key
       OR stored.latitude IS DISTINCT FROM expected.latitude
       OR stored.longitude IS DISTINCT FROM expected.longitude
       OR stored.anchor_latitude IS DISTINCT FROM expected.latitude
       OR stored.anchor_longitude IS DISTINCT FROM expected.longitude
       OR stored.environment_snapshot IS DISTINCT FROM expected.environment_snapshot
    UNION ALL
    SELECT expected.entity_id::text,
           'projection' AS conflict_type,
           stored.physical_population_zone_v2_id AS stored_plan_id,
           expected.zone_id AS expected_plan_id
    FROM population_ocean_sulfur_backfill_v1 AS expected
    JOIN repeatable_resource_nodes AS stored
      ON stored.population_v2_entity_id = expected.entity_id
    WHERE stored.id IS DISTINCT FROM expected.entity_id
       OR stored.node_type IS DISTINCT FROM 'sulfur_mine'
       OR stored.yield_item_id IS DISTINCT FROM 'sulfur'
       OR stored.yield_quantity IS DISTINCT FROM 1
       OR stored.regeneration_interval
            IS DISTINCT FROM interval '5 hours 50 minutes'
       OR stored.lat IS DISTINCT FROM expected.latitude
       OR stored.lon IS DISTINCT FROM expected.longitude
       OR stored.physical_population_zone_v2_id
            IS DISTINCT FROM expected.zone_id
       OR stored.population_cutover_suppressed IS DISTINCT FROM false
  ) AS conflict;
  IF conflict_rows IS NOT NULL THEN
    RAISE EXCEPTION 'ocean Sulfur density backfill found immutable identity conflicts'
      USING ERRCODE = '23514',
            CONSTRAINT = 'population_ocean_sulfur_density_backfill_identity',
            DETAIL = conflict_rows;
  END IF;
END;
$$;

INSERT INTO population_spawn_slots_v2 (
  plan_id, generation_id, slot_id, entity_id, candidate_id,
  entity_kind, archetype, encounter_id, pack_id, pack_member_index,
  latitude, longitude, geom, anchor_latitude, anchor_longitude,
  anchor_geom, environment_snapshot, suppression_class
)
SELECT plan_id, NULL, slot_id, entity_id, candidate_id,
       'sulfur', 'sulfur_mine', NULL, NULL, NULL,
       latitude, longitude,
       ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography,
       latitude, longitude,
       ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography,
       environment_snapshot, 'none'
FROM population_ocean_sulfur_backfill_v1
ON CONFLICT (entity_id) DO NOTHING;

INSERT INTO population_ocean_sulfur_authority_v1 (
  entity_id, slot_id, candidate_id, owner_zone_id,
  entity_kind, archetype, placement_version,
  yield_item_id, yield_quantity, regeneration_interval,
  timer_profession_id, timer_visibility_rank,
  world_environment_identity_key,
  latitude, longitude, anchor_latitude, anchor_longitude,
  environment_snapshot, suppression_class
)
SELECT entity_id, slot_id, candidate_id, zone_id,
       'sulfur', 'sulfur_mine', 'ocean-sulfur-placement-v1',
       'sulfur', 1, interval '5 hours 50 minutes',
       'miner', 2, world_environment_identity_key,
       latitude, longitude, latitude, longitude,
       environment_snapshot, 'none'
FROM population_ocean_sulfur_backfill_v1
ON CONFLICT (entity_id) DO NOTHING;

INSERT INTO population_entity_state_v2 (entity_id, state)
SELECT entity_id, 'ready'
FROM population_ocean_sulfur_backfill_v1
ON CONFLICT (entity_id) DO NOTHING;

-- Membership is established for every ready plan with the same physical zone
-- and World identity. A later cutover can therefore adopt the same immutable
-- authority without regenerating or renaming it.
INSERT INTO population_plan_ocean_sulfur_v1 (plan_id, entity_id)
SELECT plan.plan_id, backfill.entity_id
FROM population_ocean_sulfur_backfill_v1 AS backfill
JOIN population_zones_v2 AS plan
  ON plan.zone_id = backfill.zone_id
 AND plan.world_environment_identity_key
       = backfill.world_environment_identity_key
 AND plan.status = 'ready'
ON CONFLICT (plan_id, entity_id) DO NOTHING;

-- Only the currently served plan owns a visible projection. The projection
-- identity remains the same physical entity and is fenced to its cutover.
INSERT INTO repeatable_resource_nodes (
  id, node_type, region_code, lat, lon, geom,
  yield_item_id, yield_quantity, regeneration_interval,
  ready_at, harvest_revision, last_harvested_by,
  authored_source, placement_bucket_key, placement_version,
  population_v2_entity_id, physical_population_zone_v2_id,
  population_v2_plan_id, population_v2_state_revision,
  population_cutover_revision, population_cutover_suppressed
)
SELECT backfill.entity_id, 'sulfur_mine', plan.region_code,
       backfill.latitude, backfill.longitude,
       ST_SetSRID(ST_MakePoint(backfill.longitude, backfill.latitude), 4326),
       'sulfur', 1, interval '5 hours 50 minutes',
       '-infinity'::timestamptz, 0, NULL,
       'population-v2', 'population-v2:' || backfill.entity_id::text,
       plan.candidate_layout_version,
       backfill.entity_id, backfill.zone_id, plan.plan_id, 0,
       cutover.cutover_revision, false
FROM population_ocean_sulfur_backfill_v1 AS backfill
JOIN population_zone_cutovers_v2 AS cutover
  ON cutover.zone_id = backfill.zone_id
 AND cutover.serving_version = 'v2'
 AND cutover.status = 'stable'
JOIN population_zones_v2 AS plan
  ON plan.plan_id = cutover.selected_plan_id
 AND plan.status = 'ready'
 AND plan.zone_id = backfill.zone_id
 AND plan.world_environment_identity_key
       = backfill.world_environment_identity_key
ON CONFLICT (id) DO NOTHING;

-- Restore the normal ready-plan protection after the authorized append.
CREATE TRIGGER population_spawn_slots_v2_protect_ready
BEFORE INSERT OR UPDATE OR DELETE ON population_spawn_slots_v2
FOR EACH ROW EXECUTE FUNCTION protect_population_spawn_slot_v2_ready_plan();

COMMENT ON FUNCTION population_ocean_sulfur_domain_v1(double precision, double precision) IS
  'Deterministic equal-area approximately 30 km2 parent domain for ocean Sulfur.';
COMMENT ON FUNCTION population_ocean_sulfur_domain_slot_v1(
  text, text, double precision, double precision, double precision, double precision
) IS
  'Stable world-keyed owner slot for one ocean Sulfur density domain.';
