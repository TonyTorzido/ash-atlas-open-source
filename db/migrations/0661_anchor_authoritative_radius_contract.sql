-- Normalize retained rows that still carry one of the two superseded ordinary
-- gameplay-radius defaults. Deliberate non-default values remain unchanged.

ALTER TABLE flags
  ALTER COLUMN claim_radius_m SET DEFAULT 500,
  ALTER COLUMN resource_vision_radius_m SET DEFAULT 650;

ALTER TABLE players
  ALTER COLUMN move_leash_radius_m SET DEFAULT 600;

ALTER TABLE players
  ADD COLUMN IF NOT EXISTS resource_vision_center_lat double precision,
  ADD COLUMN IF NOT EXISTS resource_vision_center_lon double precision;

-- Preserve the previously effective attached destination center so the normal
-- reconnect authority path can detect, log, repair, and persist any mismatch.
UPDATE players player
SET resource_vision_center_lat = COALESCE(
      (SELECT flag.lat FROM flags flag WHERE flag.id = player.current_flag_id),
      (SELECT seat.lat FROM kingdom_seats seat
       WHERE seat.id = player.current_kingdom_seat_id),
      player.anchor_lat
    ),
    resource_vision_center_lon = COALESCE(
      (SELECT flag.lon FROM flags flag WHERE flag.id = player.current_flag_id),
      (SELECT seat.lon FROM kingdom_seats seat
       WHERE seat.id = player.current_kingdom_seat_id),
      player.anchor_lon
    )
WHERE current_flag_id IS NOT NULL
   OR current_kingdom_seat_id IS NOT NULL;

UPDATE players
SET resource_vision_center_lat = NULL,
    resource_vision_center_lon = NULL
WHERE current_flag_id IS NULL
  AND current_kingdom_seat_id IS NULL
  AND (
    resource_vision_center_lat IS NOT NULL
    OR resource_vision_center_lon IS NOT NULL
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'players'::regclass
      AND conname = 'players_resource_vision_center_domain'
  ) THEN
    ALTER TABLE players
      ADD CONSTRAINT players_resource_vision_center_domain
      CHECK (
        (resource_vision_center_lat IS NULL AND resource_vision_center_lon IS NULL)
        OR (
          resource_vision_center_lat BETWEEN -90 AND 90
          AND resource_vision_center_lon BETWEEN -180 AND 180
        )
      ) NOT VALID;
  END IF;
END
$$;

ALTER TABLE players
  VALIDATE CONSTRAINT players_resource_vision_center_domain;

ALTER TABLE environmental_population_areas
  ALTER COLUMN radius_m SET DEFAULT 750;

UPDATE flags
SET claim_radius_m = 500
WHERE control_type <> 'kingdom_seat'
  AND claim_radius_m = 1000;

UPDATE flags
SET resource_vision_radius_m = 650
WHERE resource_vision_radius_m IN (750, 1500);

UPDATE players
SET move_leash_radius_m = 600
WHERE move_leash_radius_m IN (650, 1250);

UPDATE environmental_population_areas
SET radius_m = 750
WHERE radius_m IN (1000, 1500);

UPDATE flag_resource_visions vision
SET radius_m = 650,
    status = 'pending',
    node_count = 0,
    water_highlight_count = 0,
    requested_at = now(),
    generated_at = NULL,
    last_error = NULL
FROM flags flag
WHERE flag.id = vision.flag_id
  AND flag.resource_vision_radius_m = 650
  AND vision.radius_m IN (750, 1500);

-- Radius is part of the durable resource-job key. Terminally fence actionable
-- old-radius jobs so a stale worker cannot publish the superseded contract.
-- Completed history remains intact and new 650 m jobs receive distinct keys.
UPDATE resource_vision_jobs job
SET status = 'completed',
    owner_id = NULL,
    lease_expires_at = NULL,
    next_retry_at = NULL,
    completed_at = now(),
    last_error = 'superseded by the 650 m anchor-authoritative vision contract'
FROM flags flag
WHERE flag.id = job.flag_id
  AND flag.resource_vision_radius_m = 650
  AND job.radius_m IN (750, 1500)
  AND (
    job.status IN ('pending', 'processing')
    OR (job.status = 'failed' AND job.next_retry_at IS NOT NULL)
  );

-- Rebalance reusable current-contract work without disturbing an active claim.
UPDATE resource_vision_jobs
SET priority = CASE reason
      WHEN 'flag-visit' THEN 0
      WHEN 'flag-build' THEN 1
      WHEN 'flag-created' THEN 1
      WHEN 'dev-prewarm' THEN 2
    END
WHERE radius_m = 650
  AND (
    status = 'pending'
    OR (status = 'failed' AND next_retry_at IS NOT NULL)
  );
