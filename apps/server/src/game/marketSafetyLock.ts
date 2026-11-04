import type pg from "pg";

type Queryable = Pick<pg.PoolClient, "query">;

/**
 * One database-wide protocol separates ordinary market mutations from a full
 * reconciliation snapshot. The reconciler owns the exclusive session lock
 * before opening its repeatable-read transaction, so its snapshot is taken
 * only after every earlier shared mutation transaction has drained.
 */
export const MARKET_SAFETY_LOCK_NAME = "ash-atlas:market-safety:v1";

export class MarketSafetyLockSessionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MarketSafetyLockSessionError";
  }
}

export async function acquireMarketMutationSafetyLock(queryable: Queryable): Promise<void> {
  await queryable.query(
    "SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))",
    [MARKET_SAFETY_LOCK_NAME]
  );
}

export async function acquireMarketReconciliationSafetyLock(
  client: pg.PoolClient,
  timeoutMs: number
): Promise<void> {
  requirePositiveTimeout(timeoutMs);
  const previous = await client.query<{ value: string }>(
    "SELECT current_setting('statement_timeout') AS value"
  );
  const previousTimeout = previous.rows[0]?.value ?? "0";
  let acquired = false;
  let acquisitionError: unknown;
  try {
    await client.query("SELECT set_config('statement_timeout', $1, false)", [`${timeoutMs}ms`]);
    await client.query(
      "SELECT pg_advisory_lock(hashtextextended($1, 0))",
      [MARKET_SAFETY_LOCK_NAME]
    );
    acquired = true;
  } catch (error) {
    acquisitionError = error;
  }
  try {
    await client.query("SELECT set_config('statement_timeout', $1, false)", [previousTimeout]);
  } catch (error) {
    if (acquired) {
      await client.query(
        "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
        [MARKET_SAFETY_LOCK_NAME]
      ).catch(() => undefined);
    }
    throw new MarketSafetyLockSessionError(
      "Failed to restore the database session after acquiring the market safety lock",
      { cause: error }
    );
  }
  if (acquisitionError) throw acquisitionError;
}

export async function releaseMarketReconciliationSafetyLock(
  client: pg.PoolClient
): Promise<void> {
  const result = await client.query<{ unlocked: boolean }>(
    "SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked",
    [MARKET_SAFETY_LOCK_NAME]
  );
  if (result.rows[0]?.unlocked !== true) {
    throw new Error("Market reconciliation safety lock was not held by this database session");
  }
}

function requirePositiveTimeout(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Market reconciliation lock timeout must be a positive safe integer");
  }
}
