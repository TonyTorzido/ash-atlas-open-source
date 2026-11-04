-- Fix forward for 1202 (masks and Manor skins as tagged per-copy items). 1202 converted player
-- inventories and stopped on look-variant (old-style) stacks on the ground, in sell escrow, in
-- unclaimed packages and in storage. It did not check three more places that can still hold an
-- old-style stack, and it left open buy orders on the old fungible books. This migration:
--   1. stops with a clear message if an old-style face_mask / manor_skin stack is still in an
--      unclaimed market collection, a kingdom treasury or the Manor storage recovery pile
--      (claiming one would fail the 1202 copy guard; resolve those by hand first);
--   2. leaves open buy orders on the old look books (`face_mask:<look>` / `manor_skin:<look>`)
--      alone on purpose: market order expiry is immutable (0716), no new sell can reach those
--      books (copies are not fungible since 1202), and every order expires within 7 days of its
--      creation, when the server's normal expiry worker refunds the escrowed Gold through the
--      market ledger.
-- Forward-only and idempotent (a rerun finds nothing).
DO $$
DECLARE
  copy_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  collections bigint;
  treasuries bigint;
  overflow bigint;
BEGIN
  SELECT count(*) INTO collections FROM market_collections
  WHERE asset_kind = 'item' AND item_id IN ('face_mask', 'manor_skin')
    AND remaining_amount > 0 AND claimed_at IS NULL AND variant !~ copy_pattern;
  SELECT count(*) INTO treasuries FROM kingdom_treasury_balances
  WHERE resource_type IN ('face_mask', 'manor_skin') AND quantity > 0 AND variant !~ copy_pattern;
  SELECT count(*) INTO overflow FROM manor_storage_overflow
  WHERE item_id IN ('face_mask', 'manor_skin') AND quantity > 0 AND variant !~ copy_pattern;
  IF collections + treasuries + overflow > 0 THEN
    RAISE EXCEPTION '1205: old-style mask/skin stacks remain (market collections %, kingdom treasuries %, Manor storage recovery %); resolve them before converting to tagged copies',
      collections, treasuries, overflow;
  END IF;
END $$;
