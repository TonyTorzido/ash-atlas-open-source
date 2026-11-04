-- Lifetime combat record shown on player profiles: Kills, Deaths, PvP Kills.
-- Counting starts when this migration ships; nothing is backfilled.
--
-- Counters are maintained by triggers on the two authoritative, idempotent
-- combat ledgers, so a retried or replayed settlement can never count twice:
--   * combat_reward_settlements: a mob kill is credited to reward_player_id
--     exactly once, on the row's single transition into 'completed'
--     (the same rule the weekly leaderboard capture uses).
--   * player_death_xp_penalties: one row per player death (unique
--     operation_key 'player-death:<deathId>'); a death with a killerPlayerId
--     in its metadata is also a PvP kill for the killer.

CREATE TABLE IF NOT EXISTS player_combat_records (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  kills bigint NOT NULL DEFAULT 0 CHECK (kills >= 0),
  deaths bigint NOT NULL DEFAULT 0 CHECK (deaths >= 0),
  pvp_kills bigint NOT NULL DEFAULT 0 CHECK (pvp_kills >= 0),
  pvp_deaths bigint NOT NULL DEFAULT 0 CHECK (pvp_deaths >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (pvp_kills <= kills),
  CHECK (pvp_deaths <= deaths)
);

COMMENT ON TABLE player_combat_records IS
  'Lifetime kills/deaths per player since 2026-10. Maintained only by triggers on combat_reward_settlements and player_death_xp_penalties.';

CREATE OR REPLACE FUNCTION record_combat_settlement_kill()
RETURNS trigger AS $$
BEGIN
  IF NEW.status <> 'completed' OR NEW.reward_player_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'completed' THEN
    RETURN NEW;
  END IF;
  INSERT INTO player_combat_records (player_id, kills)
  VALUES (NEW.reward_player_id, 1)
  ON CONFLICT (player_id) DO UPDATE
  SET kills = player_combat_records.kills + 1,
      updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS combat_reward_settlements_record_kill ON combat_reward_settlements;
CREATE TRIGGER combat_reward_settlements_record_kill
AFTER INSERT OR UPDATE OF status ON combat_reward_settlements
FOR EACH ROW EXECUTE FUNCTION record_combat_settlement_kill();

CREATE OR REPLACE FUNCTION record_player_death_combat()
RETURNS trigger AS $$
DECLARE
  killer_id text;
BEGIN
  killer_id := NULLIF(NEW.metadata->>'killerPlayerId', '');
  IF killer_id IS NOT NULL
     AND (killer_id = NEW.player_id OR NOT EXISTS (SELECT 1 FROM players WHERE id = killer_id)) THEN
    killer_id := NULL;
  END IF;

  INSERT INTO player_combat_records (player_id, deaths, pvp_deaths)
  VALUES (NEW.player_id, 1, CASE WHEN killer_id IS NULL THEN 0 ELSE 1 END)
  ON CONFLICT (player_id) DO UPDATE
  SET deaths = player_combat_records.deaths + 1,
      pvp_deaths = player_combat_records.pvp_deaths + EXCLUDED.pvp_deaths,
      updated_at = now();

  IF killer_id IS NOT NULL THEN
    INSERT INTO player_combat_records (player_id, kills, pvp_kills)
    VALUES (killer_id, 1, 1)
    ON CONFLICT (player_id) DO UPDATE
    SET kills = player_combat_records.kills + 1,
        pvp_kills = player_combat_records.pvp_kills + 1,
        updated_at = now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS player_death_xp_penalties_record_death ON player_death_xp_penalties;
CREATE TRIGGER player_death_xp_penalties_record_death
AFTER INSERT ON player_death_xp_penalties
FOR EACH ROW EXECUTE FUNCTION record_player_death_combat();
