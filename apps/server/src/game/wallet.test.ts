import { describe, expect, it } from "vitest";

import {
  WalletService,
  type WalletQueryable
} from "./wallet.js";

const playerId = "wallet-player";
const accountId = "00000000-0000-4000-8000-000000000901";

describe("WalletService", () => {
  it("reads the authoritative bootstrap balance and revision without a wallet mutation", async () => {
    const database = fakeWalletDatabase({ balance: 321n, version: 7n });

    await expect(
      new WalletService().snapshotInTransaction(database.queryable, playerId, accountId)
    ).resolves.toEqual({
      playerId,
      gold: "321",
      revision: "7"
    });
    expect(database.state.wallet).toEqual({ balance: 321n, version: 7n });
    expect(database.state.events).toEqual([]);
  });

  it("debits exactly once and durably replays the original committed result", async () => {
    const database = fakeWalletDatabase({ balance: 10n, version: 2n });
    const service = new WalletService();
    const input = {
      playerId,
      accountId,
      amount: 4n,
      operationKey: "wallet-debit-001",
      reason: "market_buy_escrow",
      marketOrderId: "00000000-0000-4000-8000-000000000902"
    };

    await expect(service.debitForOperationInTransaction(database.queryable, input)).resolves.toEqual({
      applied: true,
      goldBalance: 6n,
      version: 3n
    });
    expect(database.state.events).toHaveLength(1);
    expect(database.state.events[0]).toMatchObject({
      deltaGold: -4n,
      balanceAfter: 6n,
      versionAfter: 3n,
      marketOrderId: input.marketOrderId
    });

    // A later wallet transition must not change the result returned for a lost-response replay.
    database.state.wallet = { balance: 11n, version: 4n };
    await expect(service.debitForOperationInTransaction(database.queryable, input)).resolves.toEqual({
      applied: false,
      goldBalance: 6n,
      version: 3n
    });
    expect(database.state.events).toHaveLength(1);
    expect(database.state.wallet).toEqual({ balance: 11n, version: 4n });
  });

  it("rejects replay keys reused with different economic intent", async () => {
    const database = fakeWalletDatabase({ balance: 10n, version: 0n });
    const service = new WalletService();
    const base = {
      playerId,
      accountId,
      amount: 2n,
      operationKey: "wallet-conflict-001",
      reason: "market_buy_escrow"
    };
    await service.debitForOperationInTransaction(database.queryable, base);

    await expect(service.debitForOperationInTransaction(database.queryable, {
      ...base,
      amount: 3n
    })).rejects.toMatchObject({
      code: "WALLET_IDEMPOTENCY_CONFLICT"
    });
    expect(database.state.events).toHaveLength(1);
    expect(database.state.wallet).toEqual({ balance: 8n, version: 1n });
  });

  it("conditionally rejects an exact debit that exceeds the locked balance", async () => {
    const database = fakeWalletDatabase({ balance: 3n, version: 7n });
    const service = new WalletService();

    await expect(service.debitForOperationInTransaction(database.queryable, {
      playerId,
      accountId,
      amount: 4n,
      operationKey: "wallet-insufficient-001",
      reason: "market_buy_escrow"
    })).rejects.toMatchObject({
      code: "WALLET_INSUFFICIENT_FUNDS"
    });
    expect(database.state.wallet).toEqual({ balance: 3n, version: 7n });
    expect(database.state.events).toEqual([]);
  });

  it("creates an authoritative zero wallet before the first credit", async () => {
    const database = fakeWalletDatabase(null);
    const service = new WalletService();

    await expect(service.creditForOperationInTransaction(database.queryable, {
      playerId,
      accountId,
      amount: 5n,
      operationKey: "wallet-credit-001",
      reason: "market_collection_claim",
      marketTradeId: "00000000-0000-4000-8000-000000000903"
    })).resolves.toEqual({ applied: true, goldBalance: 5n, version: 1n });
    expect(database.state.wallet).toEqual({ balance: 5n, version: 1n });
    expect(database.state.events[0]).toMatchObject({
      deltaGold: 5n,
      balanceAfter: 5n,
      versionAfter: 1n
    });
  });

  it("rejects a credit before PostgreSQL bigint overflow", async () => {
    const maximum = 9_223_372_036_854_775_807n;
    const database = fakeWalletDatabase({ balance: maximum, version: 1n });
    const service = new WalletService();

    await expect(service.creditForOperationInTransaction(database.queryable, {
      playerId,
      accountId,
      amount: 1n,
      operationKey: "wallet-overflow-001",
      reason: "market_collection_claim"
    })).rejects.toMatchObject({ code: "WALLET_OVERFLOW" });
    expect(database.state.wallet).toEqual({ balance: maximum, version: 1n });
    expect(database.state.events).toEqual([]);
  });
});

