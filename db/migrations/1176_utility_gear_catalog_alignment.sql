-- Align live item_definitions rows with the compiled catalog so startup validation passes.
-- Utility gloves and boots are ordinary equipment in the compiled catalog (common, default
-- equipment weight), and the Ember Flask consumable is presented as "Ember Bomb". Forward-only and
-- idempotent: each statement only touches rows that still differ.
UPDATE item_definitions
SET rarity = 'common', unit_weight_grams = 1500
WHERE item_id IN ('lumber_glove', 'delver_glove', 'artisan_glove', 'lodestone_boot', 'coinwright_glove', 'tiller_boot', 'pathfinder_boot')
  AND (rarity IS DISTINCT FROM 'common' OR unit_weight_grams IS DISTINCT FROM 1500);

UPDATE item_definitions
SET display_name = 'Ember Bomb'
WHERE item_id = 'ember_flask' AND display_name IS DISTINCT FROM 'Ember Bomb';
