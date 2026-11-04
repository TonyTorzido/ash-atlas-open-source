import { fileURLToPath } from "node:url";
import path from "node:path";

import pg from "pg";

import { runMigrations } from "../db/migrate.js";
import { assertSafeMarketHarnessDatabaseUrl } from "./marketHarness.js";

const { Pool } = pg;

type MigrationRow = {
  version: string;
};

export async function verifyFreshMarketMigrations(databaseUrl: string): Promise<{
  ok: true;
  database: string;
  initiallyApplied: number;
  firstRun: string[];
  secondRun: string[];
  installed: string[];
}> {
  const database = assertSafeMarketHarnessDatabaseUrl(databaseUrl);
  const before = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const schemaMigrationsExists = await before.query<{ exists: boolean }>(
      "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists"
    );
    if (schemaMigrationsExists.rows[0]?.exists) {
      const initial = await before.query<{ count: string }>("SELECT count(*)::text AS count FROM schema_migrations");
      const initiallyApplied = Number(initial.rows[0]?.count ?? "0");
      if (initiallyApplied !== 0) {
        throw new Error(
          `Fresh migration verification requires an empty migration history; found ${initiallyApplied} applied migration(s)`
        );
      }
    }
  } finally {
    await before.end();
  }

  const firstRun = await runMigrations(databaseUrl);
  if (firstRun.length === 0) {
    throw new Error("Fresh migration verification did not apply any migrations");
  }
  const secondRun = await runMigrations(databaseUrl);
  if (secondRun.length !== 0) {
    throw new Error(`Migration rerun unexpectedly applied: ${secondRun.join(", ")}`);
  }

  const after = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const installedResult = await after.query<MigrationRow>(
      "SELECT version FROM schema_migrations ORDER BY version"
    );
    const installed = installedResult.rows.map((row) => row.version);
    for (const migration of firstRun) {
      if (!installed.includes(migration)) {
        throw new Error(`Applied migration ${migration} is missing from schema_migrations`);
      }
    }
    return {
      ok: true,
      database,
      initiallyApplied: 0,
      firstRun,
      secondRun,
      installed
    };
  } finally {
    await after.end();
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.MARKET_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("Set MARKET_TEST_DATABASE_URL or DATABASE_URL to a dedicated *_test or *_validation database");
  }
  const report = await verifyFreshMarketMigrations(databaseUrl);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
