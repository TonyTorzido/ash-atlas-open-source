-- Greenhouse buckets are unique carried tools, not stackable resources.  Repair
-- any historical duplicate balances through the same immutable inventory
-- operation/event chain used by runtime debits.
CREATE TEMP TABLE greenhouse_bucket_limit_repair ON COMMIT DROP AS
SELECT entry_id, player_id, resource_type, variant, quantity, version
FROM player_inventory
WHERE resource_type IN ('water_bucket', 'gardening_bucket')
  AND variant = 'default'
  AND quantity > 1;

INSERT INTO inventory_operations (
  operation_key, player_id, source, source_entity_type, source_entity_id, metadata
)
SELECT
  'greenhouse:bucket-limit:migration:0867:' || entry_id::text,
  player_id,
  'greenhouse_bucket_limit_migration',
  'player',
  player_id,
  jsonb_build_object(
    'migration', '0867_greenhouse_bucket_limits',
    'itemId', resource_type,
    'previousQuantity', quantity,
    'retainedQuantity', 1
  )
FROM greenhouse_bucket_limit_repair;

UPDATE player_inventory inventory
SET quantity = 1,
    version = inventory.version + 1,
    updated_at = now()
FROM greenhouse_bucket_limit_repair repair
WHERE inventory.entry_id = repair.entry_id;

INSERT INTO inventory_events (
  operation_key, player_id, item_id, variant, delta_quantity,
  quantity_after, version_after, source, source_entity_type,
  source_entity_id, metadata
)
SELECT
  'greenhouse:bucket-limit:migration:0867:' || entry_id::text,
  player_id,
  resource_type,
  variant,
  1 - quantity,
  1,
  version + 1,
  'greenhouse_bucket_limit_migration',
  'player',
  player_id,
  jsonb_build_object(
    'migration', '0867_greenhouse_bucket_limits',
    'previousQuantity', quantity,
    'retainedQuantity', 1
  )
FROM greenhouse_bucket_limit_repair;
