import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { MIGRATION_NON_TRANSACTIONAL_DIRECTIVE, runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;

describeDatabase("serialized migration runner PostgreSQL integration", () => {
  const databaseName = `ash_atlas_stability_migration_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  let migrationsDirectory = "";
  let migrationPath = "";
  let databaseUrl = "";

  beforeAll(async () => {
    const parsed = assertStabilityLabAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    migrationsDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-stability-migrations-"));
    migrationPath = path.join(migrationsDirectory, "0001_serialized_probe.sql");
    await writeFile(
      migrationPath,
      "SELECT pg_sleep(0.25);\nCREATE TABLE serialized_migration_probe (id integer PRIMARY KEY);\n",
      "utf8"
    );
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  }, 15_000);

  afterAll(async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (migrationsDirectory) await rm(migrationsDirectory, { recursive: true, force: true });
  });

  it("serializes two runners so one applies and the waiter reports no work", async () => {
    const results = await Promise.all([
      runMigrations(databaseUrl, { migrationsDirectory }),
      runMigrations(databaseUrl, { migrationsDirectory })
    ]);
    expect(results).toContainEqual(["0001_serialized_probe.sql"]);
    expect(results).toContainEqual([]);

    const verification = new DisposableTestPool({ connectionString: databaseUrl, max: 1 });
    try {
      const ledger = await verification.query<{
        version: string;
        content_sha256: string;
      }>("SELECT version, content_sha256 FROM schema_migrations");
      expect(ledger.rows).toEqual([
        {
          version: "0001_serialized_probe.sql",
          content_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) as string
        }
      ]);
      await expect(
        verification.query("SELECT count(*)::int AS count FROM serialized_migration_probe")
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    } finally {
      await verification.end();
    }
  }, 15_000);

  it("rejects changed historical SQL before executing it", async () => {
    await writeFile(
      migrationPath,
      "SELECT pg_sleep(0.25);\nCREATE TABLE serialized_migration_probe (id bigint PRIMARY KEY);\n",
      "utf8"
    );
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).rejects.toThrow(
      /Historical migration 0001_serialized_probe\.sql content hash mismatch/
    );
  });
});

describeDatabase("closed-test migration ordering", () => {
  const databaseName = `ash_atlas_stability_migration_order_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  let migrationsDirectory = "";
  let databaseUrl = "";

  beforeAll(async () => {
    const parsed = assertStabilityLabAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    migrationsDirectory = await mkdtemp(
      path.join(tmpdir(), "ash-atlas-stability-migration-order-")
    );
    await Promise.all([
      writeFile(
        path.join(migrationsDirectory, "0681_closed_test_telemetry.sql"),
        `CREATE TABLE closed_test_migration_order (
           sequence integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
           version text NOT NULL UNIQUE
         );
         INSERT INTO closed_test_migration_order (version)
         VALUES ('0681_closed_test_telemetry.sql');`,
        "utf8"
      ),
      writeFile(
        path.join(migrationsDirectory, "0682_closed_test_telemetry_health.sql"),
        `INSERT INTO closed_test_migration_order (version)
         VALUES ('0682_closed_test_telemetry_health.sql');`,
        "utf8"
      ),
      writeFile(
        path.join(migrationsDirectory, "0680_closed_test_access_onboarding.sql"),
        `INSERT INTO closed_test_migration_order (version)
         VALUES ('0680_closed_test_access_onboarding.sql');`,
        "utf8"
      )
    ]);
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  }, 15_000);

  afterAll(async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (migrationsDirectory) {
      await rm(migrationsDirectory, { recursive: true, force: true });
    }
  });

  it("discovers, hashes, and applies telemetry before onboarding exactly once", async () => {
    const expectedOrder = [
      "0681_closed_test_telemetry.sql",
      "0682_closed_test_telemetry_health.sql",
      "0680_closed_test_access_onboarding.sql"
    ];
    await expect(
      runMigrations(databaseUrl, { migrationsDirectory })
    ).resolves.toEqual(expectedOrder);

    const verification = new DisposableTestPool({ connectionString: databaseUrl, max: 1 });
    try {
      const executed = await verification.query<{ version: string }>(
        "SELECT version FROM closed_test_migration_order ORDER BY sequence"
      );
      expect(executed.rows.map(({ version }) => version)).toEqual(expectedOrder);

      const ledger = await verification.query<{
        version: string;
        content_sha256: string;
      }>(
        `SELECT version, content_sha256
         FROM schema_migrations
         ORDER BY version`
      );
      expect(ledger.rows.map(({ version }) => version)).toEqual(
        [...expectedOrder].sort()
      );
      expect(ledger.rows.every(
        ({ content_sha256 }) => /^[a-f0-9]{64}$/.test(content_sha256)
      )).toBe(true);
      expect(new Set(ledger.rows.map(({ content_sha256 }) => content_sha256)).size).toBe(3);
      await expect(
        runMigrations(databaseUrl, { migrationsDirectory })
      ).resolves.toEqual([]);
    } finally {
      await verification.end();
    }
  }, 15_000);
});

