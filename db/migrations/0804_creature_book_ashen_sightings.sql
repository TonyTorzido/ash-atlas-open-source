CREATE TABLE creature_book_ashen_sightings (
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  mob_archetype TEXT NOT NULL,
  first_source_entity_id TEXT NOT NULL,
  sighted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, mob_archetype),
  CHECK (mob_archetype IN ('deer','hog','coastal_crab','frog','wolf','bear','squid','sap_crawler','alligator','jellyfish','ogre','mysterious_traveler','fire_bird','lightning_bird','ice_bird','xoral'))
);
