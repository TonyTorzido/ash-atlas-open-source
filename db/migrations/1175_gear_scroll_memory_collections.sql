-- Loadout Scrolls, follow-up to 1174. A scroll on an expired or cancelled market listing goes
-- back to the seller through market_collections until claimed, so it still belongs to them: the
-- owned total now counts unclaimed item collections, and memory is kept until the claim.
-- The Manor storage tables are audit history since 0854 (writes are rejected; items live in the
-- recovery pile on the ground), so they no longer count and their prune triggers are removed.
-- Adds the player index the escrow term needs so a prune never scans every historical order.
-- Inner references are schema-qualified (pg_restore search_path). Forward-only and idempotent.

CREATE INDEX IF NOT EXISTS market_order_escrows_open_item_player_idx
  ON market_order_escrows (player_id, item_id)
  WHERE asset_kind = 'item' AND remaining_amount > 0;

-- The collections term filters remaining_amount > 0 so it uses market_collections_player_open_idx
-- (player_id, asset_kind, collection_id) WHERE remaining_amount > 0 from 0600.
CREATE OR REPLACE FUNCTION public.gear_scroll_owned_total(target_player_id text)
RETURNS bigint
LANGUAGE sql
STABLE
AS $$
  SELECT
    COALESCE((SELECT SUM(inventory.quantity) FROM public.player_inventory inventory
               WHERE inventory.player_id = target_player_id
                 AND inventory.resource_type = 'loadout_scroll'), 0)
    + COALESCE((SELECT SUM(escrow.remaining_amount) FROM public.market_order_escrows escrow
                WHERE escrow.player_id = target_player_id
                  AND escrow.asset_kind = 'item'
                  AND escrow.remaining_amount > 0
                  AND escrow.item_id = 'loadout_scroll'), 0)
    + COALESCE((SELECT SUM(collection.remaining_amount) FROM public.market_collections collection
                WHERE collection.player_id = target_player_id
                  AND collection.asset_kind = 'item'
                  AND collection.remaining_amount > 0
                  AND collection.claimed_at IS NULL
                  AND collection.item_id = 'loadout_scroll'), 0)
$$;

DROP TRIGGER IF EXISTS gear_scroll_memory_prune_manor_update ON manor_storage_stacks;
DROP TRIGGER IF EXISTS gear_scroll_memory_prune_manor_delete ON manor_storage_stacks;
DROP TRIGGER IF EXISTS gear_scroll_memory_prune_overflow_update ON manor_storage_overflow;
DROP TRIGGER IF EXISTS gear_scroll_memory_prune_overflow_delete ON manor_storage_overflow;

-- A collection that shrinks without a claim into the backpack (or is marked claimed) is checked too.
DROP TRIGGER IF EXISTS gear_scroll_memory_prune_collection_update ON market_collections;
CREATE CONSTRAINT TRIGGER gear_scroll_memory_prune_collection_update
  AFTER UPDATE ON market_collections
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.item_id = 'loadout_scroll'
    AND (NEW.remaining_amount < OLD.remaining_amount OR (OLD.claimed_at IS NULL AND NEW.claimed_at IS NOT NULL)))
  EXECUTE FUNCTION public.gear_scroll_prune_memory_after_removal();

DROP TRIGGER IF EXISTS gear_scroll_memory_prune_collection_delete ON market_collections;
CREATE CONSTRAINT TRIGGER gear_scroll_memory_prune_collection_delete
  AFTER DELETE ON market_collections
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.item_id = 'loadout_scroll')
  EXECUTE FUNCTION public.gear_scroll_prune_memory_after_removal();
