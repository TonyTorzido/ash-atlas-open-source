ALTER TABLE weekly_leaderboard_events
  DROP CONSTRAINT IF EXISTS weekly_leaderboard_events_source_type_check,
  DROP CONSTRAINT IF EXISTS weekly_leaderboard_events_category_check;

ALTER TABLE weekly_leaderboard_events
  ADD CONSTRAINT weekly_leaderboard_events_source_type_check
    CHECK (source_type IN (
      'flag_build', 'city_founding', 'character_xp', 'mob_death', 'tree_chop'
    )),
  ADD CONSTRAINT weekly_leaderboard_events_category_check
    CHECK (category IN (
      'flags_built',
      'cities_founded',
      'trees_chopped',
      'exp_earned',
      'mysterious_travelers_killed',
      'ogres_killed',
      'deer_killed',
      'wolves_killed',
      'resin_crawlers_killed'
    ));

ALTER TABLE weekly_leaderboard_totals
  DROP CONSTRAINT IF EXISTS weekly_leaderboard_totals_category_check;

ALTER TABLE weekly_leaderboard_totals
  ADD CONSTRAINT weekly_leaderboard_totals_category_check
    CHECK (category IN (
      'flags_built',
      'cities_founded',
      'trees_chopped',
      'exp_earned',
      'mysterious_travelers_killed',
      'ogres_killed',
      'deer_killed',
      'wolves_killed',
      'resin_crawlers_killed'
    ));

CREATE OR REPLACE FUNCTION capture_weekly_tree_chop()
RETURNS trigger AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM 'completed'
     AND NEW.status = 'completed'
     AND NEW.resource_type = 'wood'
     AND NEW.completed_at IS NOT NULL THEN
    INSERT INTO weekly_leaderboard_events (
      source_type, source_id, player_id, category, value, occurred_at, week_start
    ) VALUES (
      'tree_chop', NEW.id::text, NEW.player_id, 'trees_chopped', 1,
      NEW.completed_at, weekly_leaderboard_week_start(NEW.completed_at)
    )
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS weekly_leaderboard_tree_chop_capture ON harvest_sessions;
CREATE TRIGGER weekly_leaderboard_tree_chop_capture
AFTER UPDATE OF status, completed_at ON harvest_sessions
FOR EACH ROW EXECUTE FUNCTION capture_weekly_tree_chop();

CREATE OR REPLACE FUNCTION capture_weekly_mob_death()
RETURNS trigger AS $$
DECLARE
  leaderboard_category text;
BEGIN
  IF NEW.status <> 'completed'
     OR NEW.completed_at IS NULL
     OR NEW.reward_player_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'completed' THEN
    RETURN NEW;
  END IF;

  leaderboard_category := CASE NEW.mob_archetype
    WHEN 'mysterious_traveler' THEN 'mysterious_travelers_killed'
    WHEN 'ogre' THEN 'ogres_killed'
    WHEN 'deer' THEN 'deer_killed'
    WHEN 'wolf' THEN 'wolves_killed'
    WHEN 'sap_crawler' THEN 'resin_crawlers_killed'
    ELSE NULL
  END;
  IF leaderboard_category IS NOT NULL THEN
    INSERT INTO weekly_leaderboard_events (
      source_type, source_id, player_id, category, value, occurred_at, week_start
    ) VALUES (
      'mob_death',
      NEW.defeated_mob_instance_id || ':' || NEW.mob_life_generation::text,
      NEW.reward_player_id,
      leaderboard_category,
      1,
      NEW.completed_at,
      weekly_leaderboard_week_start(NEW.completed_at)
    )
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS weekly_leaderboard_mob_death_capture
  ON combat_reward_settlements;
CREATE TRIGGER weekly_leaderboard_mob_death_capture
AFTER INSERT OR UPDATE OF status, completed_at
ON combat_reward_settlements
FOR EACH ROW EXECUTE FUNCTION capture_weekly_mob_death();

INSERT INTO weekly_leaderboard_events (
  source_type, source_id, player_id, category, value, occurred_at, week_start
)
SELECT
  'tree_chop', session.id::text, session.player_id, 'trees_chopped', 1,
  session.completed_at, weekly_leaderboard_week_start(session.completed_at)
FROM harvest_sessions session
WHERE session.resource_type = 'wood'
  AND session.status = 'completed'
  AND session.completed_at IS NOT NULL
  AND weekly_leaderboard_week_start(session.completed_at) =
      weekly_leaderboard_week_start(now())
ON CONFLICT DO NOTHING;

INSERT INTO weekly_leaderboard_events (
  source_type, source_id, player_id, category, value, occurred_at, week_start
)
SELECT
  'mob_death',
  settlement.defeated_mob_instance_id || ':' || settlement.mob_life_generation::text,
  settlement.reward_player_id,
  'mysterious_travelers_killed',
  1,
  settlement.completed_at,
  weekly_leaderboard_week_start(settlement.completed_at)
FROM combat_reward_settlements settlement
WHERE settlement.mob_archetype = 'mysterious_traveler'
  AND settlement.status = 'completed'
  AND settlement.completed_at IS NOT NULL
  AND settlement.reward_player_id IS NOT NULL
  AND weekly_leaderboard_week_start(settlement.completed_at) =
      weekly_leaderboard_week_start(now())
ON CONFLICT DO NOTHING;

CREATE INDEX IF NOT EXISTS chat_messages_visible_channel_time_sender_idx
  ON chat_messages (channel_id, created_at, sender_player_id)
  WHERE message_status = 'visible';
