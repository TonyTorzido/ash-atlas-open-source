import type { MarketReconciliationReport } from "@ash-atlas/shared";
import type pg from "pg";
import { describe, expect, it } from "vitest";

import {
  marketAutomaticProtectionEnabled,
  recordMarketReconciliationFailure
} from "./marketReconciliationProtection.js";

const BOOK_ID = "20000000-0000-4000-8000-000000000001";
const VENUE_ID = "00000000-0000-4000-8000-000000000600";

describe("market reconciliation protection", () => {
  it("honors the database automatic-protection flag", async () => {
    const pool = {
      query: async () => ({ rows: [{ auto_pause_on_invariant_failure: true }] })
    } as unknown as pg.Pool;
    await expect(marketAutomaticProtectionEnabled(pool)).resolves.toBe(true);
  });

  it("takes the session safety lock before the transaction, then locks controls and books", async () => {
    const calls: string[] = [];
    const client = fakeClient(calls);
    const pool = fakePool(client);

    const result = await recordMarketReconciliationFailure(
      pool,
      report({ bookId: BOOK_ID, venueId: VENUE_ID }),
      { recordCriticalAudit: true, freezeMode: "affected_books" }
    );

    expect(indexOf(calls, "pg_advisory_lock"))
      .toBeLessThan(indexOf(calls, "BEGIN"));
    expect(indexOf(calls, "market_global_controls WHERE singleton FOR UPDATE"))
      .toBeLessThan(indexOf(calls, "ORDER BY book_id"));
    expect(indexOf(calls, "ORDER BY book_id"))
      .toBeLessThan(indexOf(calls, "UPDATE market_order_books"));
    expect(indexOf(calls, "ash_atlas.market_control_operator"))
      .toBeLessThan(indexOf(calls, "UPDATE market_order_books"));
    expect(calls.some((sql) => sql.includes("market_reconciliation_failed"))).toBe(true);
    expect(indexOf(calls, "COMMIT")).toBeLessThan(indexOf(calls, "pg_advisory_unlock"));
    expect(result).toMatchObject({
      protectionApplied: true,
      auditRecorded: true,
      globalReadOnly: false,
      frozenBookIds: [BOOK_ID]
    });
    expect(client.auditEvidence()).toMatchObject({
      operatorIdentity: "system:market-reconciliation",
      targetScope: { type: "affected_books", ids: [BOOK_ID] },
      priorState: { global: { read_only: false } },
      resultingState: { global: { read_only: false } },
      issueCount: 1,
      frozenBookIds: [BOOK_ID]
    });
  });

  it("retries a recognized transaction failure while retaining the exclusive session lock", async () => {
    const calls: string[] = [];
    const client = fakeClient(calls, { failFirstGlobalLock: true });
    const pool = fakePool(client);

    await recordMarketReconciliationFailure(
      pool,
      report({}),
      { recordCriticalAudit: true, freezeMode: "global" },
      1
    );

    expect(calls.filter((sql) => sql === "BEGIN")).toHaveLength(2);
    expect(calls).toContain("ROLLBACK");
    expect(calls.filter((sql) => sql.includes("pg_advisory_lock("))).toHaveLength(1);
    expect(calls.some((sql) => sql.includes("UPDATE market_global_controls"))).toBe(true);
    expect(calls.at(-1)).toContain("pg_advisory_unlock");
  });

  it("rolls back protection when immutable critical evidence cannot be inserted", async () => {
    const calls: string[] = [];
    const client = fakeClient(calls, { failAudit: true });
    const pool = fakePool(client);

    await expect(recordMarketReconciliationFailure(
      pool,
      report({}),
      { recordCriticalAudit: true, freezeMode: "global" },
      0
    )).rejects.toThrow("audit insert failed");
    expect(calls.some((sql) => sql.includes("UPDATE market_global_controls"))).toBe(true);
    expect(calls).toContain("ROLLBACK");
    expect(calls).not.toContain("COMMIT");
  });
});

function fakePool(client: ReturnType<typeof fakeClient>): pg.Pool {
  return {
    connect: async () => client
  } as unknown as pg.Pool;
}

function fakeClient(
  calls: string[],
  options: { failFirstGlobalLock?: boolean; failAudit?: boolean } = {}
) {
  let failed = false;
  let auditEvidence: Record<string, unknown> | null = null;
  return {
    query: async (raw: string, values?: unknown[]) => {
      const sql = raw.replace(/\s+/g, " ").trim();
      calls.push(sql);
      if (
        options.failFirstGlobalLock &&
        !failed &&
        sql.includes("market_global_controls WHERE singleton FOR UPDATE")
      ) {
        failed = true;
        throw Object.assign(new Error("deadlock"), { code: "40P01" });
      }
      if (sql.includes("current_setting('statement_timeout')")) {
        return { rowCount: 1, rows: [{ value: "0" }] };
      }
      if (sql.includes("pg_advisory_unlock")) {
        return { rowCount: 1, rows: [{ unlocked: true }] };
      }
      if (sql.includes("market_global_controls WHERE singleton FOR UPDATE")) {
        return {
          rowCount: 1,
          rows: [{
            read_only: false,
            new_orders_enabled: true,
            matching_enabled: true,
            cancellations_enabled: true,
            claims_enabled: true,
            auto_pause_on_invariant_failure: true,
            rules_version: 1
          }]
        };
      }
      if (sql.includes("SELECT book_id, frozen, sensitive_reason")) {
        return {
          rowCount: 1,
          rows: [{ book_id: BOOK_ID, frozen: false, sensitive_reason: null }]
        };
      }
      if (sql.includes("market_reconciliation_failed")) {
        auditEvidence = JSON.parse(String(values?.[3])) as Record<string, unknown>;
        if (options.failAudit) throw new Error("audit insert failed");
      }
      return { rowCount: 1, rows: [] };
    },
    release: () => undefined,
    auditEvidence: () => auditEvidence
  };
}

function report(details: Record<string, unknown>): MarketReconciliationReport {
  return {
    ok: false,
    checkedAt: "2026-07-10T00:00:00.000Z",
    orderCount: 1,
    tradeCount: 0,
    ledgerGroupCount: 1,
    collectionCount: 0,
    issues: [{ code: "TEST_INVARIANT", scope: "order", entityId: "order-1", details }]
  };
}

function indexOf(values: string[], fragment: string): number {
  const index = values.findIndex((value) => value.includes(fragment));
  expect(index, `missing query containing ${fragment}`).toBeGreaterThanOrEqual(0);
  return index;
}
