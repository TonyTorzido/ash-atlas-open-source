import {
  PREMIUM_CURRENCIES,
  type PremiumCurrency,
  type PremiumCurrencyBalance,
  type PremiumWalletSnapshot
} from "@ash-atlas/shared";
import type pg from "pg";

export type PremiumWalletQueryable = Pick<pg.PoolClient, "query">;

/**
 * Ledger reasons admitted by the database. `admin` is the only free credit
 * reason: there are no free sources of premium currency. `spend` may only
 * debit. `market` moves currency through the exchange: escrow debits, and
 * credits that the database ties to one filled trade or returned escrow (0917).
 * `purchase` credits exactly one granted store purchase and `refund_clawback`
 * debits it back, possibly into arrears (0990).
 */
export type PremiumWalletReason = "admin" | "spend" | "market" | "purchase" | "refund_clawback";
const PREMIUM_WALLET_REASONS: ReadonlySet<string> = new Set<PremiumWalletReason>([
  "admin", "spend", "market", "purchase", "refund_clawback"
]);

export type PremiumWalletOperationInput = {
  accountId: string;
  currency: PremiumCurrency;
  amount: bigint;
  operationKey: string;
  reason: PremiumWalletReason;
  /** Player acting for the account, verified against players(id, account_id). */
  actorPlayerId?: string | null;
  refType?: string | null;
  refId?: string | null;
  metadata?: Readonly<Record<string, unknown>>;
};

export type PremiumWalletOperationResult = {
  applied: boolean;
  currency: PremiumCurrency;
  balance: bigint;
  version: bigint;
  /** Ledger event of this operation (the original one on replay). */
  eventId: string;
};

export type PremiumWalletOperationErrorCode =
  | "PREMIUM_WALLET_INVALID_OPERATION"
  | "PREMIUM_WALLET_OWNERSHIP_INVALID"
  | "PREMIUM_WALLET_INSUFFICIENT_FUNDS"
  | "PREMIUM_WALLET_OVERFLOW"
  | "PREMIUM_WALLET_IDEMPOTENCY_CONFLICT"
  | "PREMIUM_WALLET_INVARIANT_FAILURE";

export class PremiumWalletOperationError extends Error {
  constructor(
    readonly code: PremiumWalletOperationErrorCode,
    message: string
  ) {
    super(message);
    this.name = "PremiumWalletOperationError";
  }
}

type WalletRow = { balance: string; version: string };

type EventRow = {
  event_id: string;
  currency: string;
  delta: string;
  balance_after: string;
  version_after: string;
  reason: string;
  actor_player_id: string | null;
  ref_type: string | null;
  ref_id: string | null;
};

type NormalizedOperation = Required<PremiumWalletOperationInput>;
type Direction = "credit" | "debit" | "clawback";

const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
/** Lumen left the wallet for inventory in 0917; its wallet rows stay for history. */
const RETIRED_LUMEN_WALLET_CURRENCY = "lumen";
const MAX_OPERATION_TEXT_LENGTH = 240;

/**
 * Account-scoped premium currency balances (Glimmer), modeled on the
 * Gold WalletService. Each (account, currency) wallet row is locked before
 * replay inspection and mutation, so balance, version, and the immutable
 * ledger event stay one serialized transition across server processes.
 * Mutations run inside a transaction owned by the caller.
 */
export class PremiumWalletService {
  constructor(private readonly pool?: pg.Pool) {}

  async snapshot(accountId: string): Promise<PremiumWalletSnapshot> {
    if (!this.pool) {
      throw new PremiumWalletOperationError(
        "PREMIUM_WALLET_INVARIANT_FAILURE",
        "Premium wallet snapshot requires a database pool"
      );
    }
    return this.snapshotInTransaction(this.pool, accountId);
  }

