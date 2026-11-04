import type pg from "pg";
import { describe, expect, it } from "vitest";

import {
  parseArguments,
  updateMarketControlsInTransaction,
  updateMarketControlsWithPool
} from "./controls.js";

describe("market administrative controls", () => {
  it("parses explicit operator, reason, incident, and automatic-protection controls", () => {
    expect(parseArguments([
      "--operator=operator@example",
      "--reason=incident containment",
      "--incident-id=INC-42",
      "--auto-pause-on-invariant-failure=false",
      "--matching=false"
    ])).toEqual({
      operatorIdentity: "operator@example",
      reason: "incident containment",
      incidentId: "INC-42",
      autoPauseOnInvariantFailure: false,
      matching: false
    });
  });

  it("requires operator identity and reason before issuing a mutating query", async () => {
    const missingOperator = fakeClient();
    await expect(updateMarketControlsInTransaction(missingOperator.client, {
      globalReadOnly: true,
      reason: "incident containment"
    })).rejects.toThrow(/--operator is required/i);
    expect(missingOperator.calls).toEqual([]);

    const missingReason = fakeClient();
    await expect(updateMarketControlsInTransaction(missingReason.client, {
      globalReadOnly: true,
      operatorIdentity: "operator@example"
    })).rejects.toThrow(/--reason is required/i);
    expect(missingReason.calls).toEqual([]);
  });

  it("sets transaction-local audit context before updating every global control", async () => {
    const fake = fakeClient();
    const status = await updateMarketControlsInTransaction(fake.client, {
      globalReadOnly: true,
      newOrders: false,
      matching: false,
      cancellations: false,
      claims: false,
      autoPauseOnInvariantFailure: false,
      operatorIdentity: "operator@example",
      reason: "incident containment",
      incidentId: "INC-42"
    });

    expect(indexOf(fake.calls, "pg_advisory_xact_lock_shared"))
      .toBeLessThan(indexOf(fake.calls, "ash_atlas.market_control_operator"));
    expect(indexOf(fake.calls, "ash_atlas.market_control_operator"))
      .toBeLessThan(indexOf(fake.calls, "UPDATE market_global_controls"));
    expect(fake.calls.some((sql) => sql.includes("auto_pause_on_invariant_failure = coalesce")))
      .toBe(true);
    expect(fake.calls.some((sql) => sql.includes("INSERT INTO market_audit_events"))).toBe(false);
    expect(status.global).toMatchObject({
      auto_pause_on_invariant_failure: false,
      matching_enabled: false
    });
  });

  it("uses audited freeze and unfreeze shapes for global, venue, book, and player targets", async () => {
    for (const globalReadOnly of [true, false]) {
      const fake = fakeClient();
      await updateMarketControlsInTransaction(fake.client, {
        globalReadOnly,
        operatorIdentity: "operator@example",
        reason: globalReadOnly ? "freeze global market" : "unfreeze global market"
      });
      expect(fake.queries.find((query) => query.sql.startsWith("UPDATE market_global_controls"))?.values)
        .toEqual([globalReadOnly, undefined, undefined, undefined, undefined, undefined]);
    }

    for (const frozen of [true, false]) {
      const venue = fakeClient();
      await updateMarketControlsInTransaction(venue.client, {
        venueKey: "global",
        venueFrozen: frozen,
        operatorIdentity: "operator@example",
        reason: frozen ? "freeze venue" : "unfreeze venue"
      });
      const venueUpdate = venue.queries.find((query) => query.sql.startsWith("UPDATE market_venue_controls"));
      expect(venueUpdate?.sql).toContain("CASE WHEN $2 THEN $3 ELSE NULL END");
      expect(venueUpdate?.values).toEqual(["global", frozen, frozen ? "freeze venue" : "unfreeze venue"]);

      const book = fakeClient();
      await updateMarketControlsInTransaction(book.client, {
        itemId: "ore",
        itemFrozen: frozen,
        operatorIdentity: "operator@example",
        reason: frozen ? "freeze book" : "unfreeze book"
      });
      expect(indexOf(book.calls, "ORDER BY book_id FOR UPDATE"))
        .toBeLessThan(indexOf(book.calls, "UPDATE market_order_books"));
      const bookUpdate = book.queries.find((query) => query.sql.startsWith("UPDATE market_order_books"));
      expect(bookUpdate?.sql).toContain("CASE WHEN $2 THEN $3 ELSE NULL END");
      expect(bookUpdate?.values).toEqual([
        ["20000000-0000-4000-8000-000000000001"],
        frozen,
        frozen ? "freeze book" : "unfreeze book"
      ]);

      const player = fakeClient();
      await updateMarketControlsInTransaction(player.client, {
        playerId: "player-one",
        playerFrozen: frozen,
        operatorIdentity: "operator@example",
        reason: frozen ? "freeze player" : "unfreeze player"
      });
      const playerUpdate = player.queries.find((query) => query.sql.startsWith("INSERT INTO market_player_controls"));
      expect(playerUpdate?.sql).toContain("CASE WHEN $2 THEN $3 ELSE NULL END");
      expect(playerUpdate?.values).toEqual([
        "player-one",
        frozen,
        frozen ? "freeze player" : "unfreeze player"
      ]);
    }
  });

  it("rolls back control updates when status/audit-trigger processing fails", async () => {
    const fake = fakeClient({ failStatus: true });
    const pool = {
      connect: async () => fake.client
    } as unknown as pg.Pool;

    await expect(updateMarketControlsWithPool(pool, {
      globalReadOnly: true,
      operatorIdentity: "operator@example",
      reason: "incident containment"
    })).rejects.toThrow("status failed");
    expect(fake.calls).toContain("ROLLBACK");
    expect(fake.calls).not.toContain("COMMIT");
    expect(fake.released()).toBe(true);
  });
});

function fakeClient(options: { failStatus?: boolean } = {}) {
  const calls: string[] = [];
  const queries: Array<{ sql: string; values: unknown[] | undefined }> = [];
  let released = false;
  const client = {
    query: async (raw: string, values?: unknown[]) => {
      const sql = raw.replace(/\s+/g, " ").trim();
      calls.push(sql);
      queries.push({ sql, values });
      if (
        options.failStatus &&
        sql.startsWith("SELECT read_only, new_orders_enabled")
      ) {
        throw new Error("status failed");
      }
      if (sql.startsWith("UPDATE market_global_controls")) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.startsWith("INSERT INTO market_player_controls")) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.startsWith("UPDATE market_venue_controls")) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("FROM market_order_books") && sql.includes("FOR UPDATE")) {
        return {
          rowCount: 1,
          rows: [{ book_id: "20000000-0000-4000-8000-000000000001" }]
        };
      }
      if (sql.startsWith("UPDATE market_order_books")) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.startsWith("SELECT read_only, new_orders_enabled")) {
        return {
          rowCount: 1,
          rows: [{
            read_only: true,
            new_orders_enabled: false,
            matching_enabled: false,
            cancellations_enabled: false,
            claims_enabled: false,
            auto_pause_on_invariant_failure: false,
            rules_version: 1
          }]
        };
      }
      return { rowCount: 0, rows: [] };
    },
    release: () => {
      released = true;
    }
  } as unknown as pg.PoolClient;
  return { client, calls, queries, released: () => released };
}

function indexOf(values: string[], fragment: string): number {
  const index = values.findIndex((value) => value.includes(fragment));
  expect(index, `missing query containing ${fragment}`).toBeGreaterThanOrEqual(0);
  return index;
}
