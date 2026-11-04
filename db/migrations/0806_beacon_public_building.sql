-- Beacons are travel points, not construction exclusion zones. Keep district
-- flags public and toll-free while leaving ordinary construction rules intact.
CREATE OR REPLACE FUNCTION enforce_beacon_district_flag_policy() RETURNS trigger AS $$
BEGIN
  -- Nonpersonal flags retain their existing city/control access authority.
  IF NEW.control_type = 'personal' AND EXISTS (
    SELECT 1 FROM world_beacons beacon
    WHERE beacon.active
      AND ST_DWithin(NEW.geom::geography, beacon.geom::geography, 10000)
  ) THEN
    NEW.access_mode := 'public';
    NEW.jump_toll_gold := 0;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER cities_beacon_district_policy ON cities;
DROP TRIGGER city_structures_beacon_district_policy ON city_structures;
DROP TRIGGER kingdom_seats_beacon_district_policy ON kingdom_seats;
DROP TRIGGER kingdom_cots_beacon_district_policy ON kingdom_cots;
DROP TRIGGER kingdom_decorations_beacon_district_policy ON kingdom_decorations;
DROP TRIGGER player_furnaces_beacon_district_policy ON player_furnaces;
DROP TRIGGER furnace_build_jobs_beacon_district_policy ON furnace_build_jobs;
DROP TRIGGER player_tanneries_beacon_district_policy ON player_tanneries;
DROP TRIGGER tannery_build_jobs_beacon_district_policy ON tannery_build_jobs;
DROP TRIGGER player_butchers_beacon_district_policy ON player_butchers;
DROP TRIGGER butcher_build_jobs_beacon_district_policy ON butcher_build_jobs;
DROP TRIGGER player_manors_beacon_district_policy ON player_manors;
DROP FUNCTION reject_beacon_district_buildable();

COMMENT ON COLUMN world_beacons.district_radius_m IS
  'Exact 10000m geodesic district for public, toll-free flags; no beacon construction exclusion or arrival clearance.';