  async snapshotInTransaction(
    queryable: PremiumWalletQueryable,
    accountId: string
  ): Promise<PremiumWalletSnapshot> {
    const result = await queryable.query<{ currency: string } & WalletRow>(
      `SELECT currency, balance::text, version::text
       FROM premium_wallets
       WHERE account_id = $1 AND currency = ANY($2::text[])`,
      [accountId, [...PREMIUM_CURRENCIES, RETIRED_LUMEN_WALLET_CURRENCY]]
    );
    const byCurrency = new Map(result.rows.map((row) => [row.currency, row]));
    const balances = Object.fromEntries(PREMIUM_CURRENCIES.map((currency) => {
      const row = byCurrency.get(currency);
      const balance: PremiumCurrencyBalance = {
        balance: row?.balance ?? "0",
        revision: row?.version ?? "0"
      };
      return [currency, balance];
    })) as Record<PremiumCurrency, PremiumCurrencyBalance>;
    // Clients built before 0917 require a lumen entry; the retired wallet row is zero.
    const lumen = byCurrency.get(RETIRED_LUMEN_WALLET_CURRENCY);
    return {
      accountId,
      balances: { ...balances, lumen: { balance: lumen?.balance ?? "0", revision: lumen?.version ?? "0" } }
    };
  }

  async creditForOperationInTransaction(
    queryable: PremiumWalletQueryable,
    input: PremiumWalletOperationInput
  ): Promise<PremiumWalletOperationResult> {
    const operation = normalizeOperation(input);
    if (operation.reason !== "admin") {
      throw new PremiumWalletOperationError(
        "PREMIUM_WALLET_INVALID_OPERATION",
        "Premium currency can only be credited by an audited admin operation"
      );
    }
    return applyOperation(queryable, operation, "credit");
  }

  /** Exchange credit: a filled trade, an order's own escrow returning, or a Glimmer equipment sale. */
  async creditForMarketInTransaction(
    queryable: PremiumWalletQueryable,
    input: PremiumWalletOperationInput
  ): Promise<PremiumWalletOperationResult> {
    const operation = normalizeOperation(input);
    if (
      operation.reason !== "market" ||
      operation.actorPlayerId === null ||
      (
        operation.refType !== "market_order" &&
        operation.refType !== "market_trade" &&
        operation.refType !== "market_equipment_listing"
      )
    ) {
      throw new PremiumWalletOperationError(
        "PREMIUM_WALLET_INVALID_OPERATION",
        "Exchange credits require a market order, trade or equipment listing reference"
      );
    }
    return applyOperation(queryable, operation, "credit");
  }

  async debitForOperationInTransaction(
    queryable: PremiumWalletQueryable,
    input: PremiumWalletOperationInput
  ): Promise<PremiumWalletOperationResult> {
    const operation = normalizeOperation(input);
    if (operation.reason === "purchase" || operation.reason === "refund_clawback") {
      throw new PremiumWalletOperationError(
        "PREMIUM_WALLET_INVALID_OPERATION",
        "Purchase reasons use the purchase credit and refund clawback paths"
      );
    }
    return applyOperation(queryable, operation, "debit");
  }

  /** Credit of one verified store purchase; the database ties it to that purchase row. */
  async creditForPurchaseInTransaction(
    queryable: PremiumWalletQueryable,
    input: PremiumWalletOperationInput
  ): Promise<PremiumWalletOperationResult> {
    const operation = normalizeOperation(input);
    if (operation.reason !== "purchase" || operation.refType !== "premium_purchase") {
      throw new PremiumWalletOperationError(
        "PREMIUM_WALLET_INVALID_OPERATION",
        "Purchase credits require a premium purchase reference"
      );
    }
    return applyOperation(queryable, operation, "credit");
  }

  /**
   * Refund clawback of a granted purchase. Unlike every other debit it may
   * leave the balance negative (arrears), which blocks spending until repaid.
   */
  async clawbackForRefundInTransaction(
    queryable: PremiumWalletQueryable,
    input: PremiumWalletOperationInput
  ): Promise<PremiumWalletOperationResult> {
    const operation = normalizeOperation(input);
    if (operation.reason !== "refund_clawback" || operation.refType !== "premium_purchase") {
      throw new PremiumWalletOperationError(
        "PREMIUM_WALLET_INVALID_OPERATION",
        "Refund clawbacks require a premium purchase reference"
      );
    }
    return applyOperation(queryable, operation, "clawback");
  }
}

