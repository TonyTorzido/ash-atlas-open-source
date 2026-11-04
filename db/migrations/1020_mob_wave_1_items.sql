-- Mob wave 1: Kitchen cuts for the new animals (45 meat cuts, 6 fish and
-- seafood fillets) and the Mammoth Patriarch's Mammoth Cut.
-- Forward-only and idempotent.
-- 1. Item catalog rows (same policy and weight as every other species cut).
-- 2. Kitchen constraints from 0918 plus the new cuts at their own yields.

LOCK TABLE item_definitions, kitchen_jobs IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO item_definitions (
  item_id, display_name, category, rarity, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants, unit_weight_grams
)
VALUES
  ('jungle_tapir_cut', 'Jungle Tapir Cut', 'resource', 'common', true, 250, true, true, true, true, 'jungle_tapir_cut', ARRAY['default']::text[], 250),
  ('jaguar_cut', 'Jaguar Cut', 'resource', 'common', true, 250, true, true, true, true, 'jaguar_cut', ARRAY['default']::text[], 250),
  ('mandrill_cut', 'Mandrill Cut', 'resource', 'common', true, 250, true, true, true, true, 'mandrill_cut', ARRAY['default']::text[], 250),
  ('capercaillie_meat', 'Capercaillie Meat', 'resource', 'common', true, 250, true, true, true, true, 'capercaillie_meat', ARRAY['default']::text[], 250),
  ('elk_cut', 'Elk Cut', 'resource', 'common', true, 250, true, true, true, true, 'elk_cut', ARRAY['default']::text[], 250),
  ('red_squirrel_cut', 'Red Squirrel Cut', 'resource', 'common', true, 250, true, true, true, true, 'red_squirrel_cut', ARRAY['default']::text[], 250),
  ('badger_cut', 'Badger Cut', 'resource', 'common', true, 250, true, true, true, true, 'badger_cut', ARRAY['default']::text[], 250),
  ('grey_squirrel_cut', 'Grey Squirrel Cut', 'resource', 'common', true, 250, true, true, true, true, 'grey_squirrel_cut', ARRAY['default']::text[], 250),
  ('stag_beetle_cut', 'Stag Beetle Cut', 'resource', 'common', true, 250, true, true, true, true, 'stag_beetle_cut', ARRAY['default']::text[], 250),
  ('great_grey_owl_meat', 'Great Grey Owl Meat', 'resource', 'common', true, 250, true, true, true, true, 'great_grey_owl_meat', ARRAY['default']::text[], 250),
  ('flying_squirrel_cut', 'Flying Squirrel Cut', 'resource', 'common', true, 250, true, true, true, true, 'flying_squirrel_cut', ARRAY['default']::text[], 250),
  ('plains_bison_cut', 'Plains Bison Cut', 'resource', 'common', true, 250, true, true, true, true, 'plains_bison_cut', ARRAY['default']::text[], 250),
  ('prairie_dog_cut', 'Prairie Dog Cut', 'resource', 'common', true, 250, true, true, true, true, 'prairie_dog_cut', ARRAY['default']::text[], 250),
  ('burrowing_owl_meat', 'Burrowing Owl Meat', 'resource', 'common', true, 250, true, true, true, true, 'burrowing_owl_meat', ARRAY['default']::text[], 250),
  ('giraffe_cut', 'Giraffe Cut', 'resource', 'common', true, 250, true, true, true, true, 'giraffe_cut', ARRAY['default']::text[], 250),
  ('lioness_cut', 'Lioness Cut', 'resource', 'common', true, 250, true, true, true, true, 'lioness_cut', ARRAY['default']::text[], 250),
  ('spotted_hyena_cut', 'Spotted Hyena Cut', 'resource', 'common', true, 250, true, true, true, true, 'spotted_hyena_cut', ARRAY['default']::text[], 250),
  ('sitatunga_cut', 'Sitatunga Cut', 'resource', 'common', true, 250, true, true, true, true, 'sitatunga_cut', ARRAY['default']::text[], 250),
  ('emperor_dragonfly_cut', 'Emperor Dragonfly Cut', 'resource', 'common', true, 250, true, true, true, true, 'emperor_dragonfly_cut', ARRAY['default']::text[], 250),
  ('mountain_ibex_cut', 'Mountain Ibex Cut', 'resource', 'common', true, 250, true, true, true, true, 'mountain_ibex_cut', ARRAY['default']::text[], 250),
  ('wild_yak_cut', 'Wild Yak Cut', 'resource', 'common', true, 250, true, true, true, true, 'wild_yak_cut', ARRAY['default']::text[], 250),
  ('alpine_marmot_cut', 'Alpine Marmot Cut', 'resource', 'common', true, 250, true, true, true, true, 'alpine_marmot_cut', ARRAY['default']::text[], 250),
  ('wild_scrub_goat_cut', 'Wild Scrub Goat Cut', 'resource', 'common', true, 250, true, true, true, true, 'wild_scrub_goat_cut', ARRAY['default']::text[], 250),
  ('crested_porcupine_cut', 'Crested Porcupine Cut', 'resource', 'common', true, 250, true, true, true, true, 'crested_porcupine_cut', ARRAY['default']::text[], 250),
  ('spur_thighed_tortoise_cut', 'Spur-thighed Tortoise Cut', 'resource', 'common', true, 250, true, true, true, true, 'spur_thighed_tortoise_cut', ARRAY['default']::text[], 250),
  ('dromedary_cut', 'Dromedary Cut', 'resource', 'common', true, 250, true, true, true, true, 'dromedary_cut', ARRAY['default']::text[], 250),
  ('fennec_fox_cut', 'Fennec Fox Cut', 'resource', 'common', true, 250, true, true, true, true, 'fennec_fox_cut', ARRAY['default']::text[], 250),
  ('sidewinder_cut', 'Sidewinder Cut', 'resource', 'common', true, 250, true, true, true, true, 'sidewinder_cut', ARRAY['default']::text[], 250),
  ('desert_lion_cut', 'Desert Lion Cut', 'resource', 'common', true, 250, true, true, true, true, 'desert_lion_cut', ARRAY['default']::text[], 250),
  ('saiga_cut', 'Saiga Cut', 'resource', 'common', true, 250, true, true, true, true, 'saiga_cut', ARRAY['default']::text[], 250),
  ('wild_horse_cut', 'Steppe Wild Horse Cut', 'resource', 'common', true, 250, true, true, true, true, 'wild_horse_cut', ARRAY['default']::text[], 250),
  ('steppe_marmot_cut', 'Steppe Marmot Cut', 'resource', 'common', true, 250, true, true, true, true, 'steppe_marmot_cut', ARRAY['default']::text[], 250),
  ('lemming_cut', 'Lemming Cut', 'resource', 'common', true, 250, true, true, true, true, 'lemming_cut', ARRAY['default']::text[], 250),
  ('snow_goose_meat', 'Snow Goose Meat', 'resource', 'common', true, 250, true, true, true, true, 'snow_goose_meat', ARRAY['default']::text[], 250),
  ('mammoth_cut', 'Mammoth Cut', 'resource', 'common', true, 250, true, true, true, true, 'mammoth_cut', ARRAY['default']::text[], 250),
  ('emperor_penguin_meat', 'Penguin Meat', 'resource', 'common', true, 250, true, true, true, true, 'emperor_penguin_meat', ARRAY['default']::text[], 250),
  ('peary_caribou_cut', 'Peary Caribou Cut', 'resource', 'common', true, 250, true, true, true, true, 'peary_caribou_cut', ARRAY['default']::text[], 250),
  ('ice_worm_cut', 'Ice Worm Cut', 'resource', 'common', true, 250, true, true, true, true, 'ice_worm_cut', ARRAY['default']::text[], 250),
  ('sea_otter_cut', 'Sea Otter Cut', 'resource', 'common', true, 250, true, true, true, true, 'sea_otter_cut', ARRAY['default']::text[], 250),
  ('herring_gull_meat', 'Gull Meat', 'resource', 'common', true, 250, true, true, true, true, 'herring_gull_meat', ARRAY['default']::text[], 250),
  ('spiny_lobster_tail', 'Spiny Lobster Tail', 'resource', 'common', true, 250, true, true, true, true, 'spiny_lobster_tail', ARRAY['default']::text[], 250),
  ('hammerhead_shark_steak', 'Hammerhead Steak', 'resource', 'common', true, 250, true, true, true, true, 'hammerhead_shark_steak', ARRAY['default']::text[], 250),
  ('manta_ray_wing', 'Manta Wing', 'resource', 'common', true, 250, true, true, true, true, 'manta_ray_wing', ARRAY['default']::text[], 250),
  ('humpback_whale_cut', 'Whale Cut', 'resource', 'common', true, 250, true, true, true, true, 'humpback_whale_cut', ARRAY['default']::text[], 250),
  ('muskellunge_fillet', 'Muskellunge Fillet', 'resource', 'common', true, 250, true, true, true, true, 'muskellunge_fillet', ARRAY['default']::text[], 250),
  ('mute_swan_meat', 'Swan Meat', 'resource', 'common', true, 250, true, true, true, true, 'mute_swan_meat', ARRAY['default']::text[], 250),
  ('pike_fillet', 'Pike Fillet', 'resource', 'common', true, 250, true, true, true, true, 'pike_fillet', ARRAY['default']::text[], 250),
  ('snapping_turtle_cut', 'Turtle Cut', 'resource', 'common', true, 250, true, true, true, true, 'snapping_turtle_cut', ARRAY['default']::text[], 250),
  ('beaver_cut', 'Beaver Cut', 'resource', 'common', true, 250, true, true, true, true, 'beaver_cut', ARRAY['default']::text[], 250),
  ('otter_cut', 'Otter Cut', 'resource', 'common', true, 250, true, true, true, true, 'otter_cut', ARRAY['default']::text[], 250),
  ('salmon_fillet', 'Salmon Fillet', 'resource', 'common', true, 250, true, true, true, true, 'salmon_fillet', ARRAY['default']::text[], 250)
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
      'deer_meat', 'wolf_meat', 'hog_meat', 'bear_meat', 'alligator_meat',
      'wild_meat', 'squid_meat', 'freshwater_fish', 'frog_legs', 'frost_frog_legs',
      'poison_frog_legs', 'desert_toad_legs', 'crab_meat', 'ice_crab_meat',
      'sand_crab_meat', 'mangrove_crab_meat', 'small_catch', 'jellyfish_jelly',
      'crawler_flesh', 'squid_cut', 'wolf_cut', 'frost_wolf_cut', 'dune_wolf_cut',
      'jungle_wolf_cut', 'bog_wolf_cut', 'deer_cut', 'frost_deer_cut',
      'jungle_deer_cut', 'marsh_deer_cut', 'sand_deer_cut', 'hog_cut',
      'woolly_hog_cut', 'warthog_cut', 'jungle_hog_cut', 'mud_hog_cut',
      'javelina_cut', 'alligator_tail', 'caiman_tail', 'crocodile_tail',
      'bear_cut', 'snow_bear_cut', 'black_bear_cut', 'sun_bear_cut',
      'jungle_tapir_cut', 'jaguar_cut', 'mandrill_cut', 'capercaillie_meat',
      'elk_cut', 'red_squirrel_cut', 'badger_cut', 'grey_squirrel_cut',
      'stag_beetle_cut', 'great_grey_owl_meat', 'flying_squirrel_cut',
      'plains_bison_cut', 'prairie_dog_cut', 'burrowing_owl_meat', 'giraffe_cut',
      'lioness_cut', 'spotted_hyena_cut', 'sitatunga_cut', 'emperor_dragonfly_cut',
      'mountain_ibex_cut', 'wild_yak_cut', 'alpine_marmot_cut',
      'wild_scrub_goat_cut', 'crested_porcupine_cut', 'spur_thighed_tortoise_cut',
      'dromedary_cut', 'fennec_fox_cut', 'sidewinder_cut', 'desert_lion_cut',
      'saiga_cut', 'wild_horse_cut', 'steppe_marmot_cut', 'lemming_cut',
      'snow_goose_meat', 'mammoth_cut', 'emperor_penguin_meat',
      'peary_caribou_cut', 'ice_worm_cut', 'sea_otter_cut', 'herring_gull_meat',
      'spiny_lobster_tail', 'hammerhead_shark_steak', 'manta_ray_wing',
      'humpback_whale_cut', 'muskellunge_fillet', 'mute_swan_meat', 'pike_fillet',
      'snapping_turtle_cut', 'beaver_cut', 'otter_cut', 'salmon_fillet',
      'elemental_ration', 'scorching_bird_meat', 'zappy_bird_meat',
      'freezing_bird_meat', 'field_ration', 'hearty_ration', 'xoral_essence'
    )),
  ADD CONSTRAINT kitchen_jobs_requested_input_quantity_check
    CHECK (
      requested_input_quantity BETWEEN 1 AND 50
      AND (
        (recipe_id IN (
          'deer_meat', 'wolf_meat', 'hog_meat', 'bear_meat', 'alligator_meat',
          'wild_meat', 'squid_meat', 'freshwater_fish'
        ) AND requested_input_quantity % 10 = 0)
        OR recipe_id IN (
          'frog_legs', 'frost_frog_legs', 'poison_frog_legs', 'desert_toad_legs',
          'crab_meat', 'ice_crab_meat', 'sand_crab_meat', 'mangrove_crab_meat',
          'small_catch', 'jellyfish_jelly', 'crawler_flesh', 'squid_cut', 'wolf_cut',
          'frost_wolf_cut', 'dune_wolf_cut', 'jungle_wolf_cut', 'bog_wolf_cut',
          'deer_cut', 'frost_deer_cut', 'jungle_deer_cut', 'marsh_deer_cut',
          'sand_deer_cut', 'hog_cut', 'woolly_hog_cut', 'warthog_cut',
          'jungle_hog_cut', 'mud_hog_cut', 'javelina_cut', 'alligator_tail',
          'caiman_tail', 'crocodile_tail', 'bear_cut', 'snow_bear_cut',
          'black_bear_cut', 'sun_bear_cut', 'jungle_tapir_cut', 'jaguar_cut',
          'mandrill_cut', 'capercaillie_meat', 'elk_cut', 'red_squirrel_cut',
          'badger_cut', 'grey_squirrel_cut', 'stag_beetle_cut', 'great_grey_owl_meat',
          'flying_squirrel_cut', 'plains_bison_cut', 'prairie_dog_cut',
          'burrowing_owl_meat', 'giraffe_cut', 'lioness_cut', 'spotted_hyena_cut',
          'sitatunga_cut', 'emperor_dragonfly_cut', 'mountain_ibex_cut',
          'wild_yak_cut', 'alpine_marmot_cut', 'wild_scrub_goat_cut',
          'crested_porcupine_cut', 'spur_thighed_tortoise_cut', 'dromedary_cut',
          'fennec_fox_cut', 'sidewinder_cut', 'desert_lion_cut', 'saiga_cut',
          'wild_horse_cut', 'steppe_marmot_cut', 'lemming_cut', 'snow_goose_meat',
          'mammoth_cut', 'emperor_penguin_meat', 'peary_caribou_cut', 'ice_worm_cut',
          'sea_otter_cut', 'herring_gull_meat', 'spiny_lobster_tail',
          'hammerhead_shark_steak', 'manta_ray_wing', 'humpback_whale_cut',
          'muskellunge_fillet', 'mute_swan_meat', 'pike_fillet', 'snapping_turtle_cut',
          'beaver_cut', 'otter_cut', 'salmon_fillet', 'elemental_ration',
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
          'deer_meat', 'wolf_meat', 'hog_meat', 'bear_meat', 'alligator_meat',
          'wild_meat', 'squid_meat', 'freshwater_fish'
        ) AND output_quantity * 10 = requested_input_quantity)
        OR (
          recipe_id IN (
            'frog_legs', 'frost_frog_legs', 'poison_frog_legs', 'desert_toad_legs',
            'crab_meat', 'ice_crab_meat', 'sand_crab_meat', 'mangrove_crab_meat',
            'small_catch', 'jellyfish_jelly', 'crawler_flesh', 'squid_cut', 'wolf_cut',
            'frost_wolf_cut', 'dune_wolf_cut', 'jungle_wolf_cut', 'bog_wolf_cut',
            'deer_cut', 'frost_deer_cut', 'jungle_deer_cut', 'marsh_deer_cut',
            'sand_deer_cut', 'hog_cut', 'woolly_hog_cut', 'warthog_cut',
            'jungle_hog_cut', 'mud_hog_cut', 'javelina_cut', 'alligator_tail',
            'caiman_tail', 'crocodile_tail', 'bear_cut', 'snow_bear_cut',
            'black_bear_cut', 'sun_bear_cut', 'jungle_tapir_cut', 'jaguar_cut',
            'mandrill_cut', 'capercaillie_meat', 'elk_cut', 'red_squirrel_cut',
            'badger_cut', 'grey_squirrel_cut', 'stag_beetle_cut', 'great_grey_owl_meat',
            'flying_squirrel_cut', 'plains_bison_cut', 'prairie_dog_cut',
            'burrowing_owl_meat', 'giraffe_cut', 'lioness_cut', 'spotted_hyena_cut',
            'sitatunga_cut', 'emperor_dragonfly_cut', 'mountain_ibex_cut',
            'wild_yak_cut', 'alpine_marmot_cut', 'wild_scrub_goat_cut',
            'crested_porcupine_cut', 'spur_thighed_tortoise_cut', 'dromedary_cut',
            'fennec_fox_cut', 'sidewinder_cut', 'desert_lion_cut', 'saiga_cut',
            'wild_horse_cut', 'steppe_marmot_cut', 'lemming_cut', 'snow_goose_meat',
            'mammoth_cut', 'emperor_penguin_meat', 'peary_caribou_cut', 'ice_worm_cut',
            'sea_otter_cut', 'herring_gull_meat', 'spiny_lobster_tail',
            'hammerhead_shark_steak', 'manta_ray_wing', 'humpback_whale_cut',
            'muskellunge_fillet', 'mute_swan_meat', 'pike_fillet', 'snapping_turtle_cut',
            'beaver_cut', 'otter_cut', 'salmon_fillet', 'elemental_ration',
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
            WHEN 'jungle_tapir_cut' THEN 6
            WHEN 'jaguar_cut' THEN 8
            WHEN 'mandrill_cut' THEN 5
            WHEN 'capercaillie_meat' THEN 3
            WHEN 'elk_cut' THEN 8
            WHEN 'red_squirrel_cut' THEN 1
            WHEN 'badger_cut' THEN 3
            WHEN 'grey_squirrel_cut' THEN 1
            WHEN 'stag_beetle_cut' THEN 1
            WHEN 'great_grey_owl_meat' THEN 3
            WHEN 'flying_squirrel_cut' THEN 1
            WHEN 'plains_bison_cut' THEN 10
            WHEN 'prairie_dog_cut' THEN 1
            WHEN 'burrowing_owl_meat' THEN 1
            WHEN 'giraffe_cut' THEN 10
            WHEN 'lioness_cut' THEN 8
            WHEN 'spotted_hyena_cut' THEN 4
            WHEN 'sitatunga_cut' THEN 5
            WHEN 'emperor_dragonfly_cut' THEN 1
            WHEN 'mountain_ibex_cut' THEN 5
            WHEN 'wild_yak_cut' THEN 10
            WHEN 'alpine_marmot_cut' THEN 2
            WHEN 'wild_scrub_goat_cut' THEN 4
            WHEN 'crested_porcupine_cut' THEN 3
            WHEN 'spur_thighed_tortoise_cut' THEN 3
            WHEN 'dromedary_cut' THEN 8
            WHEN 'fennec_fox_cut' THEN 1
            WHEN 'sidewinder_cut' THEN 1
            WHEN 'desert_lion_cut' THEN 8
            WHEN 'saiga_cut' THEN 4
            WHEN 'wild_horse_cut' THEN 8
            WHEN 'steppe_marmot_cut' THEN 2
            WHEN 'lemming_cut' THEN 1
            WHEN 'snow_goose_meat' THEN 3
            WHEN 'mammoth_cut' THEN 12
            WHEN 'emperor_penguin_meat' THEN 3
            WHEN 'peary_caribou_cut' THEN 5
            WHEN 'ice_worm_cut' THEN 1
            WHEN 'sea_otter_cut' THEN 2
            WHEN 'herring_gull_meat' THEN 1
            WHEN 'spiny_lobster_tail' THEN 3
            WHEN 'hammerhead_shark_steak' THEN 8
            WHEN 'manta_ray_wing' THEN 5
            WHEN 'humpback_whale_cut' THEN 12
            WHEN 'muskellunge_fillet' THEN 5
            WHEN 'mute_swan_meat' THEN 4
            WHEN 'pike_fillet' THEN 3
            WHEN 'snapping_turtle_cut' THEN 4
            WHEN 'beaver_cut' THEN 3
            WHEN 'otter_cut' THEN 2
            WHEN 'salmon_fillet' THEN 2
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
