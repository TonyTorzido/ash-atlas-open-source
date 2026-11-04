-- Backpack +N is a persistent instance contract. Keep legacy definition IDs for
-- custody/event compatibility, but make level, cost, capacity, and own weight
-- match the shared catalog going forward. Existing bags receive the authorized
-- +10 gift without changing their owner or location.
LOCK TABLE inventory_carry_rules, backpack_level_definitions,
  player_backpack_instances IN ACCESS EXCLUSIVE MODE;
SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE inventory_carry_rules
  DROP CONSTRAINT IF EXISTS inventory_carry_rules_backpack_unit_weight_grams_check;
ALTER TABLE inventory_carry_rules
  ADD CONSTRAINT inventory_carry_rules_backpack_unit_weight_grams_check
  CHECK (backpack_unit_weight_grams >= 0);

UPDATE inventory_carry_rules
SET backpack_unit_weight_grams = 0
WHERE singleton = true;

UPDATE backpack_level_definitions AS levels
SET capacity_bonus_grams = values.capacity_bonus_grams,
    leather_cost = values.leather_cost,
    gold_cost = values.gold_cost,
    effects = '{}'::jsonb
FROM (VALUES
  (0::smallint, 5000::bigint, 80::bigint, 2000::bigint),
  (1::smallint, 10000::bigint, 20::bigint, 500::bigint),
  (2::smallint, 15000::bigint, 35::bigint, 1000::bigint),
  (3::smallint, 20000::bigint, 50::bigint, 1500::bigint),
  (4::smallint, 25000::bigint, 80::bigint, 2500::bigint),
  (5::smallint, 30000::bigint, 120::bigint, 4000::bigint),
  (6::smallint, 35000::bigint, 180::bigint, 6500::bigint),
  (7::smallint, 40000::bigint, 260::bigint, 10000::bigint),
  (8::smallint, 45000::bigint, 375::bigint, 15000::bigint),
  (9::smallint, 50000::bigint, 550::bigint, 22500::bigint),
  (10::smallint, 55000::bigint, 800::bigint, 35000::bigint)
) AS values(level, capacity_bonus_grams, leather_cost, gold_cost)
WHERE levels.level = values.level;

UPDATE player_backpack_instances
SET upgrade_level = 10,
    updated_at = now()
WHERE upgrade_level <> 10;
