-- Biome Deer variants: Frost, Jungle, Marsh, and Sand Deer share every Deer
-- number and differ only in their Kitchen cut. Forward-only and idempotent.
-- 1. Item catalog rows for the four new cuts (same policy and weight as Deer Cut).
-- 2. Kitchen constraints from 0845 plus the four cuts at the Deer Cut yield.
-- 3. The weekly "Deer" leaderboard counts every Deer variant.

LOCK TABLE item_definitions, kitchen_jobs IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO item_definitions (
  item_id, display_name, category, rarity, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants, unit_weight_grams
)
VALUES
  ('frost_deer_cut', 'Frost Deer Cut', 'resource', 'common', true, 250, true, true, true, true, 'frost_deer_cut', ARRAY['default']::text[], 250),
  ('jungle_deer_cut', 'Jungle Deer Cut', 'resource', 'common', true, 250, true, true, true, true, 'jungle_deer_cut', ARRAY['default']::text[], 250),
  ('marsh_deer_cut', 'Marsh Deer Cut', 'resource', 'common', true, 250, true, true, true, true, 'marsh_deer_cut', ARRAY['default']::text[], 250),
  ('sand_deer_cut', 'Sand Deer Cut', 'resource', 'common', true, 250, true, true, true, true, 'sand_deer_cut', ARRAY['default']::text[], 250)
ON CONFLICT (item_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  category = EXCLUDED.category,
  rarity = EXCLUDED.rarity,
  stackable = EXCLUDED.stackable,
  max_stack = EXCLUDED.max_stack,
  droppable = EXCLUDED.droppable,
  manor_storable = EXCLUDED.manor_storable,
  market_tradable = EXCLUDED.market_tradable,
  market_fungible = EXCLUDED.market_fungible,
  market_identity = EXCLUDED.market_identity,
  supported_variants = EXCLUDED.supported_variants,
  unit_weight_grams = EXCLUDED.unit_weight_grams,
  updated_at = clock_timestamp();

ALTER TABLE kitchen_jobs
  DROP CONSTRAINT IF EXISTS kitchen_jobs_recipe_id_check,
  DROP CONSTRAINT IF EXISTS kitchen_jobs_requested_input_quantity_check,
  DROP CONSTRAINT IF EXISTS kitchen_jobs_output_quantity_check;

ALTER TABLE kitchen_jobs
  ADD CONSTRAINT kitchen_jobs_recipe_id_check
    CHECK (recipe_id IN (
      'deer_meat', 'wolf_meat', 'hog_meat', 'bear_meat',
      'alligator_meat', 'wild_meat', 'squid_meat', 'freshwater_fish',
      'frog_legs', 'crab_meat', 'small_catch', 'jellyfish_jelly',
      'crawler_flesh', 'squid_cut', 'wolf_cut', 'deer_cut',
      'frost_deer_cut', 'jungle_deer_cut', 'marsh_deer_cut', 'sand_deer_cut',
      'hog_cut', 'alligator_tail', 'bear_cut', 'elemental_ration',
      'scorching_bird_meat', 'zappy_bird_meat', 'freezing_bird_meat',
      'field_ration', 'hearty_ration', 'xoral_essence'
    )),
  ADD CONSTRAINT kitchen_jobs_requested_input_quantity_check
    CHECK (
      requested_input_quantity BETWEEN 1 AND 50
      AND (
        (recipe_id IN (
          'deer_meat', 'wolf_meat', 'hog_meat', 'bear_meat',
          'alligator_meat', 'wild_meat', 'squid_meat', 'freshwater_fish'
        ) AND requested_input_quantity % 10 = 0)
        OR recipe_id IN (
          'frog_legs', 'crab_meat', 'small_catch', 'jellyfish_jelly',
          'crawler_flesh', 'squid_cut', 'wolf_cut', 'deer_cut',
          'frost_deer_cut', 'jungle_deer_cut', 'marsh_deer_cut', 'sand_deer_cut',
          'hog_cut', 'alligator_tail', 'bear_cut', 'elemental_ration',
          'scorching_bird_meat', 'zappy_bird_meat', 'freezing_bird_meat',
          'field_ration', 'hearty_ration', 'xoral_essence'
        )
      )
    ),
  ADD CONSTRAINT kitchen_jobs_output_quantity_check
    CHECK (
      output_quantity BETWEEN 1 AND 1000
      AND (
        (recipe_id IN (
          'deer_meat', 'wolf_meat', 'hog_meat', 'bear_meat',
          'alligator_meat', 'wild_meat', 'squid_meat', 'freshwater_fish'
        ) AND output_quantity * 10 = requested_input_quantity)
        OR (
          recipe_id IN (
            'frog_legs', 'crab_meat', 'small_catch', 'jellyfish_jelly',
            'crawler_flesh', 'squid_cut', 'wolf_cut', 'deer_cut',
            'frost_deer_cut', 'jungle_deer_cut', 'marsh_deer_cut', 'sand_deer_cut',
            'hog_cut', 'alligator_tail', 'bear_cut', 'elemental_ration',
            'scorching_bird_meat', 'zappy_bird_meat', 'freezing_bird_meat',
            'field_ration', 'hearty_ration', 'xoral_essence'
          )
          AND output_quantity = requested_input_quantity * CASE recipe_id
            WHEN 'frog_legs' THEN 1
            WHEN 'crab_meat' THEN 2
            WHEN 'small_catch' THEN 2
            WHEN 'jellyfish_jelly' THEN 2
            WHEN 'crawler_flesh' THEN 2
            WHEN 'squid_cut' THEN 3
            WHEN 'wolf_cut' THEN 4
            WHEN 'deer_cut' THEN 5
            WHEN 'frost_deer_cut' THEN 5
            WHEN 'jungle_deer_cut' THEN 5
            WHEN 'marsh_deer_cut' THEN 5
            WHEN 'sand_deer_cut' THEN 5
            WHEN 'hog_cut' THEN 6
            WHEN 'alligator_tail' THEN 8
            WHEN 'bear_cut' THEN 10
            WHEN 'elemental_ration' THEN 20
            WHEN 'scorching_bird_meat' THEN 20
            WHEN 'zappy_bird_meat' THEN 20
            WHEN 'freezing_bird_meat' THEN 20
            WHEN 'field_ration' THEN 4
            WHEN 'hearty_ration' THEN 8
            WHEN 'xoral_essence' THEN 20
          END
        )
      )
    );

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
    WHEN 'frost_deer' THEN 'deer_killed'
    WHEN 'jungle_deer' THEN 'deer_killed'
    WHEN 'marsh_deer' THEN 'deer_killed'
    WHEN 'sand_deer' THEN 'deer_killed'
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
