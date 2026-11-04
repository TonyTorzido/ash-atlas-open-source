-- Multi-occupant manor visits and manor-scoped moderation.

ALTER TABLE player_manor_presence
  DROP CONSTRAINT IF EXISTS player_manor_presence_manor_id_key;

ALTER TABLE player_manor_presence
  ADD COLUMN IF NOT EXISTS access_source text NOT NULL DEFAULT 'OWNER',
  ADD COLUMN IF NOT EXISTS admission_travel_invite_id uuid
    REFERENCES travel_invites(id) ON DELETE SET NULL;

ALTER TABLE player_manor_presence
  DROP CONSTRAINT IF EXISTS player_manor_presence_access_source_check;
ALTER TABLE player_manor_presence
  ADD CONSTRAINT player_manor_presence_access_source_check CHECK (
    (access_source IN ('OWNER', 'PARTY') AND admission_travel_invite_id IS NULL)
    OR
    (access_source = 'TRAVEL_INVITE' AND admission_travel_invite_id IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS player_manor_presence_manor_idx
  ON player_manor_presence (manor_id, entered_at, player_id);
CREATE UNIQUE INDEX IF NOT EXISTS player_manor_presence_travel_invite_uidx
  ON player_manor_presence (admission_travel_invite_id)
  WHERE admission_travel_invite_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS manor_bans (
  manor_id uuid NOT NULL REFERENCES player_manors(id) ON DELETE CASCADE,
  banned_player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  banned_by_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (manor_id, banned_player_id),
  CONSTRAINT manor_bans_not_owner_check CHECK (banned_player_id <> banned_by_player_id)
);

CREATE INDEX IF NOT EXISTS manor_bans_player_manor_idx
  ON manor_bans (banned_player_id, manor_id);

CREATE TABLE IF NOT EXISTS manor_jump_operations (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  request_id text NOT NULL,
  manor_id uuid NOT NULL REFERENCES player_manors(id) ON DELETE CASCADE,
  relocation_revision bigint NOT NULL CHECK (relocation_revision >= 0),
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, request_id)
);

CREATE INDEX IF NOT EXISTS manor_jump_operations_manor_completed_idx
  ON manor_jump_operations (manor_id, completed_at DESC);

COMMENT ON COLUMN player_manor_presence.access_source IS
  'Authoritative active manor admission source; OWNER and PARTY are revalidated, while TRAVEL_INVITE is the durable visit session.';
COMMENT ON TABLE manor_bans IS
  'Manor-scoped entry denial. A ban overrides party, invitation, active visit, and reconnect restoration.';
COMMENT ON TABLE manor_jump_operations IS
  'Durable completion ledger for idempotent regular-map and World Travel Map manor jumps.';
