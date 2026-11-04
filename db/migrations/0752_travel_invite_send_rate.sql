-- Bound recent Travel Invite sender lookups used by the authoritative abuse policy.
CREATE INDEX IF NOT EXISTS travel_invites_inviter_created_idx
  ON travel_invites (inviter_player_id, created_at DESC, id DESC);
