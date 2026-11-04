-- Durable plant discovery and harvest history for the Encyclopedia.
--
-- The source_id is the authoritative Population V2 harvest operation key. It
-- remains stable across completion retries and changes when a node's life
-- revision changes, so duplicate requests cannot advance the lifetime count.
CREATE TABLE creature_book_plant_harvests (
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  plant_key TEXT NOT NULL,
  source_id TEXT NOT NULL,
  harvested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, plant_key, source_id),
  CHECK (plant_key IN ('flax'))
);

CREATE INDEX creature_book_plant_harvests_player_plant_idx
  ON creature_book_plant_harvests (player_id, plant_key, harvested_at DESC);

-- Preserve any completed Flax harvests that may already exist when this
-- migration is applied to a retained database.
INSERT INTO creature_book_plant_harvests (player_id, plant_key, source_id, harvested_at)
SELECT player_id, 'flax', operation_key, COALESCE(completed_at, updated_at, created_at)
FROM harvest_sessions
WHERE status = 'completed'
  AND resource_type = 'flax_fiber'
ON CONFLICT DO NOTHING;
