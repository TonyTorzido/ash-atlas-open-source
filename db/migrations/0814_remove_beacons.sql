-- Retire the beacon feature while preserving the immutable history of the
-- migrations that introduced it. This migration is intentionally idempotent
-- so disposable databases can be upgraded and retried safely.

DROP TRIGGER IF EXISTS players_home_beacon_immutable ON players;
DROP FUNCTION IF EXISTS enforce_immutable_player_home_beacon();
ALTER TABLE players DROP COLUMN IF EXISTS home_beacon_id;

DROP TRIGGER IF EXISTS zz_flags_beacon_district_policy ON flags;
DROP TRIGGER IF EXISTS cities_beacon_district_policy ON cities;
DROP TRIGGER IF EXISTS city_structures_beacon_district_policy ON city_structures;
DROP TRIGGER IF EXISTS kingdom_seats_beacon_district_policy ON kingdom_seats;
DROP TRIGGER IF EXISTS kingdom_cots_beacon_district_policy ON kingdom_cots;
DROP TRIGGER IF EXISTS kingdom_decorations_beacon_district_policy ON kingdom_decorations;
DROP TRIGGER IF EXISTS player_furnaces_beacon_district_policy ON player_furnaces;
DROP TRIGGER IF EXISTS furnace_build_jobs_beacon_district_policy ON furnace_build_jobs;
DROP TRIGGER IF EXISTS player_tanneries_beacon_district_policy ON player_tanneries;
DROP TRIGGER IF EXISTS tannery_build_jobs_beacon_district_policy ON tannery_build_jobs;
DROP TRIGGER IF EXISTS player_butchers_beacon_district_policy ON player_butchers;
DROP TRIGGER IF EXISTS butcher_build_jobs_beacon_district_policy ON butcher_build_jobs;
DROP TRIGGER IF EXISTS player_manors_beacon_district_policy ON player_manors;
DROP FUNCTION IF EXISTS enforce_beacon_district_flag_policy();
DROP FUNCTION IF EXISTS reject_beacon_district_buildable();

DROP TABLE IF EXISTS beacon_spawn_assignments;
DROP TABLE IF EXISTS player_discovered_beacons;
DELETE FROM player_world_map_destination_preferences
WHERE destination_kind = 'beacon';
DROP TABLE IF EXISTS world_beacons;

ALTER TABLE player_world_map_destination_preferences
  DROP CONSTRAINT IF EXISTS player_world_map_destination_preferences_kind;
ALTER TABLE player_world_map_destination_preferences
  ADD CONSTRAINT player_world_map_destination_preferences_kind
    CHECK (destination_kind IN ('city', 'manor', 'kingdom', 'atlas_shrine'));
