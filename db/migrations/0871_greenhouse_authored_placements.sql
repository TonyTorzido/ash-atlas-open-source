-- Greenhouse room objects are durable player placements.  Stable legacy anchor
-- IDs remain the identity for planted crops; empty legacy anchors become
-- available capacity and may be placed later without rewriting crop timers.
ALTER TABLE greenhouse_plant_anchors
  ADD COLUMN IF NOT EXISTS placed boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS custom_positioned boolean NOT NULL DEFAULT false;

UPDATE greenhouse_plant_anchors AS anchor
SET placed = EXISTS (
  SELECT 1
  FROM greenhouse_plants AS plant
  WHERE plant.greenhouse_id = anchor.greenhouse_id
    AND plant.anchor_id = anchor.anchor_id
);

ALTER TABLE player_greenhouses
  ADD COLUMN IF NOT EXISTS tank_placed boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS tank_x double precision NULL,
  ADD COLUMN IF NOT EXISTS tank_y double precision NULL;

CREATE INDEX IF NOT EXISTS greenhouse_plant_anchors_placed_idx
  ON greenhouse_plant_anchors(greenhouse_id, placed, anchor_id);

-- Keep existing rooms visually compatible with the published catalog.  New
-- player placements write coordinates explicitly; NULL means use the shared
-- Studio-authored water-storage anchor until the tank is moved.
