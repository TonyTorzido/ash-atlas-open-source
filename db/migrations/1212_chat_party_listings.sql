-- Hunting-room party-finder cards. Nullable and additive: ordinary chat messages keep NULL,
-- and the body still carries a readable text fallback for older clients and previews.
-- Live card state (open / Party full / Closed) is projected from party state and expiry;
-- only an early close by the poster is written back here, as "cancelled": true.
ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS party_listing jsonb NULL;

DO $$
BEGIN
  ALTER TABLE chat_messages
    ADD CONSTRAINT chat_messages_party_listing_shape CHECK (
      party_listing IS NULL OR (
        jsonb_typeof(party_listing) = 'object'
        AND party_listing->>'kind' IN ('leader', 'seeker')
        AND jsonb_typeof(party_listing->'dungeonId') = 'string'
      )
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- Open cards are read back by recency on server start.
CREATE INDEX IF NOT EXISTS chat_messages_party_listing_recent_idx
  ON chat_messages (created_at DESC)
  WHERE party_listing IS NOT NULL;
