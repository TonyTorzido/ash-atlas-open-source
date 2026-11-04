-- Forward-only Kitchen constraint repair for the retained freshwater fish recipe.
-- The 0822 recipe is a legacy species recipe: 10..50 input, one Simple Food
-- per 10 fish. Keep every 0826 recipe and yield unchanged while restoring the
-- omitted freshwater_fish identity to the legacy branches.

LOCK TABLE kitchen_jobs IN SHARE ROW EXCLUSIVE MODE;

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