async function applyOperation(
  queryable: PremiumWalletQueryable,
  input: NormalizedOperation,
  direction: Direction
): Promise<PremiumWalletOperationResult> {
  await ensureZeroWallet(queryable, input);
  const wallet = await lockWallet(queryable, input);
  const signedAmount = direction === "credit" ? input.amount : -input.amount;
  const replay = await findOperationEvent(queryable, input);
  if (replay) {
    assertSameIntent(replay, input, signedAmount);
    assertReplayCompatibleWithWallet(replay, wallet);
    return {
      applied: false,
      currency: input.currency,
      balance: BigInt(replay.balance_after),
      version: BigInt(replay.version_after),
      eventId: replay.event_id
    };
  }

  const balanceBefore = BigInt(wallet.balance);
  const versionBefore = BigInt(wallet.version);
  if (versionBefore >= POSTGRES_BIGINT_MAX) {
    throw new PremiumWalletOperationError(
      "PREMIUM_WALLET_OVERFLOW",
      "Premium wallet version cannot be incremented"
    );
  }
  if (direction === "debit" && balanceBefore < input.amount) {
    throw new PremiumWalletOperationError(
      "PREMIUM_WALLET_INSUFFICIENT_FUNDS",
      `Not enough ${input.currency}`
    );
  }
  if (direction === "credit" && balanceBefore > POSTGRES_BIGINT_MAX - input.amount) {
    throw new PremiumWalletOperationError(
      "PREMIUM_WALLET_OVERFLOW",
      "Premium wallet credit exceeds PostgreSQL bigint"
    );
  }
  if (direction === "clawback" && balanceBefore < input.amount - POSTGRES_BIGINT_MAX) {
    throw new PremiumWalletOperationError(
      "PREMIUM_WALLET_OVERFLOW",
      "Premium wallet clawback exceeds PostgreSQL bigint"
    );
  }
  const expectedBalance = balanceBefore + signedAmount;
  const expectedVersion = versionBefore + 1n;

  const updated = await queryable.query<WalletRow>(
    `UPDATE premium_wallets
     SET balance = $3::bigint, version = $4::bigint
     WHERE account_id = $1 AND currency = $2
       AND version = $5::bigint
       AND balance = $6::bigint
     RETURNING balance::text, version::text`,
    [
      input.accountId,
      input.currency,
      expectedBalance.toString(),
      expectedVersion.toString(),
      versionBefore.toString(),
      balanceBefore.toString()
    ]
  );
  const row = updated.rows[0];
  if (
    !row ||
    BigInt(row.balance) !== expectedBalance ||
    BigInt(row.version) !== expectedVersion
  ) {
    throw new PremiumWalletOperationError(
      "PREMIUM_WALLET_INVARIANT_FAILURE",
      "Locked premium wallet transition did not update exactly one row"
    );
  }

  const inserted = await queryable.query<{ event_id: string }>(
    `INSERT INTO premium_wallet_events (
       account_id, currency, operation_key, delta, balance_after, version_after,
       reason, actor_player_id, ref_type, ref_id, metadata
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
     RETURNING event_id::text`,
    [
      input.accountId,
      input.currency,
      input.operationKey,
      signedAmount.toString(),
      expectedBalance.toString(),
      expectedVersion.toString(),
      input.reason,
      input.actorPlayerId,
      input.refType,
      input.refId,
      JSON.stringify(input.metadata)
    ]
  );

  return {
    applied: true,
    currency: input.currency,
    balance: expectedBalance,
    version: expectedVersion,
    eventId: inserted.rows[0]!.event_id
  };
}

async function ensureZeroWallet(
  queryable: PremiumWalletQueryable,
  input: NormalizedOperation
): Promise<void> {
  await queryable.query(
    `INSERT INTO premium_wallets (account_id, currency, balance, version)
     SELECT id, $2, 0, 0 FROM accounts WHERE id = $1
     ON CONFLICT (account_id, currency) DO NOTHING`,
    [input.accountId, input.currency]
  );
}

