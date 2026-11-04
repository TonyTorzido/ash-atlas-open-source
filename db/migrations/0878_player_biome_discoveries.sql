-- Server-authoritative world region discovery. The server resolves the biome from the player's
-- authoritative position; a row is written once per player and biome.
CREATE TABLE IF NOT EXISTS player_biome_discoveries (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  biome_id text NOT NULL,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, biome_id),
  CONSTRAINT player_biome_discoveries_biome_id_check CHECK (biome_id IN (
    'jungle', 'pinewild', 'greenwood', 'frostwood', 'plains', 'savanna', 'marsh', 'highmeadow',
    'scrubland', 'badlands', 'steppe', 'tundra', 'frozen_waste', 'coast', 'open_ocean', 'lake'
  ))
);
