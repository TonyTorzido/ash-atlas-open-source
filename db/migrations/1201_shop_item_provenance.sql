-- Glimmer Shop provenance tags (docs/design/GLIMMER_SHOP.md, "Provenance tags"): every copy bought
-- from the shop has a permanent random tag and its original buyer (name snapshot at purchase plus
-- player id). copy_id is the equipment instance id (weapons/armour) or the inventory variant of a
-- per-copy item (face_mask / manor_skin, 1202). Rows are never updated or deleted by the game, so
-- the tag and buyer follow that exact copy through every move. Tags are random 40-bit Crockford
-- base32 (`XXXX-XXXX`), unique, and never derived from a counter or time.
CREATE TABLE IF NOT EXISTS shop_item_copies (
  copy_id text PRIMARY KEY
    CHECK (copy_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  item_id text NOT NULL REFERENCES item_definitions(item_id) ON DELETE RESTRICT,
  -- What the copy looks like: the mask appearance id or Manor type; 'default' for equipment.
  look text NOT NULL CHECK (length(look) BETWEEN 1 AND 80),
  tag text NOT NULL UNIQUE CHECK (tag ~ '^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$'),
  original_buyer_player_id text NOT NULL CHECK (length(original_buyer_player_id) BETWEEN 1 AND 160),
  original_buyer_name text NOT NULL CHECK (length(original_buyer_name) BETWEEN 1 AND 80),
  purchase_account_id uuid NULL,
  purchase_request_id text NULL CHECK (purchase_request_id IS NULL OR length(purchase_request_id) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- A fresh random tag (40 bits from the CSPRNG behind gen_random_uuid), for SQL-side conversions.
-- The server generates its own with node:crypto; both retry on the unique constraint.
CREATE OR REPLACE FUNCTION shop_copy_random_tag() RETURNS text
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  bits bigint := ('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))::bit(40)::bigint;
  out text := '';
BEGIN
  FOR position IN 1..8 LOOP
    out := substr(alphabet, (bits & 31)::int + 1, 1) || out;
    bits := bits >> 5;
  END LOOP;
  RETURN substr(out, 1, 4) || '-' || substr(out, 5, 4);
END $$;