async function lockWallet(
  queryable: PremiumWalletQueryable,
  input: NormalizedOperation
): Promise<WalletRow> {
  const result = await queryable.query<WalletRow>(
    `SELECT balance::text, version::text
     FROM premium_wallets
     WHERE account_id = $1 AND currency = $2
     FOR UPDATE`,
    [input.accountId, input.currency]
  );
  const wallet = result.rows[0];
  if (!wallet) {
    throw new PremiumWalletOperationError(
      "PREMIUM_WALLET_OWNERSHIP_INVALID",
      "Authoritative premium wallet ownership is invalid"
    );
  }
  return wallet;
}

async function findOperationEvent(
  queryable: PremiumWalletQueryable,
  input: NormalizedOperation
): Promise<EventRow | null> {
  const result = await queryable.query<EventRow>(
    `SELECT event_id::text, currency, delta::text, balance_after::text, version_after::text,
            reason, actor_player_id, ref_type, ref_id
     FROM premium_wallet_events
     WHERE account_id = $1 AND operation_key = $2`,
    [input.accountId, input.operationKey]
  );
  return result.rows[0] ?? null;
}

function assertSameIntent(
  event: EventRow,
  input: NormalizedOperation,
  signedAmount: bigint
): void {
  if (
    event.currency !== input.currency ||
    BigInt(event.delta) !== signedAmount ||
    event.reason !== input.reason ||
    event.actor_player_id !== input.actorPlayerId ||
    event.ref_type !== input.refType ||
    event.ref_id !== input.refId
  ) {
    throw new PremiumWalletOperationError(
      "PREMIUM_WALLET_IDEMPOTENCY_CONFLICT",
      "Premium wallet operation key was reused with different intent"
    );
  }
}

function assertReplayCompatibleWithWallet(event: EventRow, wallet: WalletRow): void {
  const eventVersion = BigInt(event.version_after);
  const walletVersion = BigInt(wallet.version);
  if (
    eventVersion > walletVersion ||
    (eventVersion === walletVersion && BigInt(event.balance_after) !== BigInt(wallet.balance))
  ) {
    throw new PremiumWalletOperationError(
      "PREMIUM_WALLET_INVARIANT_FAILURE",
      "Premium wallet replay event is inconsistent with the authoritative wallet"
    );
  }
}

function normalizeOperation(input: PremiumWalletOperationInput): NormalizedOperation {
  if (!input.accountId || !PREMIUM_CURRENCIES.includes(input.currency)) {
    throw new PremiumWalletOperationError(
      "PREMIUM_WALLET_INVALID_OPERATION",
      "Premium wallet operation account and a known currency are required"
    );
  }
  if (
    !input.operationKey ||
    input.operationKey.length > MAX_OPERATION_TEXT_LENGTH ||
    !PREMIUM_WALLET_REASONS.has(input.reason)
  ) {
    throw new PremiumWalletOperationError(
      "PREMIUM_WALLET_INVALID_OPERATION",
      "Premium wallet operation key (at most 240 characters) and a known reason are required"
    );
  }
  if (typeof input.amount !== "bigint" || input.amount <= 0n || input.amount > POSTGRES_BIGINT_MAX) {
    throw new PremiumWalletOperationError(
      "PREMIUM_WALLET_INVALID_OPERATION",
      "Premium wallet operation amount must be a positive PostgreSQL bigint"
    );
  }
  if ((input.refType == null) !== (input.refId == null)) {
    throw new PremiumWalletOperationError(
      "PREMIUM_WALLET_INVALID_OPERATION",
      "Premium wallet reference type and id must be given together"
    );
  }
  return {
    ...input,
    actorPlayerId: input.actorPlayerId ?? null,
    refType: input.refType ?? null,
    refId: input.refId ?? null,
    metadata: input.metadata ?? {}
  };
}
