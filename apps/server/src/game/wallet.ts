import type pg from "pg";

export type WalletQueryable = Pick<pg.PoolClient, "query">;

export type WalletOperationInput = {
  playerId: string;
  accountId: string;
  amount: bigint;
  operationKey: string;
  reason: string;
  marketOrderId?: string | null;
  marketTradeId?: string | null;
  metadata?: Readonly<Record<string, unknown>>;
};

export type WalletOperationResult = {
  applied: boolean;
  goldBalance: bigint;
  version: bigint;
};

export type WalletSnapshot = {
  playerId: string;
  gold: string;
  revision: string;
};

export type WalletOperationErrorCode =
  | "WALLET_INVALID_OPERATION"
  | "WALLET_OWNERSHIP_INVALID"
  | "WALLET_INSUFFICIENT_FUNDS"
  | "WALLET_OVERFLOW"
  | "WALLET_IDEMPOTENCY_CONFLICT"
  | "WALLET_INVARIANT_FAILURE";

export class WalletOperationError extends Error {
  constructor(
    readonly code: WalletOperationErrorCode,
    message: string
  ) {
    super(message);
    this.name = "WalletOperationError";
  }
}

type WalletRow = {
  gold_balance: string;
  version: string;
};

type WalletEventRow = {
  account_id: string;
  delta_gold: string;
  balance_after: string;
  version_after: string;
  reason: string;
  market_order_id: string | null;
  market_trade_id: string | null;
};

type NormalizedWalletOperation = Required<WalletOperationInput>;

type OperationDirection = "credit" | "debit";

const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
const MAX_OPERATION_TEXT_LENGTH = 240;

/**
 * Applies wallet transitions inside a transaction owned by the caller.
 *
 * Every player wallet is locked before replay inspection and mutation, so the
 * balance, monotonic version, and immutable event remain one serialized state
 * transition across server processes.
 */
export class WalletService {
  constructor(private readonly pool?: pg.Pool) {}

  async snapshot(playerId: string, accountId: string): Promise<WalletSnapshot> {
    if (!this.pool) {
      throw new WalletOperationError(
        "WALLET_INVARIANT_FAILURE",
        "Wallet snapshot requires a database pool"
      );
    }
    const client = await this.pool.connect();
    try {
      return await this.snapshotInTransaction(client, playerId, accountId);
    } finally {
      client.release();
    }
  }

  async snapshotInTransaction(
    queryable: WalletQueryable,
    playerId: string,
    accountId: string
  ): Promise<WalletSnapshot> {
    await ensureZeroWallet(queryable, { playerId, accountId });
    const result = await queryable.query<WalletRow>(
      `SELECT gold_balance::text, version::text
       FROM player_wallets
       WHERE player_id = $1 AND account_id = $2`,
      [playerId, accountId]
    );
    const wallet = result.rows[0];
    if (!wallet) {
      throw new WalletOperationError(
        "WALLET_OWNERSHIP_INVALID",
        "Authoritative wallet ownership is invalid"
      );
    }
    return {
      playerId,
      gold: wallet.gold_balance,
      revision: wallet.version
    };
  }

  async debitForOperationInTransaction(
    queryable: WalletQueryable,
    input: WalletOperationInput
  ): Promise<WalletOperationResult> {
    return applyOperation(queryable, normalizeOperation(input), "debit");
  }

  async creditForOperationInTransaction(
    queryable: WalletQueryable,
    input: WalletOperationInput
  ): Promise<WalletOperationResult> {
    return applyOperation(queryable, normalizeOperation(input), "credit");
  }
}

