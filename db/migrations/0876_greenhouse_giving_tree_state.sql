ALTER TABLE greenhouse_plants
  ADD COLUMN IF NOT EXISTS berries_remaining integer NULL,
  ADD COLUMN IF NOT EXISTS resin_harvested boolean NOT NULL DEFAULT false;

ALTER TABLE greenhouse_plants
  DROP CONSTRAINT IF EXISTS greenhouse_plants_berries_remaining_check;

ALTER TABLE greenhouse_plants
  ADD CONSTRAINT greenhouse_plants_berries_remaining_check
  CHECK (berries_remaining IS NULL OR berries_remaining BETWEEN 0 AND 3);
