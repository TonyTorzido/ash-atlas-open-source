-- Universal Kitchen ingredients from combat rewards.
--
-- These are ordinary non-edible resources.  Existing carcass/meat identities
-- remain in the catalog for retained inventory and historical replay; this
-- migration only adds the new V6 ingredient identities and recipe shape.

LOCK TABLE item_definitions, kitchen_jobs IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO item_definitions (
  item_id, display_name, category, rarity, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants
)
VALUES
  ('frog_legs', 'Frog Legs', 'resource', 'common', true, 250, true, true, true, true, 'frog_legs', ARRAY['default']::text[]),
  ('small_catch', 'Small Catch', 'resource', 'common', true, 250, true, true, true, true, 'small_catch', ARRAY['default']::text[]),
  ('squid_cut', 'Squid Cut', 'resource', 'common', true, 250, true, true, true, true, 'squid_cut', ARRAY['default']::text[]),
  ('wolf_cut', 'Wolf Cut', 'resource', 'common', true, 250, true, true, true, true, 'wolf_cut', ARRAY['default']::text[]),
  ('deer_cut', 'Deer Cut', 'resource', 'common', true, 250, true, true, true, true, 'deer_cut', ARRAY['default']::text[]),
  ('hog_cut', 'Hog Cut', 'resource', 'common', true, 250, true, true, true, true, 'hog_cut', ARRAY['default']::text[]),
  ('alligator_tail', 'Alligator Tail', 'resource', 'common', true, 250, true, true, true, true, 'alligator_tail', ARRAY['default']::text[]),
  ('bear_cut', 'Bear Cut', 'resource', 'common', true, 250, true, true, true, true, 'bear_cut', ARRAY['default']::text[]),
  ('elemental_ration', 'Elemental Ration', 'resource', 'common', true, 250, true, true, true, true, 'elemental_ration', ARRAY['default']::text[]),
  ('field_ration', 'Field Ration', 'resource', 'common', true, 250, true, true, true, true, 'field_ration', ARRAY['default']::text[]),
  ('hearty_ration', 'Hearty Ration', 'resource', 'common', true, 250, true, true, true, true, 'hearty_ration', ARRAY['default']::text[]),
  ('xoral_essence', 'Xoral Essence', 'resource', 'common', true, 250, true, true, true, true, 'xoral_essence', ARRAY['default']::text[])
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
      'frog_legs', 'small_catch', 'squid_cut', 'wolf_cut', 'deer_cut',
      'hog_cut', 'alligator_tail', 'bear_cut', 'elemental_ration',
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
          'frog_legs', 'small_catch', 'squid_cut', 'wolf_cut', 'deer_cut',
          'hog_cut', 'alligator_tail', 'bear_cut', 'elemental_ration',
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
            'frog_legs', 'small_catch', 'squid_cut', 'wolf_cut', 'deer_cut',
            'hog_cut', 'alligator_tail', 'bear_cut', 'elemental_ration',
            'field_ration', 'hearty_ration', 'xoral_essence'
          )
          AND output_quantity = requested_input_quantity * CASE recipe_id
            WHEN 'frog_legs' THEN 1
            WHEN 'small_catch' THEN 2
            WHEN 'squid_cut' THEN 3
            WHEN 'wolf_cut' THEN 4
            WHEN 'deer_cut' THEN 5
            WHEN 'hog_cut' THEN 6
            WHEN 'alligator_tail' THEN 8
            WHEN 'bear_cut' THEN 10
            WHEN 'elemental_ration' THEN 20
            WHEN 'field_ration' THEN 4
            WHEN 'hearty_ration' THEN 8
            WHEN 'xoral_essence' THEN 20
          END
        )
      )
    );
