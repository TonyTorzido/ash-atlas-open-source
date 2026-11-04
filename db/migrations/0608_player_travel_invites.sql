-- Durable one-time travel invitations and consensual party travel.
-- Travel authorization is server-owned; inbox rows are linked projections,
-- never the source of truth.

ALTER TABLE parties
  ADD COLUMN IF NOT EXISTS allow_party_travel boolean NOT NULL DEFAULT false;

ALTER TABLE party_members
  ADD COLUMN IF NOT EXISTS auto_follow_party_leader boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION maintain_party_after_member_delete() RETURNS trigger AS $$
DECLARE
  current_leader text;
  successor text;
BEGIN
  SELECT leader_player_id INTO current_leader
  FROM parties
  WHERE party_id = OLD.party_id
  FOR UPDATE;
  IF current_leader IS NULL THEN RETURN OLD; END IF;
  IF current_leader = OLD.player_id THEN
    SELECT min(player_id) INTO successor FROM party_members WHERE party_id = OLD.party_id;
    IF successor IS NULL THEN
      DELETE FROM parties WHERE party_id = OLD.party_id;
    ELSE
      UPDATE parties
      SET leader_player_id = successor,
          allow_party_travel = false,
          revision = revision + 1
      WHERE party_id = OLD.party_id;
    END IF;
  ELSE
    UPDATE parties SET revision = revision + 1 WHERE party_id = OLD.party_id;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE party_operations
  DROP CONSTRAINT IF EXISTS party_operations_action_check;
ALTER TABLE party_operations
  ADD CONSTRAINT party_operations_action_check CHECK (action IN (
    'create', 'invite', 'accept', 'decline', 'remove', 'leave',
    'change_leader', 'disband', 'set_travel_allowed', 'set_auto_follow'
  ));

CREATE TABLE IF NOT EXISTS travel_invites (
  id uuid PRIMARY KEY,
  inviter_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  invitee_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  -- Kept as a value snapshot rather than an FK so normal auth-session retention
  -- can delete old sessions without deleting or blocking durable inbox history.
  inviter_session_id uuid NOT NULL,
  source_flag_id uuid NOT NULL REFERENCES flags(id) ON DELETE RESTRICT,
  destination_anchor_lat double precision NOT NULL CHECK (destination_anchor_lat BETWEEN -90 AND 90),
  destination_anchor_lon double precision NOT NULL CHECK (destination_anchor_lon BETWEEN -180 AND 180),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'accepting', 'accepted', 'declined', 'cancelled', 'expired', 'invalidated'
  )),
  invalidation_reason text NULL CHECK (
    invalidation_reason IS NULL OR length(invalidation_reason) BETWEEN 1 AND 240
  ),
  create_request_id text NOT NULL CHECK (length(create_request_id) BETWEEN 1 AND 128),
  acceptance_request_id text NULL CHECK (
    acceptance_request_id IS NULL OR length(acceptance_request_id) BETWEEN 1 AND 128
  ),
  acceptance_reserved_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  responded_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT travel_invites_not_self_check CHECK (inviter_player_id <> invitee_player_id),
  CONSTRAINT travel_invites_exact_expiry_check CHECK (expires_at = created_at + interval '10 minutes'),
  CONSTRAINT travel_invites_inviter_request_unique UNIQUE (inviter_player_id, create_request_id),
  CONSTRAINT travel_invites_response_shape_check CHECK (
    (status = 'pending' AND acceptance_request_id IS NULL AND acceptance_reserved_at IS NULL AND responded_at IS NULL)
    OR (status = 'accepting' AND acceptance_request_id IS NOT NULL AND acceptance_reserved_at IS NOT NULL AND responded_at IS NULL)
    OR (status IN ('accepted', 'declined', 'cancelled', 'expired', 'invalidated') AND responded_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS travel_invites_one_active_pair_idx
  ON travel_invites (inviter_player_id, invitee_player_id)
  WHERE status IN ('pending', 'accepting');
CREATE INDEX IF NOT EXISTS travel_invites_invitee_pending_idx
  ON travel_invites (invitee_player_id, expires_at, id)
  WHERE status IN ('pending', 'accepting');
CREATE INDEX IF NOT EXISTS travel_invites_inviter_session_pending_idx
  ON travel_invites (inviter_player_id, inviter_session_id, source_flag_id, id)
  WHERE status IN ('pending', 'accepting');

DROP TRIGGER IF EXISTS travel_invites_set_updated_at ON travel_invites;
CREATE TRIGGER travel_invites_set_updated_at
BEFORE UPDATE ON travel_invites
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS player_inbox_entries (
  id uuid PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  travel_invite_id uuid NOT NULL REFERENCES travel_invites(id) ON DELETE CASCADE,
  perspective text NOT NULL CHECK (perspective IN ('sender', 'recipient')),
  message text NOT NULL CHECK (length(message) BETWEEN 1 AND 240),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT player_inbox_entries_invite_perspective_unique UNIQUE (travel_invite_id, perspective),
  CONSTRAINT player_inbox_entries_player_invite_unique UNIQUE (player_id, travel_invite_id)
);

CREATE INDEX IF NOT EXISTS player_inbox_entries_player_created_idx
  ON player_inbox_entries (player_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS travel_invite_operations (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  action text NOT NULL CHECK (action IN ('send', 'accept', 'decline', 'cancel')),
  travel_invite_id uuid NULL REFERENCES travel_invites(id) ON DELETE SET NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  CONSTRAINT travel_invite_operations_player_request_key PRIMARY KEY (player_id, request_id)
);

CREATE INDEX IF NOT EXISTS travel_invite_operations_created_idx
  ON travel_invite_operations (created_at DESC);

COMMENT ON TABLE travel_invites IS
  'Single-recipient, single-use, session-bound permission to travel to an authoritative flag snapshot.';
COMMENT ON TABLE player_inbox_entries IS
  'Linked sender/recipient inbox projections whose status is always read from travel_invites.';
COMMENT ON COLUMN parties.allow_party_travel IS
  'Leader-controlled permission for active members to travel to or follow the leader.';
COMMENT ON COLUMN party_members.auto_follow_party_leader IS
  'Per-member consent for future eligible leader transitions; defaults off.';
