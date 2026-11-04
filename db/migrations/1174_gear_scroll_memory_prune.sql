-- Loadout Scrolls: memory is keyed by holder and scroll position, so a scroll that leaves the
-- holder must take its memory with it, or a scroll received later would inherit it. Whenever a
-- player's owned scroll total (carried + Manor storage + market escrow) drops, memory for positions
-- above the new total is deleted in the same transaction. The check is a deferred constraint
-- trigger, so it sees the final holdings at commit: moving a scroll between the backpack, the
-- Manor and a market listing keeps its memory; dropping, trading, gifting or selling it does not.
-- Inner references are schema-qualified (pg_restore search_path). Forward-only and idempotent.

CREATE OR REPLACE FUNCTION public.gear_scroll_owned_total(target_player_id text)
RETURNS bigint
LANGUAGE sql
STABLE
AS $$
  SELECT
    COALESCE((SELECT SUM(inventory.quantity) FROM public.player_inventory inventory
               WHERE inventory.player_id = target_player_id
                 AND inventory.resource_type = 'loadout_scroll'), 0)
    + COALESCE((SELECT SUM(stack.quantity) FROM public.manor_storage_stacks stack
                 JOIN public.player_manors manor ON manor.id = stack.manor_id
                WHERE manor.owner_player_id = target_player_id
                  AND stack.item_id = 'loadout_scroll'), 0)
    + COALESCE((SELECT SUM(overflow.quantity) FROM public.manor_storage_overflow overflow
                 JOIN public.player_manors manor ON manor.id = overflow.manor_id
                WHERE manor.owner_player_id = target_player_id
                  AND overflow.item_id = 'loadout_scroll'), 0)
    + COALESCE((SELECT SUM(escrow.remaining_amount) FROM public.market_order_escrows escrow
                WHERE escrow.player_id = target_player_id
                  AND escrow.asset_kind = 'item'
                  AND escrow.item_id = 'loadout_scroll'), 0)
$$;

CREATE OR REPLACE FUNCTION public.gear_scroll_prune_memory(target_player_id text)
RETURNS void
LANGUAGE sql
AS $$
  DELETE FROM public.player_gear_scroll_memory memory
   WHERE memory.player_id = target_player_id
     AND memory.scroll_position > public.gear_scroll_owned_total(target_player_id)
$$;

CREATE OR REPLACE FUNCTION public.gear_scroll_prune_memory_after_removal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_player_id text;
BEGIN
  IF TG_TABLE_NAME IN ('manor_storage_stacks', 'manor_storage_overflow') THEN
    SELECT manor.owner_player_id INTO target_player_id
      FROM public.player_manors manor WHERE manor.id = OLD.manor_id;
  ELSE
    target_player_id := OLD.player_id;
  END IF;
  IF target_player_id IS NOT NULL THEN
    PERFORM public.gear_scroll_prune_memory(target_player_id);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS gear_scroll_memory_prune_inventory_update ON player_inventory;
CREATE CONSTRAINT TRIGGER gear_scroll_memory_prune_inventory_update
  AFTER UPDATE ON player_inventory
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.resource_type = 'loadout_scroll' AND (NEW.quantity < OLD.quantity OR NEW.player_id <> OLD.player_id))
  EXECUTE FUNCTION public.gear_scroll_prune_memory_after_removal();

DROP TRIGGER IF EXISTS gear_scroll_memory_prune_inventory_delete ON player_inventory;
CREATE CONSTRAINT TRIGGER gear_scroll_memory_prune_inventory_delete
  AFTER DELETE ON player_inventory
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.resource_type = 'loadout_scroll')
  EXECUTE FUNCTION public.gear_scroll_prune_memory_after_removal();

DROP TRIGGER IF EXISTS gear_scroll_memory_prune_manor_update ON manor_storage_stacks;
CREATE CONSTRAINT TRIGGER gear_scroll_memory_prune_manor_update
  AFTER UPDATE ON manor_storage_stacks
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.item_id = 'loadout_scroll' AND (NEW.quantity < OLD.quantity OR NEW.item_id <> OLD.item_id OR NEW.manor_id <> OLD.manor_id))
  EXECUTE FUNCTION public.gear_scroll_prune_memory_after_removal();

DROP TRIGGER IF EXISTS gear_scroll_memory_prune_manor_delete ON manor_storage_stacks;
CREATE CONSTRAINT TRIGGER gear_scroll_memory_prune_manor_delete
  AFTER DELETE ON manor_storage_stacks
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.item_id = 'loadout_scroll')
  EXECUTE FUNCTION public.gear_scroll_prune_memory_after_removal();

DROP TRIGGER IF EXISTS gear_scroll_memory_prune_overflow_update ON manor_storage_overflow;
CREATE CONSTRAINT TRIGGER gear_scroll_memory_prune_overflow_update
  AFTER UPDATE ON manor_storage_overflow
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.item_id = 'loadout_scroll' AND (NEW.quantity < OLD.quantity OR NEW.item_id <> OLD.item_id OR NEW.manor_id <> OLD.manor_id))
  EXECUTE FUNCTION public.gear_scroll_prune_memory_after_removal();

DROP TRIGGER IF EXISTS gear_scroll_memory_prune_overflow_delete ON manor_storage_overflow;
CREATE CONSTRAINT TRIGGER gear_scroll_memory_prune_overflow_delete
  AFTER DELETE ON manor_storage_overflow
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.item_id = 'loadout_scroll')
  EXECUTE FUNCTION public.gear_scroll_prune_memory_after_removal();

DROP TRIGGER IF EXISTS gear_scroll_memory_prune_escrow_update ON market_order_escrows;
CREATE CONSTRAINT TRIGGER gear_scroll_memory_prune_escrow_update
  AFTER UPDATE ON market_order_escrows
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.item_id = 'loadout_scroll' AND NEW.remaining_amount < OLD.remaining_amount)
  EXECUTE FUNCTION public.gear_scroll_prune_memory_after_removal();

DROP TRIGGER IF EXISTS gear_scroll_memory_prune_escrow_delete ON market_order_escrows;
CREATE CONSTRAINT TRIGGER gear_scroll_memory_prune_escrow_delete
  AFTER DELETE ON market_order_escrows
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.item_id = 'loadout_scroll')
  EXECUTE FUNCTION public.gear_scroll_prune_memory_after_removal();

-- Memory already left behind by a scroll that is gone.
DELETE FROM player_gear_scroll_memory memory
 WHERE memory.scroll_position > public.gear_scroll_owned_total(memory.player_id);
