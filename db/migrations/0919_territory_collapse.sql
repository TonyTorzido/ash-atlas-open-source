-- Territory collapse: when a city ends or a kingdom is dissolved, every flag it
-- owns breaks in a staggered, restart-safe wave outward from its seat.
--
-- The ending transaction inserts one territory_collapses row, marks each flag
-- with flags.territory_collapse_id (a collapsing flag immediately stops granting
-- claim or travel), and enqueues every flag in territory_collapse_flags with a
-- wave hop (network distance from the seat) and a due_at spread into small
-- batches. A server supervisor claims due rows with FOR UPDATE SKIP LOCKED and
-- deletes the flags; the pending -> broken status flip commits in the same
-- transaction as the deletion, so the queue is its own idempotency ledger and
-- a restart resumes from the remaining pending rows.
CREATE TABLE IF NOT EXISTS territory_collapses (
  collapse_id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('city', 'kingdom')),
  city_id uuid NULL REFERENCES cities(id) ON DELETE RESTRICT,
  kingdom_id uuid NULL REFERENCES kingdoms(id) ON DELETE RESTRICT,
  display_name text NOT NULL CHECK (length(btrim(display_name)) > 0),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 80),
  actor_player_id text NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed')),
  flag_count integer NOT NULL CHECK (flag_count >= 0),
  broken_count integer NOT NULL DEFAULT 0 CHECK (broken_count >= 0),
  notify_player_ids text[] NOT NULL DEFAULT '{}',
  announced_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  CHECK ((kind = 'city') = (city_id IS NOT NULL)),
  CHECK ((kind = 'kingdom') = (kingdom_id IS NOT NULL)),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);

-- A city or kingdom falls at most once per lifecycle.
CREATE UNIQUE INDEX IF NOT EXISTS territory_collapses_active_city_idx
  ON territory_collapses (city_id) WHERE city_id IS NOT NULL AND status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS territory_collapses_active_kingdom_idx
  ON territory_collapses (kingdom_id) WHERE kingdom_id IS NOT NULL AND status = 'active';

-- flag_id deliberately has no foreign key: the row outlives the flag it broke.
CREATE TABLE IF NOT EXISTS territory_collapse_flags (
  collapse_id uuid NOT NULL REFERENCES territory_collapses(collapse_id) ON DELETE CASCADE,
  flag_id uuid NOT NULL,
  wave_hop integer NOT NULL CHECK (wave_hop >= 0),
  wave_index integer NOT NULL CHECK (wave_index >= 0),
  due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'broken', 'missing')),
  flag_owner_player_id text NULL,
  broken_at timestamptz NULL,
  PRIMARY KEY (collapse_id, flag_id),
  CHECK ((status = 'pending') = (broken_at IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS territory_collapse_flags_pending_flag_idx
  ON territory_collapse_flags (flag_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS territory_collapse_flags_due_idx
  ON territory_collapse_flags (due_at, wave_index, flag_id) WHERE status = 'pending';

ALTER TABLE flags
  ADD COLUMN IF NOT EXISTS territory_collapse_id uuid NULL
    REFERENCES territory_collapses(collapse_id) ON DELETE SET NULL;

-- Collapsing flags are rare; keep the index partial so ordinary flag writes are unaffected.
CREATE INDEX IF NOT EXISTS flags_territory_collapse_idx
  ON flags (territory_collapse_id) WHERE territory_collapse_id IS NOT NULL;
