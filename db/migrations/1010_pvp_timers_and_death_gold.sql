-- PvP strike-block rule and the PvP death gold loss.
--
-- player_pvp_timers keeps the 20-hour timers across a restart (fights between
-- a pair follow the in-memory combat aggression timer). One row per
-- (holder, other, kind); holder is always the victim, other the player who
-- hit them:
--   aggressor:    other struck holder; holder may attack other (refreshed by
--                 each of other's hits).
--   strike_block: other used their one swing on holder and cannot attack
--                 holder again until it expires, unless the two are fighting.
--
-- player_pvp_death_gold_losses is the per-death replay record for the gold a
-- PvP killer takes: 12% of the victim's carried gold (player_wallets), rounded
-- down. Nothing moves when the victim is a beginner (level 3 and under) or
-- when the same killer already took gold from the same victim in the last
-- 20 hours (anti-farm: no loss and no gain). The wallet movements themselves
-- are ledgered in wallet_events under the same operation key.
--
-- player_pvp_pending_deaths remembers who killed a player the moment the
-- death is settled, so a retry after a crash or restart (which only knows the
-- death operation key) applies the same PvP losses exactly once.

CREATE TABLE IF NOT EXISTS player_pvp_timers (
  holder_player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  other_player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('aggressor', 'strike_block')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (holder_player_id, other_player_id, kind),
  CONSTRAINT player_pvp_timers_players_distinct CHECK (holder_player_id <> other_player_id)
);

CREATE INDEX IF NOT EXISTS player_pvp_timers_other_idx
  ON player_pvp_timers (other_player_id, kind);
CREATE INDEX IF NOT EXISTS player_pvp_timers_expires_idx
  ON player_pvp_timers (expires_at);

CREATE TABLE IF NOT EXISTS player_pvp_death_gold_losses (
  operation_key text PRIMARY KEY CHECK (length(operation_key) BETWEEN 1 AND 240),
  victim_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  killer_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  victim_level integer NOT NULL CHECK (victim_level BETWEEN 0 AND 40),
  beginner_protected boolean NOT NULL,
  repeat_kill boolean NOT NULL DEFAULT false,
  carried_before bigint NOT NULL CHECK (carried_before >= 0),
  gold_lost bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT player_pvp_death_gold_losses_players_distinct CHECK (victim_player_id <> killer_player_id),
  CONSTRAINT player_pvp_death_gold_losses_beginner_valid CHECK (beginner_protected = (victim_level <= 3)),
  CONSTRAINT player_pvp_death_gold_losses_amount_valid CHECK (
    gold_lost = CASE WHEN beginner_protected OR repeat_kill THEN 0 ELSE carried_before * 12 / 100 END
  )
);

CREATE INDEX IF NOT EXISTS player_pvp_death_gold_losses_victim_idx
  ON player_pvp_death_gold_losses (victim_player_id, created_at DESC);
CREATE INDEX IF NOT EXISTS player_pvp_death_gold_losses_killer_idx
  ON player_pvp_death_gold_losses (killer_player_id, created_at DESC);
CREATE INDEX IF NOT EXISTS player_pvp_death_gold_losses_pair_idx
  ON player_pvp_death_gold_losses (victim_player_id, killer_player_id, created_at DESC)
  WHERE gold_lost > 0;

CREATE TABLE IF NOT EXISTS player_pvp_pending_deaths (
  death_operation_key text PRIMARY KEY CHECK (length(death_operation_key) BETWEEN 1 AND 240),
  victim_player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  killer_player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  gold_eligible boolean NOT NULL,
  revenant_armor boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT player_pvp_pending_deaths_players_distinct CHECK (victim_player_id <> killer_player_id)
);

CREATE INDEX IF NOT EXISTS player_pvp_pending_deaths_created_idx
  ON player_pvp_pending_deaths (created_at);

CREATE OR REPLACE FUNCTION reject_pvp_death_gold_loss_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'player_pvp_death_gold_losses is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS player_pvp_death_gold_losses_append_only ON player_pvp_death_gold_losses;
CREATE TRIGGER player_pvp_death_gold_losses_append_only
BEFORE UPDATE OR DELETE ON player_pvp_death_gold_losses
FOR EACH ROW EXECUTE FUNCTION reject_pvp_death_gold_loss_mutation();

COMMENT ON TABLE player_pvp_timers IS
  'Active 20-hour PvP aggressor marks and strike blocks; expired rows are pruned by the server.';
COMMENT ON TABLE player_pvp_death_gold_losses IS
  'Append-only PvP death gold transfers, one per player death: 12% of carried gold to the killer.';
COMMENT ON TABLE player_pvp_pending_deaths IS
  'Killer of each PvP death, so a recovered death retry applies the PvP losses exactly once.';
