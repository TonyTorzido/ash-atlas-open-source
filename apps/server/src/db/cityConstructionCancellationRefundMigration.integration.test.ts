import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const databaseName = `ash_atlas_stability_city_cancel_refund_${randomUUID()
  .replaceAll("-", "")}`;
let admin: pg.Client;
let pool: pg.Pool;

describeDatabase("city construction cancellation refund migration", () => {
  beforeAll(async () => {
    const parsed = requireStabilityAdminUrl(adminUrl!);
    admin = new pg.Client({ connectionString: parsed.toString() });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${quotedDatabase(databaseName)}`);
    parsed.pathname = `/${databaseName}`;
    pool = new DisposableTestPool({ connectionString: parsed.toString() });
    await pool.query(`
      CREATE TABLE city_coin_ledger (
        operation_key text PRIMARY KEY,
        entry_type text NOT NULL,
        delta bigint NOT NULL,
        CONSTRAINT city_coin_ledger_entry_type_check CHECK (
          entry_type IN (
            'combat_contribution','development_grant','package_grant','construction_spend'
          )
        )
      );
      CREATE TABLE city_gold_operations (
        operation_key text PRIMARY KEY,
        action text NOT NULL,
        CONSTRAINT city_gold_operations_action_check CHECK (
          action IN ('donate','construction_spend')
        )
      );
      CREATE TABLE city_gold_ledger (
        operation_key text PRIMARY KEY,
        entry_type text NOT NULL,
        delta bigint NOT NULL,
        CONSTRAINT city_gold_ledger_entry_type_check CHECK (
          entry_type IN ('member_donation','construction_spend')
        )
      );
      INSERT INTO city_coin_ledger VALUES ('coin-spend','construction_spend',-100);
      INSERT INTO city_gold_operations VALUES ('gold-spend','construction_spend');
      INSERT INTO city_gold_ledger VALUES ('gold-spend','construction_spend',-100);
    `);
  });

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${quotedDatabase(databaseName)} WITH (FORCE)`);
      await admin.end();
    }
  });

  it("preserves populated spend rows and accepts refund rows on repeatable application", async () => {
    const migration = await readFile(
      path.resolve("../../db/migrations/0766_city_construction_cancellation_refunds.sql"),
      "utf8"
    );

    await pool.query(migration);
    await expect(pool.query(
      `SELECT operation_key,entry_type,delta::text
       FROM city_coin_ledger ORDER BY operation_key`
    )).resolves.toMatchObject({
      rows: [{ operation_key: "coin-spend", entry_type: "construction_spend", delta: "-100" }]
    });
    await expect(pool.query(
      `SELECT operation_key,entry_type,delta::text
       FROM city_gold_ledger ORDER BY operation_key`
    )).resolves.toMatchObject({
      rows: [{ operation_key: "gold-spend", entry_type: "construction_spend", delta: "-100" }]
    });
    await pool.query(`
      INSERT INTO city_coin_ledger VALUES ('coin-refund','construction_refund',100);
      INSERT INTO city_gold_operations VALUES ('gold-refund','construction_refund');
      INSERT INTO city_gold_ledger VALUES ('gold-refund','construction_refund',100);
    `);

    await expect(pool.query(migration)).resolves.toBeDefined();
    await expect(pool.query(
      `SELECT count(*)::int AS count FROM city_coin_ledger`
    )).resolves.toMatchObject({ rows: [{ count: 2 }] });
    await expect(pool.query(
      `SELECT count(*)::int AS count FROM city_gold_ledger`
    )).resolves.toMatchObject({ rows: [{ count: 2 }] });
  });
});

function requireStabilityAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    parsed.pathname.slice(1) !== "ash_atlas_stability"
  ) {
    throw new Error(
      "MIGRATION_RUNNER_TEST_ADMIN_URL must target local ash_atlas_stability"
    );
  }
  return parsed;
}

function quotedDatabase(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error(`Unsafe disposable database name: ${value}`);
  }
  return `"${value}"`;
}
