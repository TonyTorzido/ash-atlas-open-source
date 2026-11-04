-- Fishing Rods are tradable exact instances.  The static catalog identity is
-- used only as the base; live market identities append the rod UUID so the
-- existing order/escrow/ledger model cannot collapse uses or future variant
-- properties into a fungible stack.
UPDATE item_definitions
SET market_tradable = true,
    market_fungible = false,
    market_identity = 'fishing_rod',
    updated_at = clock_timestamp()
WHERE item_id = 'fishing_rod';

COMMENT ON COLUMN fishing_rods.player_id IS
  'Current owner of this durable rod instance. Market transfers update this field in the same transaction as the inventory transfer.';
