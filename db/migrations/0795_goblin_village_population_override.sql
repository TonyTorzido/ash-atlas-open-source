CREATE TABLE IF NOT EXISTS goblin_village_population_overrides (
  city_id uuid NOT NULL REFERENCES cities(id) ON DELETE RESTRICT,
  zone_id text NOT NULL CHECK (length(zone_id) BETWEEN 1 AND 160),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (city_id, zone_id)
);

CREATE INDEX IF NOT EXISTS goblin_village_population_overrides_zone_idx
  ON goblin_village_population_overrides (zone_id, city_id);

CREATE TABLE IF NOT EXISTS goblin_village_deletions (
  actor_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  city_id uuid NOT NULL REFERENCES cities(id) ON DELETE RESTRICT,
  result jsonb NOT NULL CHECK (
    jsonb_typeof(result) = 'object'
    AND octet_length(result::text) <= 524288
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_player_id, request_id)
);

CREATE OR REPLACE FUNCTION apply_goblin_village_population_override()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.population_flag_suppressed :=
    NEW.physical_population_zone_v2_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM goblin_village_population_overrides AS override
      WHERE override.zone_id = NEW.physical_population_zone_v2_id
    );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS generated_world_mobs_goblin_village_suppression
  ON generated_world_mobs;
CREATE TRIGGER generated_world_mobs_goblin_village_suppression
BEFORE INSERT OR UPDATE OF physical_population_zone_v2_id, population_flag_suppressed
ON generated_world_mobs
FOR EACH ROW EXECUTE FUNCTION apply_goblin_village_population_override();

UPDATE generated_world_mobs AS mob
SET population_flag_suppressed = EXISTS (
  SELECT 1
  FROM goblin_village_population_overrides AS override
  WHERE override.zone_id = mob.physical_population_zone_v2_id
)
WHERE mob.physical_population_zone_v2_id IS NOT NULL
  AND mob.population_flag_suppressed IS DISTINCT FROM EXISTS (
    SELECT 1
    FROM goblin_village_population_overrides AS override
    WHERE override.zone_id = mob.physical_population_zone_v2_id
  );

COMMENT ON TABLE goblin_village_population_overrides IS
  'Active NPC Goblin city Population V2 zones whose ordinary mob projections are suppressed.';
COMMENT ON TABLE goblin_village_deletions IS
  'Idempotent retained audit/result ledger for Developer App Goblin Village deletion requests.';
