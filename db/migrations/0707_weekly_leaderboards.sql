-- Weekly leaderboard capture begins at this migration. No historical gameplay
-- is inferred from current state.
CREATE TABLE weekly_leaderboard_events (
  event_id bigserial PRIMARY KEY,
  source_type text NOT NULL
    CHECK (source_type IN ('flag_build', 'city_founding', 'character_xp', 'mob_death')),
  source_id text NOT NULL,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  category text NOT NULL
    CHECK (category IN (
      'flags_built',
      'cities_founded',
      'exp_earned',
      'ogres_killed',
      'deer_killed',
      'wolves_killed',
      'resin_crawlers_killed'
    )),
  value bigint NOT NULL CHECK (value > 0),
  occurred_at timestamptz NOT NULL,
  week_start date NOT NULL,
  projected_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_id, player_id, category)
);

CREATE INDEX weekly_leaderboard_events_pending_idx
  ON weekly_leaderboard_events (event_id)
  WHERE projected_at IS NULL;
CREATE INDEX weekly_leaderboard_events_week_category_idx
  ON weekly_leaderboard_events (week_start, category, occurred_at);

CREATE TABLE weekly_leaderboard_totals (
  week_start date NOT NULL,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  category text NOT NULL
    CHECK (category IN (
      'flags_built',
      'cities_founded',
      'exp_earned',
      'ogres_killed',
      'deer_killed',
      'wolves_killed',
      'resin_crawlers_killed'
    )),
  value bigint NOT NULL CHECK (value > 0),
  reached_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (week_start, player_id, category)
);

CREATE INDEX weekly_leaderboard_totals_ranking_idx
  ON weekly_leaderboard_totals (
    week_start,
    category,
    value DESC,
    reached_at ASC,
    player_id ASC
  );
CREATE INDEX weekly_leaderboard_totals_player_idx
  ON weekly_leaderboard_totals (player_id, week_start DESC, category);

CREATE OR REPLACE FUNCTION weekly_leaderboard_week_start(instant timestamptz)
RETURNS date AS $$
  SELECT date_trunc('week', instant AT TIME ZONE 'America/Denver')::date
$$ LANGUAGE sql STABLE STRICT;

CREATE OR REPLACE FUNCTION capture_weekly_flag_build()
RETURNS trigger AS $$
BEGIN
  INSERT INTO weekly_leaderboard_events (
    source_type, source_id, player_id, category, value, occurred_at, week_start
  ) VALUES (
    'flag_build', NEW.flag_id::text, NEW.player_id, 'flags_built', 1,
    NEW.created_at, weekly_leaderboard_week_start(NEW.created_at)
  )
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION capture_weekly_city_founding()
RETURNS trigger AS $$
BEGIN
  INSERT INTO weekly_leaderboard_events (
    source_type, source_id, player_id, category, value, occurred_at, week_start
  ) VALUES (
    'city_founding', NEW.id::text, NEW.founder_player_id, 'cities_founded', 1,
    NEW.created_at, weekly_leaderboard_week_start(NEW.created_at)
  )
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION capture_weekly_character_xp()
RETURNS trigger AS $$
BEGIN
  IF NEW.granted_xp > 0 THEN
    INSERT INTO weekly_leaderboard_events (
      source_type, source_id, player_id, category, value, occurred_at, week_start
    ) VALUES (
      'character_xp', NEW.operation_id::text, NEW.player_id, 'exp_earned',
      NEW.granted_xp, NEW.created_at,
      weekly_leaderboard_week_start(NEW.created_at)
    )
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION capture_weekly_mob_death()
RETURNS trigger AS $$
DECLARE
  leaderboard_category text;
BEGIN
  leaderboard_category := CASE NEW.mob_archetype
    WHEN 'ogre' THEN 'ogres_killed'
    WHEN 'deer' THEN 'deer_killed'
    WHEN 'wolf' THEN 'wolves_killed'
    WHEN 'sap_crawler' THEN 'resin_crawlers_killed'
    ELSE NULL
  END;
  IF leaderboard_category IS NOT NULL AND NEW.reward_player_id IS NOT NULL THEN
    INSERT INTO weekly_leaderboard_events (
      source_type, source_id, player_id, category, value, occurred_at, week_start
    ) VALUES (
      'mob_death',
      NEW.defeated_mob_instance_id || ':' || NEW.mob_life_generation::text,
      NEW.reward_player_id,
      leaderboard_category,
      1,
      NEW.created_at,
      weekly_leaderboard_week_start(NEW.created_at)
    )
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER weekly_leaderboard_flag_build_capture
AFTER INSERT ON flag_build_operations
FOR EACH ROW EXECUTE FUNCTION capture_weekly_flag_build();

CREATE TRIGGER weekly_leaderboard_city_founding_capture
AFTER INSERT ON cities
FOR EACH ROW EXECUTE FUNCTION capture_weekly_city_founding();

CREATE TRIGGER weekly_leaderboard_character_xp_capture
AFTER INSERT ON xp_operations
FOR EACH ROW EXECUTE FUNCTION capture_weekly_character_xp();

CREATE TRIGGER weekly_leaderboard_mob_death_capture
AFTER INSERT ON combat_reward_settlements
FOR EACH ROW EXECUTE FUNCTION capture_weekly_mob_death();

CREATE OR REPLACE FUNCTION reject_weekly_leaderboard_event_mutation()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR
     NEW.source_type IS DISTINCT FROM OLD.source_type OR
     NEW.source_id IS DISTINCT FROM OLD.source_id OR
     NEW.player_id IS DISTINCT FROM OLD.player_id OR
     NEW.category IS DISTINCT FROM OLD.category OR
     NEW.value IS DISTINCT FROM OLD.value OR
     NEW.occurred_at IS DISTINCT FROM OLD.occurred_at OR
     NEW.week_start IS DISTINCT FROM OLD.week_start THEN
    RAISE EXCEPTION 'weekly leaderboard source events are append-only';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER weekly_leaderboard_events_immutable
BEFORE UPDATE OR DELETE ON weekly_leaderboard_events
FOR EACH ROW EXECUTE FUNCTION reject_weekly_leaderboard_event_mutation();

COMMENT ON TABLE weekly_leaderboard_events IS
  'Durable outbox captured by canonical gameplay ledgers from migration deployment forward.';
COMMENT ON COLUMN weekly_leaderboard_events.week_start IS
  'Mountain-Time Monday date for the half-open weekly interval containing occurred_at.';
