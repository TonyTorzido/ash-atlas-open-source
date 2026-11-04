-- War for cities and kingdoms, part B3: revolt and anarchy.
--
-- A member starts a revolt vote against the kingdom leader; members vote
-- once each (the primary key makes a replayed or concurrent second vote a
-- conflict). A passed vote demotes the leader to member and puts the kingdom
-- in anarchy for 2 days: no membership holds the leader role, so every
-- leader-only permission is refused. kingdoms.leader_player_id stays NOT
-- NULL and keeps the deposed leader as the recorded owner of kingdom flags
-- until anarchy ends and a successor takes the role.

CREATE TABLE IF NOT EXISTS kingdom_revolts (
  id uuid PRIMARY KEY,
  kingdom_id uuid NOT NULL REFERENCES kingdoms(id) ON DELETE RESTRICT,
  target_leader_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  started_by_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'open',
  opened_at timestamptz NOT NULL,
  closes_at timestamptz NOT NULL,
  resolved_at timestamptz NULL,
  yes_votes integer NULL CHECK (yes_votes IS NULL OR yes_votes >= 0),
  eligible_voters integer NULL CHECK (eligible_voters IS NULL OR eligible_voters >= 0),
  boost_points integer NULL CHECK (boost_points IS NULL OR boost_points BETWEEN 0 AND 20),
  anarchy_until timestamptz NULL,
  successor_player_id text NULL REFERENCES players(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kingdom_revolts_status_valid CHECK (status IN ('open', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT kingdom_revolts_window_valid CHECK (closes_at > opened_at),
  CONSTRAINT kingdom_revolts_starter_not_target CHECK (started_by_player_id <> target_leader_player_id),
  CONSTRAINT kingdom_revolts_lifecycle_valid CHECK (
    (status = 'open' AND resolved_at IS NULL AND anarchy_until IS NULL)
    OR (status = 'succeeded' AND resolved_at IS NOT NULL AND anarchy_until IS NOT NULL)
    OR (status IN ('failed', 'cancelled') AND resolved_at IS NOT NULL AND anarchy_until IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS kingdom_revolts_one_open_idx
  ON kingdom_revolts (kingdom_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS kingdom_revolts_kingdom_history_idx
  ON kingdom_revolts (kingdom_id, opened_at DESC);

CREATE TABLE IF NOT EXISTS kingdom_revolt_votes (
  revolt_id uuid NOT NULL REFERENCES kingdom_revolts(id) ON DELETE RESTRICT,
  voter_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  support boolean NOT NULL,
  voted_at timestamptz NOT NULL,
  PRIMARY KEY (revolt_id, voter_player_id)
);

DROP TRIGGER IF EXISTS kingdom_revolt_votes_append_only ON kingdom_revolt_votes;
CREATE TRIGGER kingdom_revolt_votes_append_only
BEFORE UPDATE OR DELETE ON kingdom_revolt_votes
FOR EACH ROW EXECUTE FUNCTION prevent_kingdom_ledger_mutation();

ALTER TABLE kingdoms
  ADD COLUMN IF NOT EXISTS anarchy_until timestamptz NULL,
  ADD COLUMN IF NOT EXISTS anarchy_revolt_id uuid NULL REFERENCES kingdom_revolts(id) ON DELETE RESTRICT;

ALTER TABLE kingdoms DROP CONSTRAINT IF EXISTS kingdoms_anarchy_valid;
ALTER TABLE kingdoms
  ADD CONSTRAINT kingdoms_anarchy_valid CHECK ((anarchy_until IS NULL) = (anarchy_revolt_id IS NULL));

CREATE INDEX IF NOT EXISTS kingdoms_anarchy_due_idx
  ON kingdoms (anarchy_until) WHERE anarchy_until IS NOT NULL;

-- The war-death boost reads a kingdom's recent leader deaths.
CREATE INDEX IF NOT EXISTS organization_war_death_losses_leader_idx
  ON organization_war_death_losses (victim_kingdom_id, victim_player_id, created_at DESC)
  WHERE victim_was_leader;

COMMENT ON TABLE kingdom_revolts IS
  'Revolt votes against a kingdom leader; a succeeded row records the anarchy it started.';
COMMENT ON TABLE kingdom_revolt_votes IS
  'Append-only revolt votes, one per member per revolt.';
