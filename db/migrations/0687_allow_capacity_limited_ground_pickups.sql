-- A pickup may accept less than requested when the inventory has only partial
-- capacity. The service and custody validator preserve the exact remainder.
ALTER TABLE world_item_pickups
  DROP CONSTRAINT IF EXISTS world_item_pickups_intent_result_check;

ALTER TABLE world_item_pickups
  ADD CONSTRAINT world_item_pickups_intent_result_check CHECK (
    (pickup_mode = 'all' AND requested_quantity IS NULL)
    OR
    (
      pickup_mode = 'quantity'
      AND requested_quantity IS NOT NULL
      AND granted_quantity <= requested_quantity
    )
  );
