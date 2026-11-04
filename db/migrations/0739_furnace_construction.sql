CREATE TABLE furnace_build_jobs (
  build_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  manor_id uuid NOT NULL REFERENCES player_manors(id) ON DELETE RESTRICT,
  world_id text NOT NULL,
  region_code text NOT NULL,
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
  geom geometry(Point, 4326) NOT NULL,
  status text NOT NULL DEFAULT 'constructing'
    CHECK (status IN ('constructing', 'completed', 'cancelled')),
  started_at timestamptz NOT NULL,
  completes_at timestamptz NOT NULL,
  furnace_id uuid NULL REFERENCES player_furnaces(furnace_id) ON DELETE RESTRICT,
  cancel_reason text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_player_id, request_id),
  CHECK (completes_at > started_at),
  CHECK ((status = 'completed') = (furnace_id IS NOT NULL))
);

CREATE UNIQUE INDEX furnace_build_jobs_active_owner_idx
  ON furnace_build_jobs (owner_player_id)
  WHERE status = 'constructing';

CREATE INDEX furnace_build_jobs_due_idx
  ON furnace_build_jobs (completes_at, build_id)
  WHERE status = 'constructing';
