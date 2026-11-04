ALTER TABLE flags
  ALTER COLUMN claim_radius_m SET DEFAULT 500,
  ALTER COLUMN resource_vision_radius_m SET DEFAULT 750;

ALTER TABLE players
  ALTER COLUMN move_leash_radius_m SET DEFAULT 650;