describeDatabase("batch migration transaction PostgreSQL integration", () => {
  const databaseName = `ash_atlas_stability_migration_batch_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  let migrationsDirectory = "";
  let databaseUrl = "";

  const writeMigration = (name: string, sql: string) =>
    writeFile(path.join(migrationsDirectory, name), sql, "utf8");
  const inspect = async () => {
    const verification = new DisposableTestPool({ connectionString: databaseUrl, max: 1 });
    try {
      const ledger = await verification.query<{ version: string }>(
        "SELECT version FROM schema_migrations ORDER BY version"
      );
      const columns = await verification.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'batch_probe' ORDER BY column_name`
      );
      const tables = await verification.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name LIKE 'batch_%' ORDER BY table_name`
      );
      return {
        ledger: ledger.rows.map(({ version }) => version),
        columns: columns.rows.map(({ column_name }) => column_name),
        tables: tables.rows.map(({ table_name }) => table_name)
      };
    } finally {
      await verification.end();
    }
  };

  beforeAll(async () => {
    const parsed = assertStabilityLabAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    migrationsDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-stability-migration-batch-"));
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    // Already-applied populated history the pending batch builds on.
    await writeMigration(
      "0001_batch_base.sql",
      "CREATE TABLE batch_probe (id integer PRIMARY KEY, label text);\n" +
      "INSERT INTO batch_probe (id, label) VALUES (1, NULL), (2, 'two');\n"
    );
    await expect(runMigrations(databaseUrl, { migrationsDirectory }))
      .resolves.toEqual(["0001_batch_base.sql"]);
  }, 15_000);

  afterAll(async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (migrationsDirectory) await rm(migrationsDirectory, { recursive: true, force: true });
  });

  it("rolls back every pending file when a later one fails on existing data", async () => {
    await writeMigration("0002_batch_column.sql", "ALTER TABLE batch_probe ADD COLUMN extra integer;\n");
    await writeMigration("0003_batch_table.sql", "CREATE TABLE batch_side (id integer);\n");
    await writeMigration(
      "0004_batch_not_null.sql",
      "ALTER TABLE batch_probe ALTER COLUMN label SET NOT NULL;\n"
    );
    await expect(runMigrations(databaseUrl, { migrationsDirectory, transaction: "batch" }))
      .rejects.toThrow(/label/);
    await expect(inspect()).resolves.toEqual({
      ledger: ["0001_batch_base.sql"],
      columns: ["id", "label"],
      tables: ["batch_probe"]
    });
  }, 15_000);

  it("commits every pending file and ledger row together once the data is fixed", async () => {
    await writeMigration(
      "0004_batch_not_null.sql",
      "UPDATE batch_probe SET label = 'filled' WHERE label IS NULL;\n" +
      "ALTER TABLE batch_probe ALTER COLUMN label SET NOT NULL;\n"
    );
    await expect(runMigrations(databaseUrl, { migrationsDirectory, transaction: "batch" }))
      .resolves.toEqual(["0002_batch_column.sql", "0003_batch_table.sql", "0004_batch_not_null.sql"]);
    await expect(inspect()).resolves.toEqual({
      ledger: [
        "0001_batch_base.sql",
        "0002_batch_column.sql",
        "0003_batch_table.sql",
        "0004_batch_not_null.sql"
      ],
      columns: ["extra", "id", "label"],
      tables: ["batch_probe", "batch_side"]
    });
  }, 15_000);

  it("refuses an opted-out file in batch mode and applies it in per-file mode", async () => {
    // The deploy selects per_file when a pending file carries the opt-out line.
    await writeMigration(
      "0005_batch_explicit_transaction.sql",
      `${MIGRATION_NON_TRANSACTIONAL_DIRECTIVE}\nBEGIN;\nCREATE TABLE batch_opt_out (id integer);\nCOMMIT;\n`
    );
    await expect(runMigrations(databaseUrl, { migrationsDirectory, transaction: "batch" }))
      .rejects.toThrow(/0005_batch_explicit_transaction\.sql \(transaction control\)/);
    expect((await inspect()).tables).not.toContain("batch_opt_out");
    await expect(runMigrations(databaseUrl, { migrationsDirectory, transaction: "per_file" }))
      .resolves.toEqual(["0005_batch_explicit_transaction.sql"]);
    const state = await inspect();
    expect(state.tables).toContain("batch_opt_out");
    expect(state.ledger).toContain("0005_batch_explicit_transaction.sql");
  }, 15_000);
});

function assertStabilityLabAdminUrl(value: string): URL {
  const parsed = new URL(value);
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    database !== "ash_atlas_stability"
  ) {
    throw new Error(
      "MIGRATION_RUNNER_TEST_ADMIN_URL must target the local stability lab ash_atlas_stability database"
    );
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}
