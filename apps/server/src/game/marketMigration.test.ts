import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL("../../../../db/migrations/0600_market_exchange_foundation.sql", import.meta.url);
const migration = readFileSync(fileURLToPath(migrationUrl), "utf8");
const hardeningMigrationUrl = new URL(
  "../../../../db/migrations/0601_market_economy_hardening.sql",
  import.meta.url
);
const hardeningMigration = readFileSync(fileURLToPath(hardeningMigrationUrl), "utf8");
const catalogTransitionUrl = new URL(
  "../../../../db/migrations/0717_market_catalog_transition.sql",
  import.meta.url
);
const catalogTransitionMigration = readFileSync(fileURLToPath(catalogTransitionUrl), "utf8");
const migrationsDirectory = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));

function tableSql(table: string): string {
  const match = migration.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`));
  if (!match?.[1]) throw new Error(`Migration does not create ${table}`);
  return match[1];
}

describe("0600 market exchange foundation migration", () => {
  it("keeps the market migration list explicit and numerically ordered", () => {
    const marketMigrations = readdirSync(migrationsDirectory)
      .filter((file) => file.endsWith(".sql") && file.includes("market"))
      .sort();
    expect(marketMigrations).toEqual([
      "0600_market_exchange_foundation.sql",
      "0601_market_economy_hardening.sql",
      "0712_city_district_markets.sql",
      "0716_market_expiration_and_immediate_settlement.sql",
      "0717_market_catalog_transition.sql",
      "0775_enchantment_stone_market.sql",
      "0807_market_expired_gold_claim_validation.sql",
      "0841_fishing_rod_market_instances.sql",
      "0870_goblin_market_wheat_seed.sql",
      "0933_city_market_levels.sql",
      "0936_city_market_daily_package.sql"
    ]);
    expect(marketMigrations.every((file) => /^\d{4}_/.test(file))).toBe(true);
  });

  it("adds commit guards for cumulative escrow, transition chains, and drop custody", () => {
    for (const functionName of [
      "validate_market_order_journal_commit",
      "validate_market_trade_hardening_commit",
      "validate_wallet_event_chain",
      "validate_inventory_event_chain",
      "validate_world_item_drop_commit"
    ]) {
      expect(hardeningMigration).toContain(`CREATE OR REPLACE FUNCTION ${functionName}`);
    }
    for (const triggerName of [
      "market_orders_journal_guard",
      "market_trades_00_hardening_guard",
      "player_wallets_event_chain_guard",
      "player_inventory_event_chain_guard",
      "world_item_drops_commit_guard"
    ]) {
      expect(hardeningMigration).toMatch(
        new RegExp(`CREATE CONSTRAINT TRIGGER ${triggerName}[\\s\\S]*DEFERRABLE INITIALLY DEFERRED`)
      );
    }
    expect(hardeningMigration).toContain("world_item_drop_requests");
    expect(hardeningMigration).toContain("world_item_movements");
    expect(hardeningMigration).toContain("market escrow row does not match cumulative journal net");
    expect(hardeningMigration).toContain("market price-improvement refund is not independently correct");
  });

  it("narrows IOC and records truthful typed fee provenance", () => {
    expect(hardeningMigration).toContain("CHECK (order_policy IN ('gtc', 'aon_ioc'))");
    expect(hardeningMigration).toContain("order_fee_policy_id smallint");
    expect(hardeningMigration).toContain("buyer_fee_policy_id smallint");
    expect(hardeningMigration).toContain("seller_fee_policy_id smallint");
    expect(hardeningMigration).toContain("market_ledger_groups_source_shape_check");
  });

  it.each([
    "player_wallets",
    "wallet_events",
    "market_fee_policies",
    "market_venues",
    "market_global_controls",
    "market_venue_controls",
    "market_player_controls",
    "market_order_books",
    "market_requests",
    "market_orders",
    "market_order_escrows",
    "market_trades",
    "market_collections",
    "market_claims",
    "market_quotes",
    "market_ledger_groups",
    "market_ledger_entries",
    "market_audit_events",
    "market_rate_windows"
  ])("creates the authoritative %s table", (table) => {
    expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
  });

  it("scopes replay protection to the authoritative account and declares each identity once", () => {
    const requests = tableSql("market_requests");
    const orders = tableSql("market_orders");
    const claims = tableSql("market_claims");
    expect(requests.match(/^\s*account_id\b/gm)).toHaveLength(1);
    expect(requests).toContain("PRIMARY KEY (account_id, request_id)");
    expect(requests).toContain("request_hash text NOT NULL CHECK (length(request_hash) = 64)");
    expect(orders.match(/^\s*account_id\b/gm)).toHaveLength(1);
    expect(orders).toContain("UNIQUE (account_id, client_request_id)");
    expect(claims).toContain("UNIQUE (account_id, client_request_id)");
  });

  it("enforces order, escrow, trade, collection, and quote conservation bounds", () => {
    const orders = tableSql("market_orders");
    expect(orders).toContain("limit_unit_price bigint NOT NULL CHECK (limit_unit_price > 0)");
    expect(orders).toContain("original_quantity bigint NOT NULL CHECK (original_quantity > 0)");
    expect(orders).toContain("CHECK (filled_quantity + remaining_quantity = original_quantity)");
    expect(orders).toContain("CHECK ((status = 'filled') = (remaining_quantity = 0))");

    const escrow = tableSql("market_order_escrows");
    expect(escrow).toContain("remaining_amount bigint NOT NULL CHECK (remaining_amount >= 0 AND remaining_amount <= initial_amount)");

    const trades = tableSql("market_trades");
    expect(trades).toContain("CHECK (gross_value::numeric = quantity::numeric * unit_price::numeric)");
    expect(trades).toContain("CHECK (buyer_player_id <> seller_player_id)");
    expect(trades).toContain("CHECK (buyer_fee <= gross_value AND seller_fee <= gross_value)");

    const collections = tableSql("market_collections");
    expect(collections).toContain("remaining_amount bigint NOT NULL CHECK (remaining_amount >= 0 AND remaining_amount <= original_amount)");
    expect(collections).toContain("CHECK ((remaining_amount = 0) = (claimed_at IS NOT NULL))");

    const quotes = tableSql("market_quotes");
    expect(quotes).toContain("CHECK (fillable_quantity <= requested_quantity)");
    expect(quotes).toContain("CHECK ((fillable_quantity = 0) = (maximum_unit_price IS NULL))");
  });

  it("creates durable book serialization and deterministic price-time matching indexes", () => {
    expect(migration).toContain("UNIQUE (venue_id, item_identity)");
    expect(migration).toContain("CREATE SEQUENCE IF NOT EXISTS market_priority_sequence AS bigint");
    expect(migration).toMatch(
      /market_orders_sell_match_idx[\s\S]*book_id, limit_unit_price ASC, priority_sequence ASC[\s\S]*side = 'sell'/
    );
    expect(migration).toMatch(
      /market_orders_buy_match_idx[\s\S]*book_id, limit_unit_price DESC, priority_sequence ASC[\s\S]*side = 'buy'/
    );
    for (const index of [
      "market_orders_player_open_idx",
      "market_orders_player_history_idx",
      "market_orders_book_open_idx",
      "market_order_escrows_reconcile_idx",
      "market_trades_book_recent_idx",
      "market_collections_player_open_idx",
      "market_ledger_entries_group_idx",
      "market_audit_events_scope_idx",
      "market_rate_windows_cleanup_idx"
    ]) {
      expect(migration).toContain(index);
    }
  });

  it("makes committed trades and journal rows immutable and guards order transitions", () => {
    expect(migration).toContain("CREATE OR REPLACE FUNCTION reject_market_immutable_mutation()");
    for (const trigger of [
      "market_trades_immutable",
      "market_ledger_groups_immutable",
      "market_ledger_entries_immutable"
    ]) {
      expect(migration).toMatch(new RegExp(`CREATE TRIGGER ${trigger}\\s+BEFORE UPDATE OR DELETE`));
    }
    expect(migration).toContain("CREATE OR REPLACE FUNCTION enforce_market_order_transition()");
    expect(migration).toContain("market order fill progress cannot move backward");
    expect(migration).toContain("closed market order cannot transition");
    expect(migration).toMatch(/CREATE TRIGGER market_orders_transition_guard\s+BEFORE UPDATE ON market_orders/);
  });

  it("guards append-only boundaries and validates composed settlements at commit", () => {
    for (const trigger of [
      "inventory_events_immutable",
      "market_orders_delete_guard",
      "market_order_escrows_delete_guard",
      "market_collections_delete_guard"
    ]) expect(migration).toContain(`CREATE TRIGGER ${trigger}`);
    expect(migration).toContain("market escrow remaining amount cannot increase");
    expect(migration).toContain("market collection remaining amount cannot increase");
    expect(migration).toContain("closed market order is immutable");
    expect(migration).toMatch(
      /CREATE CONSTRAINT TRIGGER market_requests_commit_result_guard[\s\S]*DEFERRABLE INITIALLY DEFERRED/
    );
    for (const validator of [
      "validate_market_order_commit",
      "validate_market_trade_commit",
      "validate_market_collection_commit",
      "validate_market_claim_commit"
    ]) expect(migration).toContain(`CREATE OR REPLACE FUNCTION ${validator}`);
    for (const constraint of [
      "market_order_books_full_identity_unique",
      "market_orders_book_identity_fk",
      "market_trades_buy_order_identity_fk",
      "market_trades_sell_order_identity_fk"
    ]) expect(migration).toContain(constraint);
    for (const index of [
      "market_ledger_groups_order_escrow_unique_idx",
      "market_ledger_groups_trade_unique_idx",
      "market_ledger_groups_cancel_unique_idx",
      "market_ledger_groups_claim_unique_idx",
      "market_ledger_groups_request_idx"
    ]) expect(migration).toContain(index);
    const ledgerGroups = tableSql("market_ledger_groups");
    expect(ledgerGroups).toContain(
      "claim_id uuid NULL REFERENCES market_claims(claim_id) ON DELETE RESTRICT"
    );
    expect(ledgerGroups).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(ledgerGroups).toContain("market_ledger_groups_claim_shape_check");
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION validate_market_ledger_group_collections(target_ledger_group_id uuid)"
    );
    expect(migration).toContain(
      "PERFORM validate_market_ledger_group_collections(NEW.ledger_group_id)"
    );
    expect(migration).toMatch(
      /CREATE CONSTRAINT TRIGGER market_ledger_entries_relationship_guard[\s\S]*DEFERRABLE INITIALLY DEFERRED/
    );
  });

  it("uses integer economic storage, restrictive history foreign keys, and zero development fees", () => {
    const schemaWithoutComments = migration.replace(/--.*$/gm, "");
    expect(schemaWithoutComments).not.toMatch(/\b(?:money|real|double precision)\b/i);
    expect(migration).not.toContain("ON DELETE CASCADE");
    expect(migration).toContain("buyer_fee_bps integer NOT NULL DEFAULT 0 CHECK (buyer_fee_bps BETWEEN 0 AND 10000)");
    expect(migration).toContain("seller_fee_bps integer NOT NULL DEFAULT 0 CHECK (seller_fee_bps BETWEEN 0 AND 10000)");
    expect(migration).toContain("VALUES (1, 1, 0, 0, 0, 0, true)");
    expect(migration).toContain("'Ash Atlas Global Exchange'");
    expect(migration).toContain("'global_test'");
  });

  it("snapshots both sides of each trade and makes fee economic terms immutable", () => {
    const trades = tableSql("market_trades");
    for (const column of [
      "buyer_fee_policy_id smallint NOT NULL",
      "buyer_fee_policy_version integer NOT NULL",
      "seller_fee_policy_id smallint NOT NULL",
      "seller_fee_policy_version integer NOT NULL"
    ]) expect(trades).toContain(column);
    expect(trades).toMatch(
      /FOREIGN KEY \(buyer_fee_policy_id, buyer_fee_policy_version\)[\s\S]*REFERENCES market_fee_policies\(fee_policy_id, version\)/
    );
    expect(trades).toMatch(
      /FOREIGN KEY \(seller_fee_policy_id, seller_fee_policy_version\)[\s\S]*REFERENCES market_fee_policies\(fee_policy_id, version\)/
    );
    expect(migration).toContain("CREATE OR REPLACE FUNCTION enforce_market_fee_policy_immutability()");
    expect(migration).toMatch(
      /CREATE TRIGGER market_fee_policies_immutable_terms\s+BEFORE UPDATE OR DELETE ON market_fee_policies/
    );
  });
});

describe("0717 market catalog transition migration", () => {
  it("removes Food and Ore from new market eligibility without deleting their records", () => {
    expect(catalogTransitionMigration).toContain("WHERE item_id IN ('food', 'ore')");
    expect(catalogTransitionMigration).toContain("market_tradable = false");
    expect(catalogTransitionMigration).toContain("market_fungible = false");
    expect(catalogTransitionMigration).toContain("market_identity = NULL");
    expect(catalogTransitionMigration).not.toMatch(/DELETE\s+FROM\s+(item_definitions|market_orders|market_order_escrows)/i);
  });

  it("documents the durable-order transition needed to preserve existing escrow", () => {
    expect(catalogTransitionMigration).toContain("Existing orders keep their durable identity");
    expect(catalogTransitionMigration).toContain("existing cancellation path");
  });
});
