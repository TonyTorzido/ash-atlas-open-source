-- Water game phase B (docs/design/WATER_GAME_PLAN.md): Shellback Plate, the
-- water currency dropped by Shellbacks (and sometimes Darters), and Abyssal
-- Orb, the Tidecraft unlock orb Tide Wraiths and Gate Wardens sometimes drop.
-- Item catalog rows only; both are market tradable. Forward-only and idempotent.

LOCK TABLE item_definitions IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO item_definitions (
  item_id, display_name, category, rarity, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants, unit_weight_grams
)
VALUES
  ('shellback_plate', 'Shellback Plate', 'resource', 'uncommon', true, 250, true, true, true, true, 'shellback_plate', ARRAY['default']::text[], 250),
  ('abyssal_orb', 'Abyssal Orb', 'resource', 'epic', true, 25, true, true, true, true, 'abyssal_orb', ARRAY['default']::text[], 100)
ON CONFLICT (item_id) DO NOTHING;
