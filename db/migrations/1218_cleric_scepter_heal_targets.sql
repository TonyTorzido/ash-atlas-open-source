-- Class roster v2, Cleric holy arc (docs/plans/class-roster-v2.md 5):
--
-- 1. The Scepter: the stock item of the new one-handed `scepter` weapon family. Shape, weight and
--    rarity mirror the other weapon family stock items (0961_weapon_family_item_definitions.sql)
--    and the shared equipment catalog (packages/shared/src/equipment.ts); the boot catalog check
--    compares them. Nothing here grants or modifies owned equipment.
-- 2. Heal-target settings: which groups a player's holy arc heals. One row per player who changed
--    them; a missing row means the defaults (party, friends, kingdom and city on, neutral off).
--
-- Idempotent: the insert upserts the catalog row and the table is created only when missing.
INSERT INTO item_definitions (
  item_id, display_name, category, equipment_family_id, equipment_role, rarity,
  stackable, max_stack, droppable, manor_storable,
  market_tradable, market_fungible, market_identity, supported_variants, unit_weight_grams
) VALUES
  ('training_scepter', 'Scepter', 'equipment', 'scepter', 'stock', 'common', false, 1, true, true, false, false, NULL, ARRAY['default']::text[], 1500)
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
  unit_weight_grams = EXCLUDED.unit_weight_grams,
  updated_at = now();

CREATE TABLE IF NOT EXISTS player_heal_target_settings (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  heal_party boolean NOT NULL DEFAULT true,
  heal_friends boolean NOT NULL DEFAULT true,
  heal_kingdom boolean NOT NULL DEFAULT true,
  heal_city boolean NOT NULL DEFAULT true,
  heal_neutral boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS player_heal_target_settings_set_updated_at ON player_heal_target_settings;
CREATE TRIGGER player_heal_target_settings_set_updated_at
BEFORE UPDATE ON player_heal_target_settings
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
