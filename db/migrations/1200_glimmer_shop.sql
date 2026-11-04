-- Glimmer Shop (docs/design/GLIMMER_SHOP.md): one admin-editable catalog for everything bought
-- with Glimmer, the purchase replay record, the catalog edit audit, paid face masks, and the new
-- Glimmer pack amounts and Atlas Pass prices. Forward-only and idempotent.

-- ---------------------------------------------------------------------------
-- Face masks: one inventory item, variant = mask appearance id (packages/shared/src/faceMasks.ts).
-- Bought in the shop, worn from the inventory, tradable like any item.
-- ---------------------------------------------------------------------------
INSERT INTO item_definitions (
  item_id, display_name, category, rarity, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants, unit_weight_grams
) VALUES (
  'face_mask', 'Mask', 'resource', 'rare', false, 1,
  true, true, true, true,
  'face_mask', ARRAY['hockey-mask', 'kitsune-mask', 'mask-1', 'mask-2', 'mask-3']::text[], 100
)
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

-- No free masks any more: clear every Salon-picked mask (server reset is planned; owner OK).
UPDATE players
SET mask_appearance_id = NULL,
    base_appearance_revision = base_appearance_revision + 1
WHERE mask_appearance_id IS NOT NULL;

-- "Worn => owned", checked at commit under one per-owner lock (the 1083 manor-skin pattern): a
-- worn mask can never leave the inventory and a player can only wear a mask they hold.
CREATE OR REPLACE FUNCTION enforce_face_mask_worn_owned() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  owner_id text;
  removed_variant text;
  worn text;
  held bigint;
BEGIN
  IF TG_TABLE_NAME = 'players' THEN
    owner_id := NEW.id;
    removed_variant := NULL;
  ELSE
    owner_id := OLD.player_id;
    removed_variant := OLD.variant;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('face-mask-worn:' || owner_id, 1200));
  SELECT mask_appearance_id INTO worn FROM players WHERE id = owner_id;
  IF worn IS NULL THEN
    RETURN NULL;
  END IF;
  IF removed_variant IS NOT NULL AND removed_variant <> worn THEN
    RETURN NULL;
  END IF;
  SELECT COALESCE(sum(quantity), 0) INTO held
  FROM player_inventory
  WHERE player_id = owner_id AND resource_type = 'face_mask' AND variant = worn;
  IF held < 1 THEN
    RAISE EXCEPTION 'That mask is being worn. Take it off first.'
      USING ERRCODE = '23514', CONSTRAINT = 'player_face_mask_worn';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS player_inventory_face_mask_worn_guard ON player_inventory;
CREATE CONSTRAINT TRIGGER player_inventory_face_mask_worn_guard
AFTER UPDATE OR DELETE ON player_inventory
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (OLD.resource_type = 'face_mask')
EXECUTE FUNCTION enforce_face_mask_worn_owned();

DROP TRIGGER IF EXISTS players_face_mask_worn_guard ON players;
CREATE CONSTRAINT TRIGGER players_face_mask_worn_guard
AFTER INSERT OR UPDATE OF mask_appearance_id ON players
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW.mask_appearance_id IS NOT NULL)
EXECUTE FUNCTION enforce_face_mask_worn_owned();

-- ---------------------------------------------------------------------------
-- Catalog: one row per sellable item. grant_item_id is the equipment definition (weapon/armour)
-- or the inventory item (face_mask / manor_skin) with its variant.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS glimmer_shop_catalog (
  sku text PRIMARY KEY CHECK (length(sku) <= 80 AND sku ~ '^[a-z0-9]+([-_.][a-z0-9]+)*$'),
  kind text NOT NULL CHECK (kind IN ('weapon', 'armour', 'mask', 'manor_skin')),
  grant_item_id text NOT NULL REFERENCES item_definitions(item_id) ON DELETE RESTRICT,
  grant_variant text NOT NULL DEFAULT 'default' CHECK (length(grant_variant) BETWEEN 1 AND 80),
  price_glimmer bigint NOT NULL CHECK (price_glimmer > 0 AND price_glimmer <= 10000000),
  source text NULL CHECK (source IS NULL OR source IN ('craft', 'shop', 'both')),
  featured boolean NOT NULL DEFAULT false,
  on_sale boolean NOT NULL DEFAULT true,
  is_new boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NULL CHECK (updated_by IS NULL OR length(updated_by) BETWEEN 1 AND 160),
  CONSTRAINT glimmer_shop_catalog_grant_unique UNIQUE (grant_item_id, grant_variant),
  CONSTRAINT glimmer_shop_catalog_kind_shape CHECK (
    (kind IN ('weapon', 'armour') AND source IS NOT NULL AND grant_variant = 'default')
    OR (kind = 'mask' AND source IS NULL AND grant_item_id = 'face_mask')
    OR (kind = 'manor_skin' AND source IS NULL AND grant_item_id = 'manor_skin'
        AND grant_variant <> 'manor_lobby')
  )
);

