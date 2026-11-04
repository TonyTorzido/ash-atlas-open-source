-- Biome variants of Wolf, Hog, Bear, Coastal Crab, Frog and Alligator (20 kinds)
-- share every number of their base and differ only in their Kitchen cut.
-- Forward-only and idempotent.
-- 1. Item catalog rows for the twenty new cuts (same policy and weight as the
--    base cut).
-- 2. Kitchen constraints from 0915 plus the twenty cuts at their base's yield.
-- 3. The weekly "Wolves" leaderboard counts every Wolf variant (Deer variants
--    keep counting toward "Deer" as in 0915).

LOCK TABLE item_definitions, kitchen_jobs IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO item_definitions (
  item_id, display_name, category, rarity, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants, unit_weight_grams
)
VALUES
  ('frost_wolf_cut', 'Frost Wolf Cut', 'resource', 'common', true, 250, true, true, true, true, 'frost_wolf_cut', ARRAY['default']::text[], 250),
  ('dune_wolf_cut', 'Dune Wolf Cut', 'resource', 'common', true, 250, true, true, true, true, 'dune_wolf_cut', ARRAY['default']::text[], 250),
  ('jungle_wolf_cut', 'Jungle Wolf Cut', 'resource', 'common', true, 250, true, true, true, true, 'jungle_wolf_cut', ARRAY['default']::text[], 250),
  ('bog_wolf_cut', 'Bog Wolf Cut', 'resource', 'common', true, 250, true, true, true, true, 'bog_wolf_cut', ARRAY['default']::text[], 250),
  ('woolly_hog_cut', 'Woolly Hog Cut', 'resource', 'common', true, 250, true, true, true, true, 'woolly_hog_cut', ARRAY['default']::text[], 250),
  ('warthog_cut', 'Warthog Cut', 'resource', 'common', true, 250, true, true, true, true, 'warthog_cut', ARRAY['default']::text[], 250),
  ('jungle_hog_cut', 'Jungle Hog Cut', 'resource', 'common', true, 250, true, true, true, true, 'jungle_hog_cut', ARRAY['default']::text[], 250),
  ('mud_hog_cut', 'Mud Hog Cut', 'resource', 'common', true, 250, true, true, true, true, 'mud_hog_cut', ARRAY['default']::text[], 250),
  ('javelina_cut', 'Javelina Cut', 'resource', 'common', true, 250, true, true, true, true, 'javelina_cut', ARRAY['default']::text[], 250),
  ('snow_bear_cut', 'Snow Bear Cut', 'resource', 'common', true, 250, true, true, true, true, 'snow_bear_cut', ARRAY['default']::text[], 250),
  ('black_bear_cut', 'Black Bear Cut', 'resource', 'common', true, 250, true, true, true, true, 'black_bear_cut', ARRAY['default']::text[], 250),
  ('sun_bear_cut', 'Sun Bear Cut', 'resource', 'common', true, 250, true, true, true, true, 'sun_bear_cut', ARRAY['default']::text[], 250),
  ('ice_crab_meat', 'Ice Crab Meat', 'resource', 'common', true, 250, true, true, true, true, 'ice_crab_meat', ARRAY['default']::text[], 250),
  ('sand_crab_meat', 'Sand Crab Meat', 'resource', 'common', true, 250, true, true, true, true, 'sand_crab_meat', ARRAY['default']::text[], 250),
  ('mangrove_crab_meat', 'Mangrove Crab Meat', 'resource', 'common', true, 250, true, true, true, true, 'mangrove_crab_meat', ARRAY['default']::text[], 250),
  ('frost_frog_legs', 'Frost Frog Legs', 'resource', 'common', true, 250, true, true, true, true, 'frost_frog_legs', ARRAY['default']::text[], 250),
  ('poison_frog_legs', 'Poison Frog Legs', 'resource', 'common', true, 250, true, true, true, true, 'poison_frog_legs', ARRAY['default']::text[], 250),
  ('desert_toad_legs', 'Desert Toad Legs', 'resource', 'common', true, 250, true, true, true, true, 'desert_toad_legs', ARRAY['default']::text[], 250),
  ('caiman_tail', 'Caiman Tail', 'resource', 'common', true, 250, true, true, true, true, 'caiman_tail', ARRAY['default']::text[], 250),
  ('crocodile_tail', 'Crocodile Tail', 'resource', 'common', true, 250, true, true, true, true, 'crocodile_tail', ARRAY['default']::text[], 250)
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
      'frost_wolf_cut', 'dune_wolf_cut', 'jungle_wolf_cut', 'bog_wolf_cut',
      'woolly_hog_cut', 'warthog_cut', 'jungle_hog_cut', 'mud_hog_cut',
      'javelina_cut', 'snow_bear_cut', 'black_bear_cut', 'sun_bear_cut',
      'ice_crab_meat', 'sand_crab_meat', 'mangrove_crab_meat', 'frost_frog_legs',
      'poison_frog_legs', 'desert_toad_legs', 'caiman_tail', 'crocodile_tail',
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
          'frost_wolf_cut', 'dune_wolf_cut', 'jungle_wolf_cut', 'bog_wolf_cut',
          'woolly_hog_cut', 'warthog_cut', 'jungle_hog_cut', 'mud_hog_cut',
          'javelina_cut', 'snow_bear_cut', 'black_bear_cut', 'sun_bear_cut',
          'ice_crab_meat', 'sand_crab_meat', 'mangrove_crab_meat', 'frost_frog_legs',
          'poison_frog_legs', 'desert_toad_legs', 'caiman_tail', 'crocodile_tail',
      'frost_wolf_cut', 'dune_wolf_cut', 'jungle_wolf_cut', 'bog_wolf_cut',
      'woolly_hog_cut', 'warthog_cut', 'jungle_hog_cut', 'mud_hog_cut',
      'javelina_cut', 'snow_bear_cut', 'black_bear_cut', 'sun_bear_cut',
      'ice_crab_meat', 'sand_crab_meat', 'mangrove_crab_meat', 'frost_frog_legs',
      'poison_frog_legs', 'desert_toad_legs', 'caiman_tail', 'crocodile_tail',
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
            'frost_wolf_cut', 'dune_wolf_cut', 'jungle_wolf_cut', 'bog_wolf_cut',
            'woolly_hog_cut', 'warthog_cut', 'jungle_hog_cut', 'mud_hog_cut',
            'javelina_cut', 'snow_bear_cut', 'black_bear_cut', 'sun_bear_cut',
            'ice_crab_meat', 'sand_crab_meat', 'mangrove_crab_meat', 'frost_frog_legs',
            'poison_frog_legs', 'desert_toad_legs', 'caiman_tail', 'crocodile_tail',
          'frost_wolf_cut', 'dune_wolf_cut', 'jungle_wolf_cut', 'bog_wolf_cut',
          'woolly_hog_cut', 'warthog_cut', 'jungle_hog_cut', 'mud_hog_cut',
          'javelina_cut', 'snow_bear_cut', 'black_bear_cut', 'sun_bear_cut',
          'ice_crab_meat', 'sand_crab_meat', 'mangrove_crab_meat', 'frost_frog_legs',
          'poison_frog_legs', 'desert_toad_legs', 'caiman_tail', 'crocodile_tail',
      'frost_wolf_cut', 'dune_wolf_cut', 'jungle_wolf_cut', 'bog_wolf_cut',
      'woolly_hog_cut', 'warthog_cut', 'jungle_hog_cut', 'mud_hog_cut',
      'javelina_cut', 'snow_bear_cut', 'black_bear_cut', 'sun_bear_cut',
      'ice_crab_meat', 'sand_crab_meat', 'mangrove_crab_meat', 'frost_frog_legs',
      'poison_frog_legs', 'desert_toad_legs', 'caiman_tail', 'crocodile_tail',
            'hog_cut', 'alligator_tail', 'bear_cut', 'elemental_ration',
            'scorching_bird_meat', 'zappy_bird_meat', 'freezing_bird_meat',
            'field_ration', 'hearty_ration', 'xoral_essence'
          )
          AND output_quantity = requested_input_quantity * CASE recipe_id
            WHEN 'frog_legs' THEN 1
            WHEN 'frost_frog_legs' THEN 1
            WHEN 'poison_frog_legs' THEN 1
            WHEN 'desert_toad_legs' THEN 1
            WHEN 'crab_meat' THEN 2
            WHEN 'ice_crab_meat' THEN 2
            WHEN 'sand_crab_meat' THEN 2
            WHEN 'mangrove_crab_meat' THEN 2
            WHEN 'small_catch' THEN 2
            WHEN 'jellyfish_jelly' THEN 2
            WHEN 'crawler_flesh' THEN 2
            WHEN 'squid_cut' THEN 3
            WHEN 'wolf_cut' THEN 4
            WHEN 'frost_wolf_cut' THEN 4
            WHEN 'dune_wolf_cut' THEN 4
            WHEN 'jungle_wolf_cut' THEN 4
            WHEN 'bog_wolf_cut' THEN 4
            WHEN 'deer_cut' THEN 5
            WHEN 'frost_deer_cut' THEN 5
            WHEN 'jungle_deer_cut' THEN 5
            WHEN 'marsh_deer_cut' THEN 5
            WHEN 'sand_deer_cut' THEN 5
            WHEN 'hog_cut' THEN 6
            WHEN 'woolly_hog_cut' THEN 6
            WHEN 'warthog_cut' THEN 6
            WHEN 'jungle_hog_cut' THEN 6
            WHEN 'mud_hog_cut' THEN 6
            WHEN 'javelina_cut' THEN 6
            WHEN 'alligator_tail' THEN 8
            WHEN 'caiman_tail' THEN 8
            WHEN 'crocodile_tail' THEN 8
            WHEN 'bear_cut' THEN 10
            WHEN 'snow_bear_cut' THEN 10
            WHEN 'black_bear_cut' THEN 10
            WHEN 'sun_bear_cut' THEN 10
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
    WHEN 'frost_wolf' THEN 'wolves_killed'
    WHEN 'dune_wolf' THEN 'wolves_killed'
    WHEN 'jungle_wolf' THEN 'wolves_killed'
    WHEN 'bog_wolf' THEN 'wolves_killed'
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
