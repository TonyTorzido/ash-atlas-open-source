CREATE TABLE world_beacons (
  code text PRIMARY KEY CHECK (code ~ '^(NA|SA|EU|AF|AS|OC)-[1-3]$'),
  name text NOT NULL UNIQUE,
  continent text NOT NULL CHECK (continent IN (
    'North America', 'South America', 'Europe', 'Africa', 'Asia', 'Oceania'
  )),
  general_region text NOT NULL,
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
  geom geometry(Point, 4326) NOT NULL,
  district_radius_m double precision NOT NULL DEFAULT 10000
    CHECK (district_radius_m = 10000),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX world_beacons_active_geom_gix ON world_beacons USING gist (geom) WHERE active;

INSERT INTO world_beacons (code, name, continent, general_region, lat, lon, geom) VALUES
  ('NA-1','Mackenzie Beacon','North America','Western Canada',61.0179864,-118,ST_SetSRID(ST_MakePoint(-118,61.0179864),4326)),
  ('NA-2','Prairie Beacon','North America','Central United States',42,-92,ST_SetSRID(ST_MakePoint(-92,42),4326)),
  ('NA-3','Caribbean Beacon','North America','Central America',15,-85,ST_SetSRID(ST_MakePoint(-85,15),4326)),
  ('SA-1','Amazon Beacon','South America','Western Amazon',-4,-68,ST_SetSRID(ST_MakePoint(-68,-4),4326)),
  ('SA-2','Cerrado Beacon','South America','Central Brazil',-13,-50,ST_SetSRID(ST_MakePoint(-50,-13),4326)),
  ('SA-3','Patagonia Beacon','South America','Northern Patagonia',-37,-69,ST_SetSRID(ST_MakePoint(-69,-37),4326)),
  ('EU-1','Gaul Beacon','Europe','Western Europe',45.5,2.5,ST_SetSRID(ST_MakePoint(2.5,45.5),4326)),
  ('EU-2','Nordic Beacon','Europe','Scandinavia',61,15,ST_SetSRID(ST_MakePoint(15,61),4326)),
  ('EU-3','Volga Beacon','Europe','Eastern Europe',55,45,ST_SetSRID(ST_MakePoint(45,55),4326)),
  ('AF-1','Sahel Beacon','Africa','Western Sahel',13,3,ST_SetSRID(ST_MakePoint(3,13),4326)),
  ('AF-2','Nile Beacon','Africa','Northeast Africa',12,29,ST_SetSRID(ST_MakePoint(29,12),4326)),
  ('AF-3','Zambezi Beacon','Africa','Southern Africa',-18,27.5,ST_SetSRID(ST_MakePoint(27.5,-18),4326)),
  ('AS-1','Persian Beacon','Asia','Western Asia',34,55,ST_SetSRID(ST_MakePoint(55,34),4326)),
  ('AS-2','Siberian Beacon','Asia','Central Siberia',59,116,ST_SetSRID(ST_MakePoint(116,59),4326)),
  ('AS-3','Karst Beacon','Asia','Southern China',27,109,ST_SetSRID(ST_MakePoint(109,27),4326)),
  ('OC-1','Wheatbelt Beacon','Oceania','Western Australia',-31,118,ST_SetSRID(ST_MakePoint(118,-31),4326)),
  ('OC-2','Outback Beacon','Oceania','Central Australia',-23,143,ST_SetSRID(ST_MakePoint(143,-23),4326)),
  ('OC-3','Aoraki Beacon','Oceania','South Island',-42.9955034,171,ST_SetSRID(ST_MakePoint(171,-42.9955034),4326));

ALTER TABLE players ADD COLUMN home_beacon_id text NULL REFERENCES world_beacons(code) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION enforce_immutable_player_home_beacon() RETURNS trigger AS $$
BEGIN
  IF OLD.home_beacon_id IS NOT NULL AND NEW.home_beacon_id IS DISTINCT FROM OLD.home_beacon_id THEN
    RAISE EXCEPTION 'player home beacon is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'players_home_beacon_immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER players_home_beacon_immutable
BEFORE UPDATE OF home_beacon_id ON players
FOR EACH ROW EXECUTE FUNCTION enforce_immutable_player_home_beacon();

CREATE TABLE player_discovered_beacons (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  beacon_id text NOT NULL REFERENCES world_beacons(code) ON DELETE RESTRICT,
  first_visited_at timestamptz NOT NULL DEFAULT now(),
  last_visited_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, beacon_id)
);

CREATE TABLE beacon_spawn_assignments (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  beacon_id text NOT NULL REFERENCES world_beacons(code) ON DELETE RESTRICT,
  slot_index integer NOT NULL CHECK (slot_index BETWEEN 0 AND 95),
  slot_generation integer NOT NULL CHECK (slot_generation >= 0),
  lat double precision NOT NULL,
  lon double precision NOT NULL,
  geom geometry(Point, 4326) NOT NULL,
  algorithm_version text NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (beacon_id, slot_index, slot_generation)
);
CREATE INDEX beacon_spawn_assignments_geom_gix ON beacon_spawn_assignments USING gist (geom);

