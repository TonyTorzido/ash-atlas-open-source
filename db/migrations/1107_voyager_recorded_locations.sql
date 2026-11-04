-- Voyager (Wayfinder Training): locations a Voyager recorded for refined oil and can travel back
-- to. Private to the owner; the cap is enforced by the service under the player's marker lock.
-- Forward-only and idempotent.

CREATE TABLE IF NOT EXISTS player_recorded_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  -- Replay guard: a retried record returns the same location and never spends oil twice.
  request_id text NOT NULL,
  name text NOT NULL CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 32),
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT player_recorded_locations_request UNIQUE (player_id, request_id)
);

CREATE INDEX IF NOT EXISTS player_recorded_locations_player_idx
  ON player_recorded_locations (player_id, created_at, id);
