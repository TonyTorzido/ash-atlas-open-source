import { describe, expect, it } from "vitest";

import {
  MIGRATION_HASH_BASELINE_CONFIRMATION,
  migrationContentSha256,
  nonTransactionalStatements
} from "./migrate.js";

describe("migration integrity", () => {
  it("computes a stable lowercase SHA-256 over exact file content", () => {
    expect(migrationContentSha256("SELECT 1;\n")).toBe(
      "b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd"
    );
    expect(migrationContentSha256("SELECT 1;")).not.toBe(
      migrationContentSha256("SELECT 1;\n")
    );
    expect(migrationContentSha256("SELECT 1;\n")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("flags only top-level statements that cannot run in one batch transaction", () => {
    const pg17 = { enumAddValueInTransaction: true };
    expect(nonTransactionalStatements("CREATE INDEX CONCURRENTLY i ON t (a);", pg17))
      .toEqual(["CREATE/DROP INDEX CONCURRENTLY"]);
    expect(nonTransactionalStatements("BEGIN;\nCREATE TABLE a (i int);\nCOMMIT;\n", pg17))
      .toEqual(["transaction control"]);
    expect(nonTransactionalStatements("VACUUM ANALYZE t;", pg17)).toEqual(["VACUUM"]);
    expect(nonTransactionalStatements(
      "-- vacuum; commit;\nUPDATE t SET name = 'Vacuum; commit';\n" +
      "CREATE FUNCTION f() RETURNS void AS $$ BEGIN PERFORM 1; END; $$ LANGUAGE plpgsql;\n" +
      "REFRESH MATERIALIZED VIEW CONCURRENTLY m;\nALTER TYPE k ADD VALUE 'x';\n",
      pg17
    )).toEqual([]);
    expect(nonTransactionalStatements("ALTER TYPE k ADD VALUE 'x';", {
      enumAddValueInTransaction: false
    })).toHaveLength(1);
  });

  it("requires an explicit exact sentinel for a legacy hash baseline", () => {
    expect(MIGRATION_HASH_BASELINE_CONFIRMATION).toBe("confirm-current-files");
  });
});
