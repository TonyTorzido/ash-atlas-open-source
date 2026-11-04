import type { MarketReconciliationReport } from "@ash-atlas/shared";
import type pg from "pg";

import { setMarketControlAuditContext } from "./marketControlAudit.js";
import { isRetryablePostgresError } from "./marketRules.js";
import {
  acquireMarketReconciliationSafetyLock,
  MarketSafetyLockSessionError,
  releaseMarketReconciliationSafetyLock
} from "./marketSafetyLock.js";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

type GlobalControlState = {
  read_only: boolean;
  new_orders_enabled: boolean;
  matching_enabled: boolean;
  cancellations_enabled: boolean;
  claims_enabled: boolean;
  auto_pause_on_invariant_failure: boolean;
  rules_version: number;
};

type BookControlState = {
  book_id: string;
  frozen: boolean;
  sensitive_reason: string | null;
};

export type MarketProtectionMode = "none" | "affected_books" | "global";

export type MarketProtectionResult = {
  protectionApplied: boolean;
  auditRecorded: boolean;
  globalReadOnly: boolean;
  affectedBookIds: string[];
  frozenBookIds: string[];
};

export async function marketAutomaticProtectionEnabled(queryable: Queryable): Promise<boolean> {
  const result = await queryable.query<{ auto_pause_on_invariant_failure: boolean }>(
    `SELECT auto_pause_on_invariant_failure
     FROM market_global_controls WHERE singleton`
  );
  return result.rows[0]?.auto_pause_on_invariant_failure === true;
}

/** Applies protection and records bounded critical evidence in the caller's transaction. */
export async function applyMarketReconciliationFailure(
  client: pg.PoolClient,
  report: MarketReconciliationReport,
  options: { recordCriticalAudit: boolean; freezeMode: MarketProtectionMode }
): Promise<MarketProtectionResult> {
  const requestedBookIds = uniqueUuidDetails(report, "bookId");
  const hasUnscopedIssue = report.issues.some((issue) => {
    const bookId = stringDetail(issue.details, "bookId");
    return !bookId || !UUID_PATTERN.test(bookId);
  });
  let freezeGlobal =
    options.freezeMode === "global" ||
    (options.freezeMode === "affected_books" && hasUnscopedIssue);

  // This row lock preserves the same global-before-book order as mutations and
  // administrative controls. The advisory protocol separately guarantees the
  // reconciliation snapshot was taken after prior mutations drained.
  const controls = await client.query<GlobalControlState>(
    `SELECT read_only, new_orders_enabled, matching_enabled,
            cancellations_enabled, claims_enabled,
            auto_pause_on_invariant_failure, rules_version
     FROM market_global_controls WHERE singleton FOR UPDATE`
  );
  const globalBefore = controls.rows[0];
  if (!globalBefore) throw new Error("Market global controls do not exist");

  let bookStates: BookControlState[] = [];
  if (options.freezeMode === "affected_books" && requestedBookIds.length > 0) {
    const locked = await client.query<BookControlState>(
      `SELECT book_id, frozen, sensitive_reason
       FROM market_order_books
       WHERE book_id = ANY($1::uuid[])
       ORDER BY book_id
       FOR UPDATE`,
      [requestedBookIds]
    );
    bookStates = locked.rows;
    // A stale/missing supposedly affected book must not leave a failed startup
    // or runtime reconciliation only partially protected.
    if (bookStates.length !== requestedBookIds.length) freezeGlobal = true;
  }

  const reason = `automatic reconciliation protection at ${report.checkedAt}`;
  await setMarketControlAuditContext(client, {
    operatorIdentity: "system:market-reconciliation",
    reason,
    incidentId: `reconciliation:${report.checkedAt}`
  });

  let frozenBookIds: string[] = [];
  if (freezeGlobal) {
    await client.query(
      `UPDATE market_global_controls
       SET read_only = true,
           new_orders_enabled = false,
           matching_enabled = false,
           updated_at = now()
       WHERE singleton`
    );
  } else if (options.freezeMode === "affected_books" && bookStates.length > 0) {
    frozenBookIds = bookStates.map((row) => row.book_id);
    await client.query(
      `UPDATE market_order_books
       SET frozen = true,
           sensitive_reason = $2,
           updated_at = now()
       WHERE book_id = ANY($1::uuid[])`,
      [frozenBookIds, reason]
    );
  }

  const protectionApplied = freezeGlobal || frozenBookIds.length > 0;
  const auditRecorded = options.recordCriticalAudit || protectionApplied;
  const globalAfter = {
    ...globalBefore,
    read_only: freezeGlobal ? true : globalBefore.read_only,
    new_orders_enabled: freezeGlobal ? false : globalBefore.new_orders_enabled,
    matching_enabled: freezeGlobal ? false : globalBefore.matching_enabled
  };
  if (auditRecorded) {
    await client.query(
      `INSERT INTO market_audit_events (
         severity, event_type, venue_id, book_id, player_id, evidence
       ) VALUES ('critical', 'market_reconciliation_failed', $1, $2, $3, $4::jsonb)`,
      [
        singleUuidDetail(report, "venueId"),
        singleUuidDetail(report, "bookId"),
        singleTextDetail(report, "playerId"),
        JSON.stringify({
          operatorIdentity: "system:market-reconciliation",
          reason,
          incidentId: `reconciliation:${report.checkedAt}`,
          targetScope: freezeGlobal
            ? { type: "global", id: "global" }
            : { type: "affected_books", ids: frozenBookIds },
          priorState: {
            global: globalBefore,
            books: bookStates.slice(0, 100)
          },
          resultingState: {
            global: globalAfter,
            books: bookStates.slice(0, 100).map((row) => ({
              ...row,
              frozen: frozenBookIds.includes(row.book_id) ? true : row.frozen,
              sensitive_reason: frozenBookIds.includes(row.book_id) ? reason : row.sensitive_reason
            }))
          },
          checkedAt: report.checkedAt,
          issueCount: report.issues.length,
          issueCodes: [...new Set(report.issues.map((issue) => issue.code))].sort(),
          issues: report.issues.slice(0, 100),
          evidenceTruncated: report.issues.length > 100 || bookStates.length > 100,
          freezeMode: options.freezeMode,
          frozenBookIds,
          globalReadOnly: globalAfter.read_only
        })
      ]
    );
  }

  return {
    protectionApplied,
    auditRecorded,
    globalReadOnly: globalAfter.read_only,
    affectedBookIds: requestedBookIds,
    frozenBookIds
  };
}