async function applyOperation(
  queryable: WalletQueryable,
  input: NormalizedWalletOperation,
  direction: OperationDirection
): Promise<WalletOperationResult> {
  await ensureZeroWallet(queryable, input);
  const wallet = await lockWallet(queryable, input);
  const signedAmount = direction === "debit" ? -input.amount : input.amount;
  const replay = await findOperationEvent(queryable, input);
  if (replay) {
    assertSameIntent(replay, input, signedAmount);
    assertReplayCompatibleWithWallet(replay, wallet);
    return {
      applied: false,
      goldBalance: BigInt(replay.balance_after),
      version: BigInt(replay.version_after)
    };
  }

  const balanceBefore = BigInt(wallet.gold_balance);
  const versionBefore = BigInt(wallet.version);
  if (versionBefore >= POSTGRES_BIGINT_MAX) {
    throw new WalletOperationError("WALLET_OVERFLOW", "Wallet version cannot be incremented");
  }

  let updated: WalletRow;
  if (direction === "debit") {
    if (balanceBefore < input.amount) {
      throw new WalletOperationError(
        "WALLET_INSUFFICIENT_FUNDS",
        "Wallet does not contain enough gold"
      );
    }
    updated = await debitLockedWallet(queryable, input, versionBefore);
  } else {
    if (balanceBefore > POSTGRES_BIGINT_MAX - input.amount) {
      throw new WalletOperationError("WALLET_OVERFLOW", "Wallet credit exceeds PostgreSQL bigint");
    }
    updated = await creditLockedWallet(queryable, input, balanceBefore, versionBefore);
  }

  const expectedBalance = direction === "debit"
    ? balanceBefore - input.amount
    : balanceBefore + input.amount;
  const expectedVersion = versionBefore + 1n;
  if (
    BigInt(updated.gold_balance) !== expectedBalance ||
    BigInt(updated.version) !== expectedVersion
  ) {
    throw new WalletOperationError(
      "WALLET_INVARIANT_FAILURE",
      "Wallet transition returned an unexpected balance or version"
    );
  }

  await queryable.query(
    `INSERT INTO wallet_events (
       operation_key, player_id, account_id, delta_gold, balance_after,
       version_after, reason, market_order_id, market_trade_id, metadata
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
    [
      input.operationKey,
      input.playerId,
      input.accountId,
      signedAmount.toString(),
      expectedBalance.toString(),
      expectedVersion.toString(),
      input.reason,
      input.marketOrderId,
      input.marketTradeId,
      JSON.stringify(input.metadata)
    ]
  );

  return {
    applied: true,
    goldBalance: expectedBalance,
    version: expectedVersion
  };
}

async function ensureZeroWallet(
  queryable: WalletQueryable,
  input: Pick<WalletOperationInput, "playerId" | "accountId">
): Promise<void> {
  await queryable.query(
    `INSERT INTO player_wallets (player_id, account_id, gold_balance, version)
     SELECT id, account_id, 0, 0
     FROM players
     WHERE id = $1 AND account_id = $2
     ON CONFLICT (player_id) DO NOTHING`,
    [input.playerId, input.accountId]
  );
}

async function lockWallet(
  queryable: WalletQueryable,
  input: NormalizedWalletOperation
): Promise<WalletRow> {
  const result = await queryable.query<WalletRow>(
    `SELECT gold_balance::text, version::text
     FROM player_wallets
     WHERE player_id = $1 AND account_id = $2
     FOR UPDATE`,
    [input.playerId, input.accountId]
  );
  const wallet = result.rows[0];
  if (!wallet) {
    throw new WalletOperationError(
      "WALLET_OWNERSHIP_INVALID",
      "Authoritative wallet ownership is invalid"
    );
  }
  return wallet;
}

async function findOperationEvent(
  queryable: WalletQueryable,
  input: NormalizedWalletOperation
): Promise<WalletEventRow | null> {
  const result = await queryable.query<WalletEventRow>(
    `SELECT account_id, delta_gold::text, balance_after::text, version_after::text,
            reason, market_order_id, market_trade_id
     FROM wallet_events
     WHERE operation_key = $1 AND player_id = $2`,
    [input.operationKey, input.playerId]
  );
  return result.rows[0] ?? null;
}

async function debitLockedWallet(
  queryable: WalletQueryable,
  input: NormalizedWalletOperation,
  versionBefore: bigint
): Promise<WalletRow> {
  const result = await queryable.query<WalletRow>(
    `UPDATE player_wallets
     SET gold_balance = gold_balance - $3::bigint,
         version = version + 1
     WHERE player_id = $1 AND account_id = $2
       AND gold_balance >= $3::bigint
       AND version = $4::bigint
     RETURNING gold_balance::text, version::text`,
    [input.playerId, input.accountId, input.amount.toString(), versionBefore.toString()]
  );
  const updated = result.rows[0];
  if (!updated) {
    throw new WalletOperationError(
      "WALLET_INVARIANT_FAILURE",
      "Locked wallet debit did not update exactly one row"
    );
  }
  return updated;
}

async function creditLockedWallet(
  queryable: WalletQueryable,
  input: NormalizedWalletOperation,
  balanceBefore: bigint,
  versionBefore: bigint
): Promise<WalletRow> {
  const balanceAfter = balanceBefore + input.amount;
  const versionAfter = versionBefore + 1n;
  const result = await queryable.query<WalletRow>(
    `UPDATE player_wallets
     SET gold_balance = $3::bigint,
         version = $4::bigint
     WHERE player_id = $1 AND account_id = $2
       AND version = $5::bigint
     RETURNING gold_balance::text, version::text`,
    [
      input.playerId,
      input.accountId,
      balanceAfter.toString(),
      versionAfter.toString(),
      versionBefore.toString()
    ]
  );
  const updated = result.rows[0];
  if (!updated) {
    throw new WalletOperationError(
      "WALLET_INVARIANT_FAILURE",
      "Locked wallet credit did not update exactly one row"
    );
  }
  return updated;
}

function assertSameIntent(
  event: WalletEventRow,
  input: NormalizedWalletOperation,
  signedAmount: bigint
): void {
  if (
    event.account_id !== input.accountId ||
    BigInt(event.delta_gold) !== signedAmount ||
    event.reason !== input.reason ||
    event.market_order_id !== input.marketOrderId ||
    event.market_trade_id !== input.marketTradeId
  ) {
    throw new WalletOperationError(
      "WALLET_IDEMPOTENCY_CONFLICT",
      "Wallet operation key was reused with different intent"
    );
  }
}

function assertReplayCompatibleWithWallet(event: WalletEventRow, wallet: WalletRow): void {
  const eventVersion = BigInt(event.version_after);
  const walletVersion = BigInt(wallet.version);
  if (
    eventVersion > walletVersion ||
    (eventVersion === walletVersion && BigInt(event.balance_after) !== BigInt(wallet.gold_balance))
  ) {
    throw new WalletOperationError(
      "WALLET_INVARIANT_FAILURE",
      "Wallet replay event is inconsistent with the authoritative wallet"
    );
  }
}

function normalizeOperation(input: WalletOperationInput): NormalizedWalletOperation {
  if (!input.playerId || !input.accountId) {
    throw new WalletOperationError(
      "WALLET_INVALID_OPERATION",
      "Wallet operation player and account are required"
    );
  }
  if (
    !input.operationKey ||
    input.operationKey.length > MAX_OPERATION_TEXT_LENGTH ||
    !input.reason ||
    input.reason.length > MAX_OPERATION_TEXT_LENGTH
  ) {
    throw new WalletOperationError(
      "WALLET_INVALID_OPERATION",
      "Wallet operation key and reason are required and must be at most 240 characters"
    );
  }
  if (typeof input.amount !== "bigint" || input.amount <= 0n || input.amount > POSTGRES_BIGINT_MAX) {
    throw new WalletOperationError(
      "WALLET_INVALID_OPERATION",
      "Wallet operation amount must be a positive PostgreSQL bigint"
    );
  }
  return {
    ...input,
    marketOrderId: input.marketOrderId ?? null,
    marketTradeId: input.marketTradeId ?? null,
    metadata: input.metadata ?? {}
  };
}
