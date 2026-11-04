-- Generalize durable open-world population from wolf bodies to stable mob encounters.
-- Flag-owned finite wolves remain in generated_resource_wolves.

CREATE TABLE generated_world_mobs (
  entity_id text PRIMARY KEY,
  encounter_id text NOT NULL,
  mob_archetype text NOT NULL CHECK (mob_archetype IN ('deer', 'wolf', 'ogre')),
  pack_id text NULL,
  source_population_area_id text NOT NULL
    REFERENCES environmental_population_areas(id) ON DELETE RESTRICT,
  source_generation integer NOT NULL CHECK (source_generation > 0),
  spawn_cell_id text NOT NULL,
  region_code text NOT NULL,
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
  geom geometry(Point, 4326) NOT NULL,
  anchor_lat double precision NOT NULL CHECK (anchor_lat BETWEEN -90 AND 90),
  anchor_lon double precision NOT NULL CHECK (anchor_lon BETWEEN -180 AND 180),
  placement_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  killed_at timestamptz NULL,
  killed_by_player_id text NULL REFERENCES players(id) ON DELETE SET NULL,
  CHECK ((killed_at IS NULL) = (killed_by_player_id IS NULL)),
  CHECK (
    (mob_archetype = 'wolf' AND pack_id IS NOT NULL)
    OR (mob_archetype IN ('deer', 'ogre') AND pack_id IS NULL)
  )
);

CREATE INDEX generated_world_mobs_population_living_idx
  ON generated_world_mobs (source_population_area_id, source_generation, encounter_id)
  WHERE killed_at IS NULL;
CREATE INDEX generated_world_mobs_pack_living_idx
  ON generated_world_mobs (pack_id)
  WHERE pack_id IS NOT NULL AND killed_at IS NULL;
CREATE INDEX generated_world_mobs_living_geom_idx
  ON generated_world_mobs USING gist (geom)
  WHERE killed_at IS NULL;

INSERT INTO generated_world_mobs (
  entity_id, encounter_id, mob_archetype, pack_id,
  source_population_area_id, source_generation, spawn_cell_id, region_code,
  lat, lon, geom, anchor_lat, anchor_lon, placement_version,
  created_at, killed_at, killed_by_player_id
)
SELECT
  wolf.entity_id,
  'legacy-encounter:' || wolf.source_population_area_id || ':' || wolf.source_generation,
  'wolf',
  'legacy-pack:' || wolf.source_population_area_id || ':' || wolf.source_generation,
  wolf.source_population_area_id,
  wolf.source_generation,
  wolf.source_population_area_id,
  wolf.region_code,
  wolf.lat,
  wolf.lon,
  wolf.geom,
  AVG(wolf.lat) OVER (
    PARTITION BY wolf.source_population_area_id, wolf.source_generation
  ),
  AVG(wolf.lon) OVER (
    PARTITION BY wolf.source_population_area_id, wolf.source_generation
  ),
  wolf.placement_version,
  wolf.created_at,
  wolf.killed_at,
  wolf.killed_by_player_id
FROM generated_resource_wolves AS wolf
WHERE wolf.source_population_area_id IS NOT NULL
ON CONFLICT (entity_id) DO NOTHING;

ALTER TABLE environmental_population_events
  ADD COLUMN rolled_mob_encounter_count smallint,
  ADD COLUMN actual_deer_count smallint,
  ADD COLUMN actual_world_wolf_count smallint,
  ADD COLUMN actual_ogre_count smallint;

UPDATE environmental_population_events
SET rolled_mob_encounter_count = rolled_wolf_count,
    actual_deer_count = 0,
    actual_world_wolf_count = actual_wolf_count,
    actual_ogre_count = 0;

ALTER TABLE environmental_population_events
  ALTER COLUMN rolled_mob_encounter_count SET NOT NULL,
  ALTER COLUMN actual_deer_count SET NOT NULL,
  ALTER COLUMN actual_world_wolf_count SET NOT NULL,
  ALTER COLUMN actual_ogre_count SET NOT NULL,
  ADD CONSTRAINT environmental_population_encounter_count_check
    CHECK (rolled_mob_encounter_count BETWEEN 2 AND 4),
  ADD CONSTRAINT environmental_population_mob_body_counts_check
    CHECK (
      actual_deer_count BETWEEN 0 AND 4
      AND actual_world_wolf_count BETWEEN 0 AND 16
      AND actual_ogre_count BETWEEN 0 AND 4
    );

CREATE OR REPLACE FUNCTION protect_generated_world_mob()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.entity_id IS DISTINCT FROM OLD.entity_id OR
     NEW.encounter_id IS DISTINCT FROM OLD.encounter_id OR
     NEW.mob_archetype IS DISTINCT FROM OLD.mob_archetype OR
     NEW.pack_id IS DISTINCT FROM OLD.pack_id OR
     NEW.source_population_area_id IS DISTINCT FROM OLD.source_population_area_id OR
     NEW.source_generation IS DISTINCT FROM OLD.source_generation OR
     NEW.spawn_cell_id IS DISTINCT FROM OLD.spawn_cell_id OR
     NEW.region_code IS DISTINCT FROM OLD.region_code OR
     NEW.lat IS DISTINCT FROM OLD.lat OR NEW.lon IS DISTINCT FROM OLD.lon OR
     NEW.geom IS DISTINCT FROM OLD.geom OR
     NEW.anchor_lat IS DISTINCT FROM OLD.anchor_lat OR
     NEW.anchor_lon IS DISTINCT FROM OLD.anchor_lon OR
     NEW.placement_version IS DISTINCT FROM OLD.placement_version OR
     (OLD.killed_at IS NOT NULL AND NEW.killed_at IS NULL) OR
     (OLD.killed_by_player_id IS NOT NULL AND NEW.killed_by_player_id IS NULL)
  THEN
    RAISE EXCEPTION 'generated world mob identity, encounter, placement, ownership, and death are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'generated_world_mobs_current_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER generated_world_mobs_protect_history
BEFORE UPDATE ON generated_world_mobs
FOR EACH ROW EXECUTE FUNCTION protect_generated_world_mob();

COMMENT ON TABLE generated_world_mobs IS
  'Durable shared open-world Deer, Wolf-pack, and Ogre bodies owned by environmental population encounters.';