/** Standalone compatibility wrapper used by explicit operational tooling. */
export async function recordMarketReconciliationFailure(
  pool: pg.Pool,
  report: MarketReconciliationReport,
  options: { recordCriticalAudit: boolean; freezeMode: MarketProtectionMode },
  retryLimit = 3,
  lockTimeoutMs = 15_000
): Promise<MarketProtectionResult> {
  const client = await pool.connect();
  let lockHeld = false;
  let operationError: unknown;
  let result: MarketProtectionResult | undefined;
  try {
    await acquireMarketReconciliationSafetyLock(client, lockTimeoutMs);
    lockHeld = true;
    result = await applyProtectionWithRetries(client, report, options, retryLimit);
  } catch (error) {
    operationError = error;
  }
  let releaseError: unknown;
  if (lockHeld) {
    try {
      await releaseMarketReconciliationSafetyLock(client);
    } catch (error) {
      releaseError = error;
    }
  }
  const destroyReason = releaseError instanceof Error
    ? releaseError
    : operationError instanceof MarketSafetyLockSessionError
      ? operationError
      : undefined;
  client.release(destroyReason);
  if (operationError) throw operationError;
  if (releaseError) throw releaseError;
  if (!result) throw new Error("Market reconciliation protection completed without a result");
  return result;
}

async function applyProtectionWithRetries(
  client: pg.PoolClient,
  report: MarketReconciliationReport,
  options: { recordCriticalAudit: boolean; freezeMode: MarketProtectionMode },
  retryLimit: number
): Promise<MarketProtectionResult> {
  for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
    let began = false;
    try {
      await client.query("BEGIN");
      began = true;
      const result = await applyMarketReconciliationFailure(client, report, options);
      await client.query("COMMIT");
      began = false;
      return result;
    } catch (error) {
      if (began) await client.query("ROLLBACK").catch(() => undefined);
      if (isRetryablePostgresError(error) && attempt < retryLimit) continue;
      throw error;
    }
  }
  throw new Error("Market reconciliation protection retry limit reached");
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function uniqueUuidDetails(report: MarketReconciliationReport, key: string): string[] {
  return [...new Set(report.issues
    .map((issue) => stringDetail(issue.details, key))
    .filter((value): value is string => Boolean(value && UUID_PATTERN.test(value))))]
    .sort();
}

function singleUuidDetail(report: MarketReconciliationReport, key: string): string | null {
  const values = uniqueUuidDetails(report, key);
  return values.length === 1 ? values[0]! : null;
}

function singleTextDetail(report: MarketReconciliationReport, key: string): string | null {
  const values = [...new Set(report.issues
    .map((issue) => stringDetail(issue.details, key))
    .filter((value): value is string => Boolean(value)))]
    .sort();
  return values.length === 1 ? values[0]! : null;
}

function stringDetail(details: Record<string, unknown>, key: string): string | null {
  const value = details[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}
