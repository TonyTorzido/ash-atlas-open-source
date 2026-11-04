-- Durable player-equipped Chat Crest selection.
-- Availability remains server-owned by the ChatCrestEntitlementResolver;
-- nullable legacy rows resolve to the registered neutral fallback.

ALTER TABLE player_profiles
  ADD COLUMN IF NOT EXISTS equipped_chat_crest_id text NULL;

CREATE INDEX IF NOT EXISTS player_profiles_equipped_chat_crest_idx
  ON player_profiles (equipped_chat_crest_id)
  WHERE equipped_chat_crest_id IS NOT NULL;
