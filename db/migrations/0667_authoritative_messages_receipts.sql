-- Durable, revision-aware Messages read receipts and retained party invitation history.

CREATE TABLE IF NOT EXISTS player_inbox_read_receipts (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  entry_key text NOT NULL CHECK (length(entry_key) BETWEEN 1 AND 240),
  read_revision text NOT NULL CHECK (length(read_revision) BETWEEN 1 AND 80),
  read_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT player_inbox_read_receipts_pkey PRIMARY KEY (player_id, entry_key)
);

CREATE INDEX IF NOT EXISTS player_inbox_read_receipts_player_read_idx
  ON player_inbox_read_receipts (player_id, read_at DESC);

ALTER TABLE party_invites
  ADD COLUMN IF NOT EXISTS id uuid,
  ADD COLUMN IF NOT EXISTS leader_player_id text,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS responded_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

UPDATE party_invites invite
SET id = COALESCE(invite.id, gen_random_uuid()),
    leader_player_id = COALESCE(invite.leader_player_id, party.leader_player_id)
FROM parties party
WHERE party.party_id = invite.party_id
  AND (invite.id IS NULL OR invite.leader_player_id IS NULL);

ALTER TABLE party_invites
  ALTER COLUMN id SET NOT NULL,
  ALTER COLUMN leader_player_id SET NOT NULL;

ALTER TABLE party_invites DROP CONSTRAINT IF EXISTS party_invites_party_target_key;
ALTER TABLE party_invites DROP CONSTRAINT IF EXISTS party_invites_party_id_fkey;
ALTER TABLE party_invites DROP CONSTRAINT IF EXISTS party_invites_inviter_membership_fk;
ALTER TABLE party_invites DROP CONSTRAINT IF EXISTS party_invites_pkey;
ALTER TABLE party_invites DROP CONSTRAINT IF EXISTS party_invites_status_check;
ALTER TABLE party_invites DROP CONSTRAINT IF EXISTS party_invites_response_check;

ALTER TABLE party_invites
  ADD CONSTRAINT party_invites_pkey PRIMARY KEY (id),
  ADD CONSTRAINT party_invites_status_check CHECK (
    status IN ('pending', 'accepted', 'declined', 'cancelled', 'expired', 'invalidated')
  ),
  ADD CONSTRAINT party_invites_response_check CHECK (
    (status = 'pending' AND responded_at IS NULL)
    OR (status <> 'pending' AND responded_at IS NOT NULL)
  );

CREATE UNIQUE INDEX IF NOT EXISTS party_invites_one_pending_target_idx
  ON party_invites (party_id, target_player_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS party_invites_inbox_target_idx
  ON party_invites (target_player_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS party_invites_inbox_inviter_idx
  ON party_invites (invited_by_player_id, updated_at DESC);

DROP TRIGGER IF EXISTS party_invites_set_updated_at ON party_invites;
CREATE TRIGGER party_invites_set_updated_at
BEFORE UPDATE ON party_invites
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE party_operations
  DROP CONSTRAINT IF EXISTS party_operations_action_check;
ALTER TABLE party_operations
  ADD CONSTRAINT party_operations_action_check CHECK (action IN (
    'create', 'invite', 'accept', 'decline', 'cancel', 'remove', 'leave',
    'change_leader', 'disband', 'set_travel_allowed', 'set_auto_follow'
  ));

COMMENT ON TABLE player_inbox_read_receipts IS
  'Per-player exact-revision read receipts for durable non-DM Messages entries.';
COMMENT ON COLUMN party_invites.id IS
  'Stable invitation identity; party_id alone is not unique invitation history.';
