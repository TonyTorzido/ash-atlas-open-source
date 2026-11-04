-- Optional least-privilege reporting role for Economy Observatory.
-- Run as a database administrator after choosing the target database.
-- This role is intentionally NOLOGIN; bind it to a reporting login through
-- the deployment's existing role policy rather than granting write access.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ash_atlas_economy_observer') THEN
    CREATE ROLE ash_atlas_economy_observer NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO ash_atlas_economy_observer;
GRANT SELECT ON
  economy_events,
  economy_transfer_groups,
  economy_instrumentation_coverage,
  economy_snapshot_runs,
  economy_snapshot_holdings,
  economy_sessions,
  economy_current_holdings,
  item_definitions,
  players,
  player_inventory,
  player_wallets,
  equipment_instances,
  player_backpack_instances,
  manor_storage_stacks,
  manor_storage_overflow,
  city_warehouse_stacks,
  kingdom_treasury_balances,
  city_gold_reserves,
  city_treasuries,
  world_item_drops,
  world_item_movements,
  world_item_system_drop_sources,
  equipment_operations,
  market_order_escrows,
  market_collections,
  player_package_items,
  player_package_campaigns,
  player_gift_equipment_instances,
  player_packages,
  military_facility_jobs,
  accounts,
  inventory_operations,
  inventory_events,
  wallet_events,
  city_coin_ledger,
  city_gold_ledger,
  kingdom_donations,
  city_warehouse_events,
  manor_storage_operations,
  manor_storage_stack_events,
  manor_storage_equipment_events,
  manor_storage_backpack_events,
  market_ledger_entries,
  market_equipment_listings,
  market_equipment_collections,
  market_equipment_gold_collections,
  world_equipment_drops
TO ash_atlas_economy_observer;

COMMENT ON ROLE ash_atlas_economy_observer IS
  'Read-only Economy Observatory reporting role; no authoritative mutation privileges.';
