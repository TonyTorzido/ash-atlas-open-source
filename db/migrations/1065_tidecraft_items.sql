-- Water game phase D (docs/design/WATER_GAME_PLAN.md): Tidecraft.
-- Item rows for the five crafted Tidecraft items (they match
-- packages/shared/src/inventoryCatalog.ts and inventoryWeight.ts), the
-- Tidewater Draught as a stored timed buff (lost on death, kept through
-- logout), and the Mason's Tome mark on a repair (one tome per repair).
-- Forward-only and idempotent.

LOCK TABLE item_definitions IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO item_definitions (
  item_id, display_name, category, rarity, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants, unit_weight_grams
)
VALUES
  ('tidewater_draught', 'Tidewater Draught', 'consumable', 'rare', true, 100, true, true, true, true, 'tidewater_draught', ARRAY['default']::text[], 100),
  ('undertow_snare', 'Undertow Snare', 'consumable', 'rare', true, 100, true, true, true, true, 'undertow_snare', ARRAY['default']::text[], 1000),
  ('stillwater_orb', 'Stillwater Orb', 'consumable', 'rare', true, 100, true, true, true, true, 'stillwater_orb', ARRAY['default']::text[], 200),
  ('free_step_ward', 'Free-Step Ward', 'consumable', 'epic', true, 100, true, true, true, true, 'free_step_ward', ARRAY['default']::text[], 300),
  ('masons_tome', 'Mason''s Tome', 'consumable', 'epic', true, 25, true, true, true, true, 'masons_tome', ARRAY['default']::text[], 500)
ON CONFLICT (item_id) DO NOTHING;

-- IF EXISTS keeps out-of-order harnesses that replay history without 1013
-- working; in deployment order 1013 always created the table first.
ALTER TABLE IF EXISTS player_field_buffs
  DROP CONSTRAINT IF EXISTS player_field_buffs_buff_id_check;
ALTER TABLE IF EXISTS player_field_buffs
  ADD CONSTRAINT player_field_buffs_buff_id_check
  CHECK (buff_id IN ('anti_venom', 'inspiration', 'tidewater'));

ALTER TABLE flag_repair_operations
  ADD COLUMN IF NOT EXISTS masons_tome_applied_at timestamptz NULL;
