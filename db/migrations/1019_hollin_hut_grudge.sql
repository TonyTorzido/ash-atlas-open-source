-- Population V2 huts: the hut row is created when Population V2 first spawns the body, keyed by the
-- deterministic entity id (hut_id = 'hollin-hut:' || population_entity_id).
ALTER TABLE hollin_huts
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'developer' CHECK (source IN ('developer', 'population')),
  ADD COLUMN IF NOT EXISTS population_entity_id uuid NULL;
CREATE UNIQUE INDEX IF NOT EXISTS hollin_huts_population_entity_uniq
  ON hollin_huts (population_entity_id) WHERE population_entity_id IS NOT NULL;

-- Hollin grudges: breaking a hut makes every Hollin attack that player on sight until grudge_until.
ALTER TABLE hollin_hut_player_standing ADD COLUMN IF NOT EXISTS grudge_until timestamptz NULL;
CREATE INDEX IF NOT EXISTS hollin_hut_player_standing_grudge_idx
  ON hollin_hut_player_standing (player_id)
  WHERE grudge_until IS NOT NULL;
