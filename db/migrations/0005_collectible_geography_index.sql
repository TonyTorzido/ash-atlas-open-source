CREATE INDEX IF NOT EXISTS collectible_nodes_geography_gix
  ON collectible_nodes USING gist ((geom::geography));
