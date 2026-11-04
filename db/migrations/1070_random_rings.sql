-- Random-roll rings (docs/design/RINGS_AND_AMULETS.md, phases 1-2, rings only).
--
-- 1. Item rows for the four ring tiers and the Ring Shard. Shapes mirror the shared catalog
--    (equipment.ts random_ring family, inventoryCatalog.ts, inventoryWeight.ts); the boot catalog
--    check compares them.
-- 2. Rolled bonuses and the Rough (unpolished) state live on the ring instance.
-- 3. A second ring slot (ring_2).
-- 4. Every Training, Chopping, Mining and Attack Ring, wherever it is (inventory, equipped,
--    stash, market escrow or collection, gift escrow, ground), becomes a Plain ring with one Low
--    bonus picked evenly from every bonus that has a Low value (rings.ts RING_LOW_ELIGIBLE_BONUS_IDS).
--    The four retired item rows stay for history (operations, journals, old rewards).

INSERT INTO item_definitions (
  item_id, display_name, category, equipment_family_id, equipment_role, rarity,
  stackable, max_stack, droppable, manor_storable,
  market_tradable, market_fungible, market_identity, supported_variants, unit_weight_grams
) VALUES
  ('ring_plain', 'Plain Ring', 'equipment', 'random_ring', 'special', 'common', false, 1, true, true, false, false, NULL, ARRAY['default']::text[], 50),
  ('ring_fine', 'Fine Ring', 'equipment', 'random_ring', 'special', 'common', false, 1, true, true, false, false, NULL, ARRAY['default']::text[], 50),
  ('ring_prime', 'Prime Ring', 'equipment', 'random_ring', 'special', 'common', false, 1, true, true, false, false, NULL, ARRAY['default']::text[], 50),
  ('ring_peerless', 'Peerless Ring', 'equipment', 'random_ring', 'special', 'common', false, 1, true, true, false, false, NULL, ARRAY['default']::text[], 50)
