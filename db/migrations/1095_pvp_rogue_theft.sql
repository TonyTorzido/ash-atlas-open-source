-- Rogue PvP gold theft: a Rogue killer (rank 2 and up) takes a further 9% of
-- the gold the victim still carries after the normal 10% death loss, capped by
-- Rogue rank (900 / 2,200 / 4,500). It is part of the same per-death replay
-- record as gold_lost: rogue_theft is the amount stolen on this death (0 when
-- the killer is not a Rogue, the death was a beginner or repeat kill, or
-- nothing was left to take). The theft moves through wallet_events under its
-- own operation key and reasons; the table stays append-only.

ALTER TABLE player_pvp_death_gold_losses
  ADD COLUMN IF NOT EXISTS rogue_theft bigint NOT NULL DEFAULT 0 CHECK (rogue_theft >= 0);

COMMENT ON COLUMN player_pvp_death_gold_losses.rogue_theft IS
  'Extra gold a Rogue killer stole on this death, on top of gold_lost; 0 when skipped.';