-- One row per admin edit (Developer App -> Shop catalog); operation_key replays.
CREATE TABLE IF NOT EXISTS glimmer_shop_catalog_audit (
  audit_id bigserial PRIMARY KEY,
  operation_key text NOT NULL UNIQUE CHECK (length(operation_key) BETWEEN 1 AND 160),
  sku text NOT NULL REFERENCES glimmer_shop_catalog(sku) ON DELETE RESTRICT,
  actor_player_id text NOT NULL CHECK (length(actor_player_id) BETWEEN 1 AND 160),
  before jsonb NOT NULL,
  after jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Replay record of shop purchases: one row per (account, request id); a replay returns the
-- stored result and never charges again.
CREATE TABLE IF NOT EXISTS glimmer_shop_purchases (
  account_id uuid NOT NULL,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  player_id text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  total_glimmer bigint NOT NULL CHECK (total_glimmer > 0),
  lines jsonb NOT NULL,
  premium_event_id text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, request_id)
);
CREATE INDEX IF NOT EXISTS glimmer_shop_purchases_player_idx
  ON glimmer_shop_purchases (player_id, created_at DESC);

-- Seed: the 24 swag weapons at 1000 (owner picks craft/shop/both per weapon later), the five
-- masks at 1500, Haunted + Samurai manor skins at 2000. The default Timber manor is never sold.
INSERT INTO glimmer_shop_catalog (sku, kind, grant_item_id, grant_variant, price_glimmer, source, featured, is_new, sort_order)
SELECT seed.sku, 'weapon', seed.sku, 'default', 1000, 'both', false, false, seed.sort_order
FROM (VALUES
  ('legion_gladius', 100), ('barrow_blade', 101), ('tidefang_sabre', 102),
  ('troll_cleaver', 110), ('rimebeard_axe', 111), ('packfang_axe', 112),
  ('owlfeather_longbow', 120), ('grovewood_bow', 121), ('steppe_horn_bow', 122),
  ('kappa_shell_crossbow', 130), ('scrap_iron_arbalest', 131), ('stormlatch_crossbow', 132),
  ('merfolk_trident', 140), ('centaur_lance', 141), ('reefspear', 142),
  ('livingwood_staff', 150), ('hexwood_crook', 151), ('pilgrim_staff', 152),
  ('pantherclaw_stars', 160), ('runestar', 161), ('viper_stars', 162),
  ('riverhide_sling', 170), ('steppe_sling', 171), ('nixie_sling', 172)
) AS seed(sku, sort_order)
ON CONFLICT (sku) DO NOTHING;

INSERT INTO glimmer_shop_catalog (sku, kind, grant_item_id, grant_variant, price_glimmer, source, featured, is_new, sort_order)
VALUES
  ('mask_oni', 'mask', 'face_mask', 'mask-1', 1500, NULL, false, true, 200),
  ('mask_rebel', 'mask', 'face_mask', 'mask-2', 1500, NULL, false, true, 201),
  ('mask_calavera', 'mask', 'face_mask', 'mask-3', 1500, NULL, false, true, 202),
  ('mask_hockey', 'mask', 'face_mask', 'hockey-mask', 1500, NULL, false, true, 203),
  ('mask_kitsune', 'mask', 'face_mask', 'kitsune-mask', 1500, NULL, false, true, 204),
  ('manor_skin_haunted', 'manor_skin', 'manor_skin', 'haunted_manor', 2000, NULL, true, false, 300),
  ('manor_skin_samurai', 'manor_skin', 'manor_skin', 'samurai_manor', 2000, NULL, false, false, 301)
ON CONFLICT (sku) DO NOTHING;

-- ---------------------------------------------------------------------------
-- New Glimmer pack amounts / first-purchase bonuses and Atlas Pass prices (owner 2026-10-06).
-- ---------------------------------------------------------------------------
UPDATE premium_products AS product
SET glimmer_amount = next.glimmer_amount,
    first_purchase_bonus_glimmer = next.bonus,
    usd_cents = next.usd_cents
FROM (VALUES
  ('glimmer_pinch', 200::bigint, 200::bigint, 199),
  ('glimmer_handful', 500, 500, 499),
  ('glimmer_pouch', 1050, 1050, 999),
  ('glimmer_satchel', 2150, 0, 1999),
  ('glimmer_chest', 5500, 0, 4999),
  ('glimmer_hoard', 11250, 0, 9999),
  ('atlas_pass_monthly', 0, 0, 1999),
  ('atlas_pass_yearly', 0, 0, 19999)
) AS next(sku, glimmer_amount, bonus, usd_cents)
WHERE product.sku = next.sku
  AND (product.glimmer_amount, product.first_purchase_bonus_glimmer, product.usd_cents)
      IS DISTINCT FROM (next.glimmer_amount, next.bonus, next.usd_cents);
