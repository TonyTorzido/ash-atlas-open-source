-- Forward-only Universal Food identity correction.
-- Existing Small Catch and Elemental Ration rows, holdings, and Kitchen jobs
-- remain valid compatibility identities; only new drops use the species items.

LOCK TABLE item_definitions, kitchen_jobs IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO item_definitions (
  item_id, display_name, category, rarity, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants
)
VALUES
  ('crab_meat', 'Crab Meat', 'resource', 'common', true, 250, true, true, true, true, 'crab_meat', ARRAY['default']::text[]),
  ('jellyfish_jelly', 'Jellyfish Jelly', 'resource', 'common', true, 250, true, true, true, true, 'jellyfish_jelly', ARRAY['default']::text[]),
  ('crawler_flesh', 'Crawler Flesh', 'resource', 'common', true, 250, true, true, true, true, 'crawler_flesh', ARRAY['default']::text[]),
  ('scorching_bird_meat', 'Scorching Bird Meat', 'resource', 'common', true, 250, true, true, true, true, 'scorching_bird_meat', ARRAY['default']::text[]),
  ('zappy_bird_meat', 'Zappy Bird Meat', 'resource', 'common', true, 250, true, true, true, true, 'zappy_bird_meat', ARRAY['default']::text[]),
  ('freezing_bird_meat', 'Freezing Bird Meat', 'resource', 'common', true, 250, true, true, true, true, 'freezing_bird_meat', ARRAY['default']::text[])
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
  updated_at = clock_timestamp();

ALTER TABLE kitchen_jobs
  DROP CONSTRAINT IF EXISTS kitchen_jobs_recipe_id_check,
  DROP CONSTRAINT IF EXISTS kitchen_jobs_requested_input_quantity_check,
  DROP CONSTRAINT IF EXISTS kitchen_jobs_output_quantity_check,
  DROP CONSTRAINT IF EXISTS kitchen_jobs_check;

ALTER TABLE kitchen_jobs
  ADD CONSTRAINT kitchen_jobs_recipe_id_check
    CHECK (recipe_id IN (
      'deer_meat', 'wolf_meat', 'hog_meat', 'bear_meat',
      'alligator_meat', 'wild_meat', 'squid_meat',
      'frog_legs', 'crab_meat', 'small_catch', 'jellyfish_jelly',
      'crawler_flesh', 'squid_cut', 'wolf_cut', 'deer_cut',
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
          'alligator_meat', 'wild_meat', 'squid_meat'
        ) AND requested_input_quantity % 10 = 0)
        OR recipe_id IN (
          'frog_legs', 'crab_meat', 'small_catch', 'jellyfish_jelly',
          'crawler_flesh', 'squid_cut', 'wolf_cut', 'deer_cut',
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
          'alligator_meat', 'wild_meat', 'squid_meat'
        ) AND output_quantity * 10 = requested_input_quantity)
        OR (
          recipe_id IN (
            'frog_legs', 'crab_meat', 'small_catch', 'jellyfish_jelly',
            'crawler_flesh', 'squid_cut', 'wolf_cut', 'deer_cut',
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
