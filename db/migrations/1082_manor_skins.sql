-- Manor skins: one inventory item per non-default Manor type. The item is
-- `manor_skin` and its variant is the Manor type id, so a Manor type made in
-- Studio gets its skin without a code change (the server keeps
-- supported_variants in step with the shipped Manor types at startup).
-- Skins are bought with Glimmer, are droppable and market tradable, and stack
-- to one. Installing one moves it out of the owner's inventory into the Manor
-- (player_manors.manor_type_id is the installed skin); uninstalling returns it.
INSERT INTO item_definitions (
  item_id, display_name, category, rarity, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants, unit_weight_grams
) VALUES (
  'manor_skin', 'Skin', 'resource', 'rare', false, 1,
  true, true, true, true,
  'manor_skin', ARRAY['haunted_manor', 'samurai_manor']::text[], 100
)
ON CONFLICT (item_id) DO NOTHING;

-- Replay record of skin purchases and installs (one row per player request).
CREATE TABLE IF NOT EXISTS manor_skin_operations (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  action text NOT NULL CHECK (action IN ('install', 'purchase')),
  manor_type_id text NOT NULL CHECK (manor_type_id ~ '^[a-z0-9]+([-_][a-z0-9]+)*$'),
  manor_id uuid NULL REFERENCES player_manors(id) ON DELETE SET NULL,
  previous_manor_type_id text NULL,
  glimmer_cost bigint NOT NULL DEFAULT 0 CHECK (glimmer_cost >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, request_id)
);
