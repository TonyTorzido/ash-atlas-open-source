-- Loadout Scrolls: gear sets for fast swaps. The scroll is an ordinary stackable item, crafted
-- only by Atlas Pass members and usable, tradable and droppable by anyone. Each carried scroll is a
-- numbered position (1..count) whose memory belongs to its holder, so a traded or dropped scroll
-- arrives empty. Memory stores equipment instance ids, never copies; an equip skips any remembered
-- item that is no longer carried. Forward-only and idempotent.
LOCK TABLE item_definitions IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO item_definitions (
  item_id, display_name, category, rarity, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants, unit_weight_grams
)
VALUES
  ('loadout_scroll', 'Loadout Scroll', 'resource', 'rare', true, 100, true, true, true, true, 'loadout_scroll', ARRAY['default']::text[], 50)
ON CONFLICT (item_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS player_gear_scroll_memory (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  scroll_position integer NOT NULL CHECK (scroll_position >= 1),
  equipment_slot text NOT NULL CHECK (equipment_slot IN ('melee', 'secondary', 'head', 'chest', 'ring', 'ring_2')),
  instance_id uuid NOT NULL REFERENCES equipment_instances(instance_id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, scroll_position, equipment_slot)
);

COMMENT ON TABLE player_gear_scroll_memory IS
  'Loadout Scroll memory: per holder and scroll position, the equipment instance remembered for each slot.';