type FakeWallet = { balance: bigint; version: bigint };

type FakeEvent = {
  operationKey: string;
  playerId: string;
  accountId: string;
  deltaGold: bigint;
  balanceAfter: bigint;
  versionAfter: bigint;
  reason: string;
  marketOrderId: string | null;
  marketTradeId: string | null;
};

function fakeWalletDatabase(initialWallet: FakeWallet | null): {
  queryable: WalletQueryable;
  state: { wallet: FakeWallet | null; events: FakeEvent[] };
} {
  const state: { wallet: FakeWallet | null; events: FakeEvent[] } = {
    wallet: initialWallet,
    events: []
  };
  const query = async (sql: string, values: unknown[] = []) => {
    if (sql.startsWith("INSERT INTO player_wallets")) {
      state.wallet ??= { balance: 0n, version: 0n };
      return result([]);
    }
    if (sql.startsWith("SELECT gold_balance::text, version::text")) {
      return result(state.wallet ? [{
        gold_balance: state.wallet.balance.toString(),
        version: state.wallet.version.toString()
      }] : []);
    }
    if (sql.startsWith("SELECT account_id, delta_gold::text")) {
      const event = state.events.find(
        (candidate) => candidate.operationKey === values[0] && candidate.playerId === values[1]
      );
      return result(event ? [{
        account_id: event.accountId,
        delta_gold: event.deltaGold.toString(),
        balance_after: event.balanceAfter.toString(),
        version_after: event.versionAfter.toString(),
        reason: event.reason,
        market_order_id: event.marketOrderId,
        market_trade_id: event.marketTradeId
      }] : []);
    }
    if (sql.startsWith("UPDATE player_wallets") && sql.includes("gold_balance -")) {
      const amount = BigInt(String(values[2]));
      const expectedVersion = BigInt(String(values[3]));
      if (!state.wallet || state.wallet.balance < amount || state.wallet.version !== expectedVersion) {
        return result([]);
      }
      state.wallet = { balance: state.wallet.balance - amount, version: state.wallet.version + 1n };
      return result([{
        gold_balance: state.wallet.balance.toString(),
        version: state.wallet.version.toString()
      }]);
    }
    if (sql.startsWith("UPDATE player_wallets") && sql.includes("gold_balance = $3::bigint")) {
      const expectedVersion = BigInt(String(values[4]));
      if (!state.wallet || state.wallet.version !== expectedVersion) return result([]);
      state.wallet = { balance: BigInt(String(values[2])), version: BigInt(String(values[3])) };
      return result([{
        gold_balance: state.wallet.balance.toString(),
        version: state.wallet.version.toString()
      }]);
    }
    if (sql.startsWith("INSERT INTO wallet_events")) {
      state.events.push({
        operationKey: String(values[0]),
        playerId: String(values[1]),
        accountId: String(values[2]),
        deltaGold: BigInt(String(values[3])),
        balanceAfter: BigInt(String(values[4])),
        versionAfter: BigInt(String(values[5])),
        reason: String(values[6]),
        marketOrderId: values[7] === null ? null : String(values[7]),
        marketTradeId: values[8] === null ? null : String(values[8])
      });
      return result([]);
    }
    throw new Error(`Unhandled wallet test query: ${sql}`);
  };
  return {
    queryable: { query: query as WalletQueryable["query"] },
    state
  };
}

function result<T>(rows: T[]) {
  return {
    command: "",
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows
  };
}
