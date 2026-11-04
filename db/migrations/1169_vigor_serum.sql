-- Vigor Serum: a consumable (Alchemy rank 2) that adds 120 max health for 75 minutes. Stored as a
-- timed buff like the tonics: it lasts through logout and is lost on death. Item row matches
-- packages/shared/src/inventoryCatalog.ts and inventoryWeight.ts. Forward-only and idempotent.

LOCK TABLE item_definitions IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO item_definitions (
  item_id, display_name, category, rarity, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants, unit_weight_grams
)
VALUES
  ('vigor_serum', 'Vigor Serum', 'consumable', 'rare', true, 100, true, true, true, true, 'vigor_serum', ARRAY['default']::text[], 100)
ON CONFLICT (item_id) DO NOTHING;

ALTER TABLE IF EXISTS player_field_buffs
  DROP CONSTRAINT IF EXISTS player_field_buffs_buff_id_check;
ALTER TABLE IF EXISTS player_field_buffs
  ADD CONSTRAINT player_field_buffs_buff_id_check
  CHECK (buff_id IN ('anti_venom', 'inspiration', 'tidewater', 'vigor_serum'));
