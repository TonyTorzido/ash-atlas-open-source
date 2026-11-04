-- Field consumables: Anti-Venom Tonic, Battle Draught, Ember Flask, Spark Tonic, Net and Trap.
-- Item rows match packages/shared/src/inventoryCatalog.ts and inventoryWeight.ts. The two timed
-- tonics persist through death and logout in player_field_buffs (one row per player and buff).
-- Forward-only and idempotent.
INSERT INTO item_definitions (
  item_id, display_name, category, rarity, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants, unit_weight_grams
)
VALUES
  ('anti_venom_tonic', 'Anti-Venom Tonic', 'consumable', 'uncommon', true, 100, true, true, true, true, 'anti_venom_tonic', ARRAY['default']::text[], 100),
  ('battle_draught', 'Battle Draught', 'consumable', 'uncommon', true, 100, true, true, true, true, 'battle_draught', ARRAY['default']::text[], 100),
  ('ember_flask', 'Ember Flask', 'consumable', 'uncommon', true, 100, true, true, true, true, 'ember_flask', ARRAY['default']::text[], 100),
  ('spark_tonic', 'Spark Tonic', 'consumable', 'uncommon', true, 100, true, true, true, true, 'spark_tonic', ARRAY['default']::text[], 100),
  ('field_net', 'Net', 'consumable', 'uncommon', true, 100, true, true, true, true, 'field_net', ARRAY['default']::text[], 500),
  ('field_trap', 'Trap', 'consumable', 'uncommon', true, 100, true, true, true, true, 'field_trap', ARRAY['default']::text[], 1000)
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
  updated_at = now();

CREATE TABLE IF NOT EXISTS player_field_buffs (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  buff_id text NOT NULL CHECK (buff_id IN ('anti_venom', 'inspiration')),
  operation_key text NOT NULL,
  started_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, buff_id),
  CHECK (ends_at > started_at)
);

CREATE INDEX IF NOT EXISTS player_field_buffs_ends_at_idx
  ON player_field_buffs (ends_at);