ALTER TABLE player_world_map_destination_preferences
  ALTER COLUMN destination_id TYPE text USING destination_id::text;

ALTER TABLE player_world_map_destination_preferences
  DROP CONSTRAINT player_world_map_destination_preferences_kind,
  ADD CONSTRAINT player_world_map_destination_preferences_kind
    CHECK (destination_kind IN ('city', 'manor', 'kingdom', 'atlas_shrine', 'beacon'));

DO $$
DECLARE incompatible text;
DECLARE incompatible_buildables text;
BEGIN
  SELECT string_agg(flag.id::text, ', ' ORDER BY flag.id::text)
  INTO incompatible
  FROM flags flag
  WHERE EXISTS (
    SELECT 1 FROM world_beacons beacon
    WHERE beacon.active
      AND ST_DWithin(flag.geom::geography, beacon.geom::geography, 10000)
  ) AND NOT (
    flag.control_type = 'personal'
    AND flag.city_id IS NULL
    AND flag.kingdom_id IS NULL
    AND flag.reinforcement_level <= 1
    AND flag.atlas_shrine_slot_number IS NULL
    AND flag.anchor_kind = 'flag'
    AND NOT EXISTS (
      SELECT 1 FROM world_beacons footprint
      WHERE footprint.active
        AND ST_DWithin(flag.geom::geography, footprint.geom::geography, 650)
    )
  );
  IF incompatible IS NOT NULL THEN
    RAISE EXCEPTION 'Beacon migration blocked by incompatible flags: %', incompatible
      USING ERRCODE = '23514';
  END IF;
  SELECT string_agg(kind || ':' || id, ', ' ORDER BY kind, id)
  INTO incompatible_buildables
  FROM (
    SELECT 'city' kind, id::text id, hall_geom geom FROM cities WHERE active
    UNION ALL SELECT 'city_structure', structure_id::text, geom FROM city_structures WHERE state IN ('constructing','active')
    UNION ALL SELECT 'kingdom_seat', id::text, geom FROM kingdom_seats WHERE status IN ('active','relocating')
    UNION ALL SELECT 'kingdom_cot', id::text, geom FROM kingdom_cots WHERE status = 'active'
    UNION ALL SELECT 'kingdom_decoration', id::text, geom FROM kingdom_decorations WHERE status = 'active'
    UNION ALL SELECT 'furnace', furnace_id::text, geom FROM player_furnaces WHERE removed_at IS NULL
    UNION ALL SELECT 'furnace_build', build_id::text, geom FROM furnace_build_jobs WHERE status = 'constructing'
    UNION ALL SELECT 'tannery', tannery_id::text, geom FROM player_tanneries WHERE removed_at IS NULL
    UNION ALL SELECT 'tannery_build', build_id::text, geom FROM tannery_build_jobs WHERE status = 'constructing'
    UNION ALL SELECT 'butcher', butcher_id::text, geom FROM player_butchers WHERE removed_at IS NULL
    UNION ALL SELECT 'butcher_build', build_id::text, geom FROM butcher_build_jobs WHERE status = 'constructing'
    UNION ALL SELECT 'manor', id::text, geom FROM player_manors WHERE built_at IS NOT NULL
  ) buildable
  WHERE EXISTS (SELECT 1 FROM world_beacons beacon WHERE beacon.active
    AND ST_DWithin(buildable.geom::geography, beacon.geom::geography, 10000));
  IF incompatible_buildables IS NOT NULL THEN
    RAISE EXCEPTION 'Beacon migration blocked by incompatible buildables: %', incompatible_buildables
      USING ERRCODE = '23514';
  END IF;
END
$$;

UPDATE flags flag
SET access_mode = 'public', jump_toll_gold = 0
WHERE EXISTS (
  SELECT 1 FROM world_beacons beacon
  WHERE beacon.active
    AND ST_DWithin(flag.geom::geography, beacon.geom::geography, 10000)
);

CREATE OR REPLACE FUNCTION enforce_beacon_district_flag_policy() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM world_beacons beacon
    WHERE beacon.active
      AND ST_DWithin(NEW.geom::geography, beacon.geom::geography, 10000)
  ) THEN
    IF EXISTS (
      SELECT 1 FROM world_beacons beacon
      WHERE beacon.active
        AND ST_DWithin(NEW.geom::geography, beacon.geom::geography, 650)
    ) THEN
      RAISE EXCEPTION 'Flags cannot overlap beacon footprint or arrival geometry'
        USING ERRCODE = '23514', CONSTRAINT = 'flags_beacon_arrival_clearance';
    END IF;
    IF NEW.control_type <> 'personal'
       OR NEW.city_id IS NOT NULL OR NEW.kingdom_id IS NOT NULL
       OR NEW.reinforcement_level > 1
       OR NEW.atlas_shrine_slot_number IS NOT NULL
       OR NEW.anchor_kind <> 'flag' THEN
      RAISE EXCEPTION 'Only ordinary personal flags up to stone reinforcement are allowed in a beacon district'
        USING ERRCODE = '23514', CONSTRAINT = 'flags_beacon_district_policy';
    END IF;
    NEW.access_mode := 'public';
    NEW.jump_toll_gold := 0;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER zz_flags_beacon_district_policy
