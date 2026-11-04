-- Durable party consent and mutation replay ledger. Membership remains explicit;
-- no kingdom, region, proximity, or combat state can create party authority.

CREATE TABLE IF NOT EXISTS party_invites (
  party_id text NOT NULL REFERENCES parties(party_id) ON DELETE CASCADE,
  target_player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  invited_by_player_id text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT party_invites_party_target_key PRIMARY KEY (party_id, target_player_id),
  CONSTRAINT party_invites_inviter_membership_fk
    FOREIGN KEY (party_id, invited_by_player_id)
    REFERENCES party_members(party_id, player_id)
    ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT party_invites_expiry_check CHECK (expires_at > issued_at)
);

CREATE INDEX IF NOT EXISTS party_invites_target_expiry_idx
  ON party_invites (target_player_id, expires_at, party_id);

CREATE TABLE IF NOT EXISTS party_operations (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  action text NOT NULL CHECK (action IN (
    'create', 'invite', 'accept', 'decline', 'remove', 'leave', 'change_leader', 'disband'
  )),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  CONSTRAINT party_operations_player_request_key PRIMARY KEY (player_id, request_id)
);

CREATE INDEX IF NOT EXISTS party_operations_created_idx
  ON party_operations (created_at DESC);

COMMENT ON TABLE party_invites IS
  'Expiring, target-authenticated consent records; an invite alone never grants membership.';
COMMENT ON TABLE party_operations IS
  'Durable per-player request reservations preventing party mutation replay across reconnects and restarts.';