ON CONFLICT (item_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  category = EXCLUDED.category,
  equipment_family_id = EXCLUDED.equipment_family_id,
  equipment_role = EXCLUDED.equipment_role,
  rarity = EXCLUDED.rarity,
  stackable = EXCLUDED.stackable,
  max_stack = EXCLUDED.max_stack,
  droppable = EXCLUDED.droppable,
  manor_storable = EXCLUDED.manor_storable,
  market_tradable = EXCLUDED.market_tradable,
  market_fungible = EXCLUDED.market_fungible,
  market_identity = EXCLUDED.market_identity,
  supported_variants = EXCLUDED.supported_variants,
  unit_weight_grams = EXCLUDED.unit_weight_grams;

INSERT INTO item_definitions (
  item_id, display_name, category, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants, unit_weight_grams, rarity
) VALUES (
  'ring_shard', 'Ring Shard', 'resource', true, 10000,
  true, true, true, true, 'ring_shard', ARRAY['default']::text[], 1, 'uncommon'
)
ON CONFLICT (item_id) DO NOTHING;

ALTER TABLE equipment_instances
  ADD COLUMN IF NOT EXISTS ring_bonuses jsonb NULL,
  ADD COLUMN IF NOT EXISTS ring_rough boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN equipment_instances.ring_bonuses IS
  'Random-roll rings only: server-rolled bonuses [{id, family?}], 1 for Plain, 2 for Fine/Prime/Peerless.';
COMMENT ON COLUMN equipment_instances.ring_rough IS
  'Unpolished Fine/Prime/Peerless ring: tier only, cannot be worn, dropped, traded or sold.';

-- Second ring slot.
ALTER TABLE equipment_instances
  DROP CONSTRAINT IF EXISTS equipment_instances_equipped_slot_check;
ALTER TABLE equipment_instances
  ADD CONSTRAINT equipment_instances_equipped_slot_check
    CHECK (
      equipped_slot IS NULL
      OR equipped_slot IN ('head', 'chest', 'gloves', 'boots', 'ring', 'ring_2', 'melee', 'secondary')
    );

ALTER TABLE equipment_operations
  DROP CONSTRAINT IF EXISTS equipment_operations_requested_slot_check;
ALTER TABLE equipment_operations
  ADD CONSTRAINT equipment_operations_requested_slot_check
  CHECK (
    requested_slot IS NULL
    OR requested_slot IN (
      'weapon', 'head', 'chest', 'gloves', 'boots', 'ring', 'ring_2', 'melee', 'secondary'
    )
  );

ALTER TABLE combat_kit_items
  DROP CONSTRAINT IF EXISTS combat_kit_items_equipment_slot_check;
ALTER TABLE combat_kit_items
  ADD CONSTRAINT combat_kit_items_equipment_slot_check
    CHECK (equipment_slot IN ('head', 'chest', 'gloves', 'boots', 'ring', 'ring_2', 'melee', 'secondary'));

-- Xoral now pays a Plain ring; old rows keep their original ring ids.
ALTER TABLE xoral_event_rewards
  DROP CONSTRAINT IF EXISTS xoral_event_rewards_ring_definition_id_check;
ALTER TABLE xoral_event_rewards
  ADD CONSTRAINT xoral_event_rewards_ring_definition_id_check
    CHECK (ring_definition_id IN ('ring_plain', 'chopping_ring', 'mining_ring', 'attack_ring'));
ALTER TABLE xoral_ring_drops
  DROP CONSTRAINT IF EXISTS xoral_ring_drops_ring_definition_id_check;
ALTER TABLE xoral_ring_drops
  ADD CONSTRAINT xoral_ring_drops_ring_definition_id_check
    CHECK (ring_definition_id IN ('ring_plain', 'chopping_ring', 'mining_ring', 'attack_ring'));

-- Added before the conversion (no ring-tier rows exist yet), because the carry guard's deferred
-- trigger events from the UPDATEs below block any later ALTER TABLE in this transaction.
-- Every ring tier carries its bonuses; only Fine and up can be Rough, and a Rough ring is never
-- worn, listed or gifted. It may lie on the ground only as overflow loot (a full bag); players
-- cannot drop one by hand (server rule) and a death never drops one.
ALTER TABLE equipment_instances
  DROP CONSTRAINT IF EXISTS equipment_instances_ring_roll_check,
  DROP CONSTRAINT IF EXISTS equipment_instances_ring_rough_check;
ALTER TABLE equipment_instances
  ADD CONSTRAINT equipment_instances_ring_roll_check CHECK (
    CASE
      WHEN definition_id IN ('ring_plain', 'ring_fine', 'ring_prime', 'ring_peerless') THEN
        ring_bonuses IS NOT NULL
        AND jsonb_typeof(ring_bonuses) = 'array'
        AND jsonb_array_length(ring_bonuses) = CASE WHEN definition_id = 'ring_plain' THEN 1 ELSE 2 END
      ELSE ring_bonuses IS NULL
    END
  ),
  ADD CONSTRAINT equipment_instances_ring_rough_check CHECK (
    NOT ring_rough
    OR (
      definition_id IN ('ring_fine', 'ring_prime', 'ring_peerless')
      AND location IN ('inventory', 'manor_storage', 'world_drop', 'destroyed')
    )
  );

-- Conversion: one evenly picked Low bonus per retired ring (Quarry rows also pick a mob family).
WITH pool AS (
  SELECT ARRAY[
    'storm_chance','storm_damage','skyrise_chance','skyrise_duration','gale_distance',
    'gale_chance','mirage_chance','cleave_chance','cleave_damage','tactics_hold','tactics_build',
    'scavenge_chance','huntsman_chance','huntsman_damage','perfect_strike_chance',
    'war_standard_cooldown','second_wind_health','taunt_cooldown','deathburst_damage',
    'cleanse_cooldown','peerless_luck','dodge','max_hp','land_speed','water_speed','bow_reach',
    'frost_bite','frost_ward','expel_touch','expel_ward','venom_bite','venom_ward','gloom_reach',
    'whetted_edge','whetted_ward','revenant_attack','revenant_defense','ember_bite','ember_ward',
    'fleet_chopper','fleet_miner','fleet_builder','fleet_crafter','root_ward','snare_ward',
    'weaken_ward','knockdown_ward','hound_trainer','wolf_tamer','boar_tamer','stormbird_tamer',
    'drake_tamer','quarry_hunter','quarry_guard','hollin_helper_attack','hollin_helper_defense',
    'treant_attack','treant_defense','deepstone_yield','blight_ward'
  ]::text[] AS bonus_ids,
  ARRAY['deer','wolf','hog','bear','coastal_crab','frog','alligator']::text[] AS families
),
picked AS (
  SELECT
    equipment.instance_id,
    pool.bonus_ids[1 + floor(random() * cardinality(pool.bonus_ids))::int] AS bonus_id,
    pool.families[1 + floor(random() * cardinality(pool.families))::int] AS family
  FROM equipment_instances equipment
  CROSS JOIN pool
  WHERE equipment.definition_id IN ('training_ring', 'chopping_ring', 'mining_ring', 'attack_ring')
)
UPDATE equipment_instances equipment
SET definition_id = 'ring_plain',
    ring_bonuses = jsonb_build_array(
      CASE WHEN picked.bonus_id IN ('quarry_hunter', 'quarry_guard')
        THEN jsonb_build_object('id', picked.bonus_id, 'family', picked.family)
        ELSE jsonb_build_object('id', picked.bonus_id)
      END
    ),
    ring_rough = false,
    metadata = equipment.metadata || jsonb_build_object('convertedFromRing', equipment.definition_id),
    updated_at = now()
FROM picked
WHERE equipment.instance_id = picked.instance_id;

-- Rings on the ground and in open market listings follow their instance.
UPDATE world_equipment_drops drop_row
SET item_id = 'ring_plain'
FROM equipment_instances equipment
WHERE equipment.instance_id = drop_row.equipment_instance_id
  AND equipment.definition_id = 'ring_plain'
  AND drop_row.item_id IN ('training_ring', 'chopping_ring', 'mining_ring', 'attack_ring');

UPDATE market_equipment_listings listing
SET presentation_snapshot = listing.presentation_snapshot || jsonb_build_object(
      'definitionId', 'ring_plain',
      'displayName', 'Plain Ring',
      'artworkKey', 'ring_plain',
      'utilityIdentity', NULL,
      'ring', jsonb_build_object('tier', 'plain', 'rough', false, 'bonuses', equipment.ring_bonuses)
    )
FROM equipment_instances equipment
WHERE equipment.instance_id = listing.equipment_instance_id
  AND equipment.definition_id = 'ring_plain'
  AND listing.presentation_snapshot->>'definitionId' IN ('training_ring', 'chopping_ring', 'mining_ring', 'attack_ring');

-- Unclaimed Xoral ground rings now pay a Plain ring when picked up.
UPDATE xoral_ring_drops
SET ring_definition_id = 'ring_plain'
WHERE status = 'available' AND ring_definition_id <> 'ring_plain';

-- Dump and polish idempotency: one row per request, holding the stored result for replays.
CREATE TABLE IF NOT EXISTS ring_operations (
  operation_key text PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('polish', 'dump')),
  instance_id uuid NOT NULL REFERENCES equipment_instances(instance_id) ON DELETE RESTRICT,
  tier text NOT NULL CHECK (tier IN ('plain', 'fine', 'prime', 'peerless')),
  was_rough boolean NOT NULL,
  oil_spent integer NOT NULL DEFAULT 0 CHECK (oil_spent >= 0),
  shards_granted integer NOT NULL DEFAULT 0 CHECK (shards_granted >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ring_operations_player_idx ON ring_operations (player_id, created_at);
