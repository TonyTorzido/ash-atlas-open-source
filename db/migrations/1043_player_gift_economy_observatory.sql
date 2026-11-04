-- Economy Observatory for player gifts (classifier from 0838, inventory
-- projection and holdings view from 0827).
-- * Gift contents move sender -> gift -> recipient: player_gift_send and
--   player_gift_claim are ownership transfers, never creation/destruction,
--   so the inventory projection skips them like market/drop movements.
-- * gift_box_purchase: the Gold debit is a SINK (wallet "purchase" rule) and
--   the box credit is a SOURCE (exact match below); gift_box_consume is a SINK.
-- * Holdings: unopened gift contents remain existing supply in gift_escrow
--   custody (admin packages stay committed/future supply).

CREATE OR REPLACE FUNCTION economy_classify_inventory_source(source_value text)
RETURNS text AS $$
DECLARE source_key text := lower(coalesce(source_value, ''));
BEGIN
  IF source_key = 'gift_box_purchase' THEN
    RETURN 'SOURCE';
  ELSIF source_key ~ '(craft|process|smelt|cook|furnace|tannery|butcher|loom|repair_kit|transform)' THEN
    RETURN 'TRANSFORM';
  ELSIF source_key ~ '(development|dev_|admin|moderation|migration)' THEN
    RETURN 'ADMIN';
  ELSIF source_key ~ '(harvest|reward|starter|spawn|production|grant|overture|replenish|combat|refund)' THEN
    RETURN 'SOURCE';
  ELSIF source_key ~ '(consume|hunger|construction|build|repair|burn|destroy|spend|fee|tax|demolition)' THEN
    RETURN 'SINK';
  END IF;
  RETURN 'UNKNOWN';
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION record_inventory_economy_event()
RETURNS trigger AS $$
DECLARE event_kind_value text := economy_classify_inventory_source(NEW.source);
BEGIN
  -- Market inventory movements are represented by the market double-entry
  -- ledger trigger below. Projecting them here as SOURCE/SINK would count an
  -- ownership transfer as global creation or destruction.
  IF lower(NEW.source) LIKE 'market%'
     OR lower(NEW.source) IN ('drop_item', 'pickup_dropped_item')
     OR lower(NEW.source) IN ('kingdom_donation', 'city_warehouse_donation', 'city_warehouse_bulk_donation')
     OR lower(NEW.source) LIKE 'manor_stack_%'
     OR lower(NEW.source) LIKE 'manor_bulk_%'
     OR lower(NEW.source) IN ('player_gift_send', 'player_gift_claim') THEN
    RETURN NEW;
  END IF;
  INSERT INTO economy_events (
    event_group_id, leg, event_kind, asset_kind, asset_id, item_id, variant,
    quantity, custody_type, custody_id, player_id, source_system, source_id,
    source_operation_key, reason, metadata, occurred_at, coverage_domain
  ) VALUES (
    gen_random_uuid(),
    CASE WHEN NEW.delta_quantity > 0 THEN 'credit' ELSE 'debit' END,
    event_kind_value, 'fungible', NEW.item_id, NEW.item_id, NEW.variant,
    abs(NEW.delta_quantity), 'player_inventory', NEW.player_id, NEW.player_id,
    'inventory_events', NEW.id::text, NEW.operation_key, NEW.source,
    coalesce(NEW.metadata, '{}'::jsonb), NEW.created_at, 'inventory'
  ) ON CONFLICT (source_system, source_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE VIEW economy_current_holdings AS
WITH fungible AS (
  SELECT 'player_controlled_existing_supply'::text AS supply_scope, true AS existing_supply,
         'fungible'::text AS asset_kind, inventory.resource_type AS asset_id,
         inventory.resource_type AS item_id, coalesce(inventory.variant, 'default') AS variant,
         inventory.quantity::bigint AS quantity, 'player_inventory'::text AS custody_type,
         inventory.player_id AS custody_id, inventory.player_id, NULL::text AS organization_type,
         NULL::text AS organization_id
  FROM player_inventory inventory WHERE inventory.quantity > 0
  UNION ALL
  SELECT 'existing_world_supply', true, 'fungible', inventory.resource_type,
         inventory.resource_type, coalesce(inventory.variant, 'default'), inventory.quantity::bigint,
         'player_inventory', inventory.player_id, inventory.player_id, NULL, NULL
  FROM player_inventory inventory WHERE inventory.quantity > 0
  UNION ALL
  SELECT 'player_controlled_existing_supply', true, 'fungible', stack.item_id, stack.item_id,
         stack.variant, stack.quantity, 'manor_storage', stack.manor_id::text, manor.owner_player_id,
         NULL, NULL
  FROM manor_storage_stacks stack JOIN player_manors manor ON manor.id = stack.manor_id
  WHERE stack.quantity > 0
  UNION ALL
  SELECT 'existing_world_supply', true, 'fungible', stack.item_id, stack.item_id,
         stack.variant, stack.quantity, 'manor_storage', stack.manor_id::text, manor.owner_player_id,
         NULL, NULL
  FROM manor_storage_stacks stack JOIN player_manors manor ON manor.id = stack.manor_id
  WHERE stack.quantity > 0
  UNION ALL
  SELECT 'player_controlled_existing_supply', true, 'fungible', overflow.item_id, overflow.item_id,
         overflow.variant, overflow.quantity, 'manor_storage', overflow.manor_id::text, manor.owner_player_id,
         NULL, NULL
  FROM manor_storage_overflow overflow JOIN player_manors manor ON manor.id = overflow.manor_id
  WHERE overflow.quantity > 0
  UNION ALL
  SELECT 'existing_world_supply', true, 'fungible', overflow.item_id, overflow.item_id,
         overflow.variant, overflow.quantity, 'manor_storage', overflow.manor_id::text, manor.owner_player_id,
         NULL, NULL
  FROM manor_storage_overflow overflow JOIN player_manors manor ON manor.id = overflow.manor_id
  WHERE overflow.quantity > 0
  UNION ALL
  SELECT 'organization_existing_supply', true, 'fungible', stack.item_id, stack.item_id,
         stack.variant, stack.quantity, 'city_warehouse', stack.city_id::text, NULL, 'city', stack.city_id::text
  FROM city_warehouse_stacks stack WHERE stack.quantity > 0
  UNION ALL
  SELECT 'existing_world_supply', true, 'fungible', stack.item_id, stack.item_id,
         stack.variant, stack.quantity, 'city_warehouse', stack.city_id::text, NULL, 'city', stack.city_id::text
  FROM city_warehouse_stacks stack WHERE stack.quantity > 0
  UNION ALL
  SELECT 'organization_existing_supply', true, 'fungible', balance.resource_type, balance.resource_type,
         balance.variant, balance.quantity, 'kingdom_treasury', balance.kingdom_id::text, NULL,
         'kingdom', balance.kingdom_id::text
  FROM kingdom_treasury_balances balance WHERE balance.quantity > 0
  UNION ALL
  SELECT 'existing_world_supply', true, 'fungible', balance.resource_type, balance.resource_type,
         balance.variant, balance.quantity, 'kingdom_treasury', balance.kingdom_id::text, NULL,
         'kingdom', balance.kingdom_id::text
  FROM kingdom_treasury_balances balance WHERE balance.quantity > 0
  UNION ALL
  SELECT 'world_available_supply', true, 'fungible', drop_row.item_id, drop_row.item_id,
         drop_row.variant, drop_row.remaining_quantity, 'world_drop', drop_row.id::text, NULL, 'world', NULL
  FROM world_item_drops drop_row
  WHERE drop_row.status = 'active' AND drop_row.remaining_quantity > 0
  UNION ALL
  SELECT 'existing_world_supply', true, 'fungible', drop_row.item_id, drop_row.item_id,
         drop_row.variant, drop_row.remaining_quantity, 'world_drop', drop_row.id::text, NULL, 'world', NULL
  FROM world_item_drops drop_row
  WHERE drop_row.status = 'active' AND drop_row.remaining_quantity > 0
  UNION ALL
  SELECT 'player_controlled_existing_supply', true, 'fungible', 'gold', NULL, 'default', wallet.gold_balance,
         'player_wallet', wallet.player_id, wallet.player_id, NULL, NULL
  FROM player_wallets wallet WHERE wallet.gold_balance > 0
  UNION ALL
  SELECT 'existing_world_supply', true, 'fungible', 'gold', NULL, 'default', wallet.gold_balance,
         'player_wallet', wallet.player_id, wallet.player_id, NULL, NULL
  FROM player_wallets wallet WHERE wallet.gold_balance > 0
  UNION ALL
  SELECT 'organization_existing_supply', true, 'fungible', 'gold', NULL, 'default', reserve.balance,
         'city_gold_reserve', reserve.city_id::text, NULL, 'city', reserve.city_id::text
  FROM city_gold_reserves reserve WHERE reserve.balance > 0
  UNION ALL
  SELECT 'existing_world_supply', true, 'fungible', 'gold', NULL, 'default', reserve.balance,
         'city_gold_reserve', reserve.city_id::text, NULL, 'city', reserve.city_id::text
  FROM city_gold_reserves reserve WHERE reserve.balance > 0
  UNION ALL
  SELECT 'organization_existing_supply', true, 'fungible', 'city_coin', NULL, 'default', treasury.balance,
         'city_treasury', treasury.city_id::text, NULL, 'city', treasury.city_id::text
  FROM city_treasuries treasury WHERE treasury.balance > 0
  UNION ALL
  SELECT 'existing_world_supply', true, 'fungible', 'city_coin', NULL, 'default', treasury.balance,
         'city_treasury', treasury.city_id::text, NULL, 'city', treasury.city_id::text
  FROM city_treasuries treasury WHERE treasury.balance > 0
  UNION ALL
  SELECT 'committed_or_future_supply', true, 'fungible', coalesce(escrow.item_identity, escrow.item_id, 'gold'),
         escrow.item_id, coalesce(escrow.variant, 'default'), escrow.remaining_amount, 'market_escrow',
         escrow.order_id::text, escrow.player_id, NULL, NULL
  FROM market_order_escrows escrow WHERE escrow.remaining_amount > 0
  UNION ALL
  SELECT 'existing_world_supply', true, 'fungible', coalesce(escrow.item_identity, escrow.item_id, 'gold'),
         escrow.item_id, coalesce(escrow.variant, 'default'), escrow.remaining_amount, 'market_escrow',
         escrow.order_id::text, escrow.player_id, NULL, NULL
  FROM market_order_escrows escrow WHERE escrow.remaining_amount > 0
  UNION ALL
  SELECT 'committed_or_future_supply', true, 'fungible', coalesce(collection.item_identity, collection.item_id, 'gold'),
         collection.item_id, coalesce(collection.variant, 'default'), collection.remaining_amount,
         'market_collection', collection.collection_id::text, collection.player_id, NULL, NULL
  FROM market_collections collection WHERE collection.remaining_amount > 0
  UNION ALL
  SELECT 'existing_world_supply', true, 'fungible', coalesce(collection.item_identity, collection.item_id, 'gold'),
         collection.item_id, coalesce(collection.variant, 'default'), collection.remaining_amount,
         'market_collection', collection.collection_id::text, collection.player_id, NULL, NULL
  FROM market_collections collection WHERE collection.remaining_amount > 0
  UNION ALL
  SELECT 'committed_or_future_supply', false, 'fungible', package_item.canonical_item_id,
         package_item.canonical_item_id, coalesce(package_item.variant, 'default'),
         package_item.remaining_quantity, 'external', package_item.package_id::text, package.recipient_player_id,
         NULL, NULL
  FROM player_package_items package_item
  JOIN player_packages package ON package.id = package_item.package_id
  JOIN player_package_campaigns campaign ON campaign.id = package.campaign_id
  WHERE package_item.remaining_quantity > 0 AND campaign.kind = 'admin'
  UNION ALL
  -- Gift fungible contents already existed in the sender's inventory; the
  -- escrowed equipment instances are counted from equipment_instances below.
  SELECT 'existing_world_supply', true, 'fungible', package_item.canonical_item_id,
         package_item.canonical_item_id, coalesce(package_item.variant, 'default'),
         package_item.remaining_quantity, 'gift_escrow', package_item.package_id::text, package.recipient_player_id,
         NULL, NULL
  FROM player_package_items package_item
  JOIN player_packages package ON package.id = package_item.package_id
  JOIN player_package_campaigns campaign ON campaign.id = package.campaign_id
  WHERE package_item.remaining_quantity > 0 AND campaign.kind = 'player_gift'
    AND package_item.item_kind IN ('resource', 'consumable')
  UNION ALL
  SELECT 'committed_or_future_supply', false, 'fungible', job.job_type, NULL, 'default',
         (job.output_quantity - job.collected_quantity)::bigint, 'external', job.job_id::text,
         job.owner_player_id, NULL, NULL
  FROM military_facility_jobs job
  WHERE job.cleared_at IS NULL AND job.output_quantity > job.collected_quantity
), unique_assets AS (
  SELECT 'player_controlled_existing_supply'::text AS supply_scope, true AS existing_supply,
         'unique'::text AS asset_kind, equipment.definition_id AS asset_id, equipment.definition_id AS item_id,
         'unique'::text AS variant, equipment.instance_id AS unique_asset_instance_id,
         1::bigint AS quantity, 'equipment'::text AS custody_type,
         equipment.instance_id::text AS custody_id, equipment.owner_player_id AS player_id,
         NULL::text AS organization_type, NULL::text AS organization_id
  FROM equipment_instances equipment
  WHERE equipment.location IN ('inventory', 'equipped')
  UNION ALL
  SELECT 'player_controlled_existing_supply', true, 'unique', equipment.definition_id, equipment.definition_id,
         'unique', equipment.instance_id, 1::bigint, 'manor_storage', equipment.manor_id::text,
         equipment.owner_player_id, NULL, NULL
  FROM equipment_instances equipment WHERE equipment.location = 'manor_storage'
  UNION ALL
  SELECT 'committed_or_future_supply', true, 'unique', equipment.definition_id, equipment.definition_id,
         'unique', equipment.instance_id, 1::bigint, 'market_escrow', equipment.market_listing_id::text,
         equipment.owner_player_id, NULL, NULL
  FROM equipment_instances equipment WHERE equipment.location = 'market_escrow'
  UNION ALL
  SELECT 'committed_or_future_supply', true, 'unique', equipment.definition_id, equipment.definition_id,
         'unique', equipment.instance_id, 1::bigint, 'market_collection', equipment.market_collection_id::text,
         equipment.owner_player_id, NULL, NULL
  FROM equipment_instances equipment WHERE equipment.location = 'market_collection'
  UNION ALL
  SELECT 'world_available_supply', true, 'unique', equipment.definition_id, equipment.definition_id,
         'unique', equipment.instance_id, 1::bigint, 'world_drop', equipment.instance_id::text,
         NULL, 'world', NULL
  FROM equipment_instances equipment WHERE equipment.location = 'world_drop'
  UNION ALL
  SELECT 'existing_world_supply', true, 'unique', equipment.definition_id, equipment.definition_id,
         'unique', equipment.instance_id, 1::bigint,
         CASE equipment.location
           WHEN 'manor_storage' THEN 'manor_storage'
           WHEN 'market_escrow' THEN 'market_escrow'
           WHEN 'market_collection' THEN 'market_collection'
           WHEN 'world_drop' THEN 'world_drop'
           WHEN 'gift_escrow' THEN 'gift_escrow'
           ELSE 'equipment'
         END,
         CASE equipment.location
           WHEN 'manor_storage' THEN equipment.manor_id::text
           WHEN 'market_escrow' THEN equipment.market_listing_id::text
           WHEN 'market_collection' THEN equipment.market_collection_id::text
           WHEN 'gift_escrow' THEN equipment.gift_package_id::text
           ELSE equipment.instance_id::text
         END,
         CASE WHEN equipment.location = 'world_drop' THEN NULL ELSE equipment.owner_player_id END,
         CASE WHEN equipment.location = 'world_drop' THEN 'world' ELSE NULL END,
         NULL
  FROM equipment_instances equipment WHERE equipment.location <> 'destroyed'
  UNION ALL
  SELECT 'player_controlled_existing_supply', true, 'unique', backpack.definition_id, backpack.definition_id,
         'unique', backpack.instance_id, 1::bigint, 'backpack'::text, backpack.instance_id::text,
         backpack.owner_player_id, NULL, NULL
  FROM player_backpack_instances backpack WHERE backpack.location IN ('inventory', 'equipped')
  UNION ALL
  SELECT 'player_controlled_existing_supply', true, 'unique', backpack.definition_id, backpack.definition_id,
         'unique', backpack.instance_id, 1::bigint, 'manor_storage'::text, backpack.manor_id::text,
         backpack.owner_player_id, NULL, NULL
  FROM player_backpack_instances backpack WHERE backpack.location = 'manor_storage'
  UNION ALL
  SELECT 'existing_world_supply', true, 'unique', backpack.definition_id, backpack.definition_id,
         'unique', backpack.instance_id, 1::bigint,
         CASE WHEN backpack.location = 'manor_storage' THEN 'manor_storage' ELSE 'backpack' END,
         CASE WHEN backpack.location = 'manor_storage' THEN backpack.manor_id::text ELSE backpack.instance_id::text END,
         backpack.owner_player_id, NULL, NULL
  FROM player_backpack_instances backpack WHERE backpack.location <> 'destroyed'
)
SELECT supply_scope, existing_supply, asset_kind, asset_id, item_id, variant, NULL::uuid AS unique_asset_instance_id,
       quantity, custody_type, custody_id, player_id, organization_type, organization_id
FROM fungible
UNION ALL
SELECT supply_scope, existing_supply, asset_kind, asset_id, item_id, variant,
       unique_asset_instance_id, quantity, custody_type, custody_id, player_id,
       organization_type, organization_id
FROM unique_assets;

COMMENT ON VIEW economy_current_holdings IS
  'Read-only V1 custody projection. Existing world supply is the aggregate of current non-future rows; committed/future rows are explicit and never added to it unless they are already existing escrow/collection custody.';
