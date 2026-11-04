import type pg from "pg";
import { describe, expect, it } from "vitest";

import { MarketReconciliationService } from "./marketReconciliation.js";

const BOOK_ID = "20000000-0000-4000-8000-000000000001";

describe("market reconciliation runtime transaction", () => {
  it("drains mutations before opening one detection-and-protection transaction", async () => {
    const calls: string[] = [];
    const client = fakeClient(calls);
    const pool = {
      connect: async () => client
    } as unknown as pg.Pool;
    const service = new MarketReconciliationService(
      pool,
      () => new Date("2026-07-10T00:00:00.000Z"),
      { statementTimeoutMs: 4_000, advisoryLockTimeoutMs: 2_000 }
    );

    const result = await service.reconcileRun();

    expect(result.report.ok).toBe(false);
    expect(result.report.issues.map(({ code }) => code)).toEqual([
      "NEGATIVE_OR_INVALID_STATE",
      "DROPPED_ITEM_CUSTODY_MISMATCH"
    ]);
    expect(result.protection).toMatchObject({
      protectionApplied: true,
      auditRecorded: true,
      globalReadOnly: true,
      frozenBookIds: []
    });
    expect(indexOf(calls, "pg_advisory_lock("))
      .toBeLessThan(indexOf(calls, "BEGIN ISOLATION LEVEL REPEATABLE READ"));
    expect(indexOf(calls, "market-reconcile:counts"))
      .toBeLessThan(indexOf(calls, "UPDATE market_global_controls"));
    expect(indexOf(calls, "BEGIN ISOLATION LEVEL REPEATABLE READ"))
      .toBeLessThan(indexOf(calls, "economy-reconcile:world-item-custody"));
    expect(indexOf(calls, "economy-reconcile:world-item-custody"))
      .toBeLessThan(indexOf(calls, "UPDATE market_global_controls"));
    expect(indexOf(calls, "UPDATE market_global_controls"))
      .toBeLessThan(indexOf(calls, "COMMIT"));
    expect(calls.filter((sql) => sql === "COMMIT")).toHaveLength(1);
    expect(indexOf(calls, "COMMIT")).toBeLessThan(indexOf(calls, "pg_advisory_unlock"));
    expect(calls.some((sql) => sql.includes("4000ms"))).toBe(true);
  });
});

function fakeClient(calls: string[]) {
  return {
    query: async (raw: string, values?: unknown[]) => {
      const sql = raw.replace(/\s+/g, " ").trim();
      calls.push(values?.length ? `${sql} -- ${values.join(",")}` : sql);
      if (sql.includes("current_setting('statement_timeout')")) {
        return { rowCount: 1, rows: [{ value: "0" }] };
      }
      if (sql.includes("pg_advisory_unlock")) {
        return { rowCount: 1, rows: [{ unlocked: true }] };
      }
      if (sql.includes("market-reconcile:counts")) {
        return {
          rowCount: 1,
          rows: [{
            order_count: "0",
            trade_count: "0",
            ledger_group_count: "0",
            collection_count: "0"
          }]
        };
      }
      if (sql.includes("market-reconcile:negative-state")) {
        return {
          rowCount: 1,
          rows: [{
            entity_type: "book",
            entity_id: BOOK_ID,
            book_id: BOOK_ID,
            player_id: null,
            details: { invalid: true }
          }]
        };
      }
      if (sql.includes("economy-reconcile:world-item-custody")) {
        return {
          rowCount: 1,
          rows: [{
            code: "DROPPED_ITEM_CUSTODY_MISMATCH",
            scope: "world_item_drop",
            entity_id: "drop-1",
            details: { playerId: "player-1" }
          }]
        };
      }
      if (sql.includes("SELECT auto_pause_on_invariant_failure")) {
        return { rowCount: 1, rows: [{ auto_pause_on_invariant_failure: true }] };
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
      if (sql === "SELECT read_only FROM market_global_controls WHERE singleton") {
        return { rowCount: 1, rows: [{ read_only: true }] };
      }
      return { rowCount: 0, rows: [] };
    },
    release: () => undefined
  } as unknown as pg.PoolClient;
}

function indexOf(values: string[], fragment: string): number {
  const index = values.findIndex((value) => value.includes(fragment));
  expect(index, `missing query containing ${fragment}`).toBeGreaterThanOrEqual(0);
  return index;
}