BEFORE INSERT OR UPDATE ON flags
FOR EACH ROW EXECUTE FUNCTION enforce_beacon_district_flag_policy();

CREATE OR REPLACE FUNCTION reject_beacon_district_buildable() RETURNS trigger AS $$
DECLARE candidate geometry;
BEGIN
  candidate := ST_SetSRID(ST_MakePoint(
    (to_jsonb(NEW)->>TG_ARGV[1])::double precision,
    (to_jsonb(NEW)->>TG_ARGV[0])::double precision
  ),4326);
  IF EXISTS (
    SELECT 1 FROM world_beacons beacon
    WHERE beacon.active AND ST_DWithin(candidate::geography, beacon.geom::geography, 10000)
  ) THEN
    RAISE EXCEPTION '% is not allowed in a beacon district', TG_TABLE_NAME
      USING ERRCODE = '23514', CONSTRAINT = 'beacon_district_buildable_policy';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cities_beacon_district_policy BEFORE INSERT OR UPDATE ON cities
FOR EACH ROW WHEN (NEW.active) EXECUTE FUNCTION reject_beacon_district_buildable('hall_lat','hall_lon');
CREATE TRIGGER city_structures_beacon_district_policy BEFORE INSERT OR UPDATE ON city_structures
FOR EACH ROW WHEN (NEW.state IN ('constructing','active')) EXECUTE FUNCTION reject_beacon_district_buildable('lat','lon');
CREATE TRIGGER kingdom_seats_beacon_district_policy BEFORE INSERT OR UPDATE ON kingdom_seats
FOR EACH ROW WHEN (NEW.status IN ('active','relocating')) EXECUTE FUNCTION reject_beacon_district_buildable('lat','lon');
CREATE TRIGGER kingdom_cots_beacon_district_policy BEFORE INSERT OR UPDATE ON kingdom_cots
FOR EACH ROW WHEN (NEW.status = 'active') EXECUTE FUNCTION reject_beacon_district_buildable('lat','lon');
CREATE TRIGGER kingdom_decorations_beacon_district_policy BEFORE INSERT OR UPDATE ON kingdom_decorations
FOR EACH ROW WHEN (NEW.status = 'active') EXECUTE FUNCTION reject_beacon_district_buildable('lat','lon');
CREATE TRIGGER player_furnaces_beacon_district_policy BEFORE INSERT OR UPDATE ON player_furnaces
FOR EACH ROW WHEN (NEW.removed_at IS NULL) EXECUTE FUNCTION reject_beacon_district_buildable('lat','lon');
CREATE TRIGGER furnace_build_jobs_beacon_district_policy BEFORE INSERT OR UPDATE ON furnace_build_jobs
FOR EACH ROW WHEN (NEW.status = 'constructing') EXECUTE FUNCTION reject_beacon_district_buildable('lat','lon');
CREATE TRIGGER player_tanneries_beacon_district_policy BEFORE INSERT OR UPDATE ON player_tanneries
FOR EACH ROW WHEN (NEW.removed_at IS NULL) EXECUTE FUNCTION reject_beacon_district_buildable('lat','lon');
CREATE TRIGGER tannery_build_jobs_beacon_district_policy BEFORE INSERT OR UPDATE ON tannery_build_jobs
FOR EACH ROW WHEN (NEW.status = 'constructing') EXECUTE FUNCTION reject_beacon_district_buildable('lat','lon');
CREATE TRIGGER player_butchers_beacon_district_policy BEFORE INSERT OR UPDATE ON player_butchers
FOR EACH ROW WHEN (NEW.removed_at IS NULL) EXECUTE FUNCTION reject_beacon_district_buildable('lat','lon');
CREATE TRIGGER butcher_build_jobs_beacon_district_policy BEFORE INSERT OR UPDATE ON butcher_build_jobs
FOR EACH ROW WHEN (NEW.status = 'constructing') EXECUTE FUNCTION reject_beacon_district_buildable('lat','lon');
CREATE TRIGGER player_manors_beacon_district_policy BEFORE INSERT OR UPDATE ON player_manors
FOR EACH ROW WHEN (NEW.built_at IS NOT NULL) EXECUTE FUNCTION reject_beacon_district_buildable('world_lat','world_lon');

COMMENT ON TABLE world_beacons IS 'Stable authoritative catalog of the eighteen Beacon Frontiers.';
COMMENT ON TABLE player_discovered_beacons IS 'Arrival ledger for future gated rollout; never gates current World Map visibility or travel.';
COMMENT ON COLUMN world_beacons.district_radius_m IS 'Exact 10000m geodesic district; flag centers also maintain 650m collision-safe beacon clearance.';
