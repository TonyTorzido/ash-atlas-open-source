-- 0867 was already published to disposable/early feature databases and records
-- any quantities it reduced in immutable inventory events. Restore those
-- historical balances before the acquisition-only one-bucket cap takes effect.
CREATE TEMP TABLE greenhouse_bucket_limit_restore ON COMMIT DROP AS
SELECT
  event.id AS repair_event_id,
  event.player_id,
  event.item_id,
  event.variant,
  ((event.metadata->>'previousQuantity')::bigint - 1) AS restore_quantity,
  event.metadata
FROM inventory_events event
JOIN player_inventory inventory
  ON inventory.player_id = event.player_id
 AND inventory.resource_type = event.item_id
 AND inventory.variant = event.variant
WHERE event.source = 'greenhouse_bucket_limit_migration'
  AND event.operation_key LIKE 'greenhouse:bucket-limit:migration:0867:%'
  AND event.item_id IN ('water_bucket', 'gardening_bucket')
  AND (event.metadata->>'previousQuantity')::bigint > 1;

INSERT INTO inventory_operations (
  operation_key, player_id, source, source_entity_type, source_entity_id, metadata
)
SELECT
  'greenhouse:bucket-limit:restore:0868:' || repair_event_id::text,
  player_id,
  'greenhouse_bucket_limit_restore',
  'player',
  player_id,
  metadata || jsonb_build_object(
    'migration', '0868_greenhouse_bucket_limit_restore',
    'restoredQuantity', restore_quantity
  )
FROM greenhouse_bucket_limit_restore
WHERE restore_quantity > 0
ON CONFLICT (operation_key) DO NOTHING;

WITH updated AS (
  UPDATE player_inventory inventory
  SET quantity = inventory.quantity + restore.restore_quantity,
      version = inventory.version + 1,
      updated_at = now()
  FROM greenhouse_bucket_limit_restore restore
  WHERE restore.restore_quantity > 0
    AND inventory.player_id = restore.player_id
    AND inventory.resource_type = restore.item_id
    AND inventory.variant = restore.variant
  RETURNING
    inventory.player_id,
    inventory.resource_type,
    inventory.variant,
    inventory.quantity,
    inventory.version,
    restore.repair_event_id,
    restore.restore_quantity
)
INSERT INTO inventory_events (
  operation_key, player_id, item_id, variant, delta_quantity,
  quantity_after, version_after, source, source_entity_type,
  source_entity_id, metadata
)
SELECT
  'greenhouse:bucket-limit:restore:0868:' || repair_event_id::text,
  player_id,
  resource_type,
  variant,
  restore_quantity,
  quantity,
  version,
  'greenhouse_bucket_limit_restore',
  'player',
  player_id,
  jsonb_build_object(
    'migration', '0868_greenhouse_bucket_limit_restore',
    'restoredQuantity', restore_quantity
  )
FROM updated;
