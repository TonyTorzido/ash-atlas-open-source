-- Persist authored dungeon encounter/object/trigger/portal/resource state by
-- instance and run.  Run identity is intentionally part of every key so an
-- empty-instance reset cannot resurrect state from an older run.
CREATE TABLE IF NOT EXISTS dungeon_instance_state (
  instance_id text NOT NULL,
  run_id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 0,
  object_states jsonb NOT NULL DEFAULT '{}'::jsonb,
  object_availability jsonb NOT NULL DEFAULT '{}'::jsonb,
  portal_locks jsonb NOT NULL DEFAULT '{}'::jsonb,
  flags jsonb NOT NULL DEFAULT '{}'::jsonb,
  trigger_states jsonb NOT NULL DEFAULT '{}'::jsonb,
  encounter_states jsonb NOT NULL DEFAULT '{}'::jsonb,
  completed boolean NOT NULL DEFAULT false,
  cues jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instance_id, run_id)
);

CREATE TABLE IF NOT EXISTS dungeon_resource_states (
  instance_id text NOT NULL,
  run_id uuid NOT NULL,
  resource_id text NOT NULL,
  room_id text NOT NULL,
  resource_type text NOT NULL,
  x double precision NOT NULL,
  y double precision NOT NULL,
  quantity integer NOT NULL CHECK (quantity >= 0),
  state text NOT NULL CHECK (state IN ('available', 'depleted')),
  available_at timestamptz,
  min_yield integer NOT NULL CHECK (min_yield > 0),
  max_yield integer NOT NULL CHECK (max_yield >= min_yield),
  respawn_seconds double precision,
  reset_on_run boolean NOT NULL DEFAULT true,
  life_revision bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instance_id, run_id, resource_id)
);

CREATE INDEX IF NOT EXISTS dungeon_resource_states_available_idx
  ON dungeon_resource_states (instance_id, run_id, available_at)
  WHERE state = 'depleted';
