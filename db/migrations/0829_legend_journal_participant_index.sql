-- Support personal boss-credit lookups without scanning every player's combat history.
CREATE INDEX IF NOT EXISTS combat_reward_participants_player_idx
  ON combat_reward_participants (player_id, settlement_key);
