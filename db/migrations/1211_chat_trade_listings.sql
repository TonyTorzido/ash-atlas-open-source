-- Trade-room Buy/Sell cards. Nullable and additive: ordinary chat messages keep NULL,
-- and the body still carries a readable text fallback for older clients and previews.
ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS trade_listing jsonb NULL;

DO $$
BEGIN
  ALTER TABLE chat_messages
    ADD CONSTRAINT chat_messages_trade_listing_shape CHECK (
      trade_listing IS NULL OR (
        jsonb_typeof(trade_listing) = 'object'
        AND trade_listing->>'kind' IN ('buy', 'sell')
        AND trade_listing->>'currency' IN ('gold', 'glimmer')
        AND jsonb_typeof(trade_listing->'itemId') = 'string'
        AND jsonb_typeof(trade_listing->'quantity') = 'number'
        AND jsonb_typeof(trade_listing->'price') = 'number'
      )
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;
