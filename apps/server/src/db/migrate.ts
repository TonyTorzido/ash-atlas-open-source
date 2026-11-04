import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type pg from "pg";

import { createPool } from "./pool.js";

export const MIGRATION_LOCK_NAME = "ash-atlas-schema-migrations-v1";
export const MIGRATION_HASH_BASELINE_CONFIRMATION = "confirm-current-files";
// A pending migration carrying this exact line opts its release out of the all-or-nothing batch:
// the deploy then applies that release's migrations one transaction per file (legacy mode).
export const MIGRATION_NON_TRANSACTIONAL_DIRECTIVE = "-- ash-atlas-migration: allow-non-transactional";

// "per_file": each migration commits on its own and the run stops at the first failure.
// "batch": every pending migration and its ledger row commit together, or nothing commits.
export type MigrationTransactionMode = "per_file" | "batch";

type MigrationFile = {
  version: string;
  sql: string;
  contentSha256: string;
};

type MigrationLedgerRow = {
  version: string;
  content_sha256: string | null;
};

export type MigrationRunOptions = {
  allowHashBaseline?: boolean;
  migrationsDirectory?: string;
  transaction?: MigrationTransactionMode;
  onBaseline?: (entries: ReadonlyArray<{ version: string; contentSha256: string }>) => void;
};

async function findRepoRoot(start = process.cwd()): Promise<string> {
  let current = start;
  for (;;) {
    try {
      await readFile(path.join(current, "pnpm-workspace.yaml"), "utf8");
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        throw new Error("Could not find pnpm-workspace.yaml from current directory");
      }
      current = parent;
    }
  }
}

export function migrationContentSha256(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

async function loadMigrationFiles(directory: string): Promise<MigrationFile[]> {
  const names = (await readdir(directory))
    .filter((file) => file.endsWith(".sql"))
    .sort(compareMigrationVersions);
  return Promise.all(names.map(async (version) => {
    const sql = await readFile(path.join(directory, version), "utf8");
    return { version, sql, contentSha256: migrationContentSha256(sql) };
  }));
}

function compareMigrationVersions(left: string, right: string): number {
  const closedTestOrder = new Map([
    ["0681_closed_test_telemetry.sql", 0],
    ["0682_closed_test_telemetry_health.sql", 1],
    ["0680_closed_test_access_onboarding.sql", 2]
  ]);
  const leftOrder = closedTestOrder.get(left);
  const rightOrder = closedTestOrder.get(right);
  if (leftOrder !== undefined && rightOrder !== undefined) {
    return leftOrder - rightOrder;
  }
  if (left === "0680_closed_test_access_onboarding.sql") {
    return right.startsWith("068") ? -1 : left.localeCompare(right);
  }
  if (right === "0680_closed_test_access_onboarding.sql") {
    return left.startsWith("068") ? 1 : left.localeCompare(right);
  }
  return left.localeCompare(right);
}

export async function runMigrations(
  databaseUrl: string,
  options: MigrationRunOptions = {}
): Promise<string[]> {
  const migrationsDirectory = options.migrationsDirectory ?? path.join(await findRepoRoot(), "db", "migrations");
  const files = await loadMigrationFiles(migrationsDirectory);
  const filesByVersion = new Map(files.map((file) => [file.version, file]));
  const pool = createPool({ databaseUrl: databaseUrl });
  const applied: string[] = [];
  let client: pg.PoolClient | undefined;
  let locked = false;
  let failure: unknown;
  try {
    client = await pool.connect();
    await client.query(
      "SELECT pg_advisory_lock(hashtextextended($1, 0))",
      [MIGRATION_LOCK_NAME]
    );
    locked = true;

    await initializeMigrationLedger(client);
    const ledger = await client.query<MigrationLedgerRow>(
      "SELECT version, content_sha256 FROM schema_migrations ORDER BY version"
    );
    const recorded = new Map<string, string>();
    const baseline: Array<{ version: string; contentSha256: string }> = [];
    for (const row of ledger.rows) {
      const file = filesByVersion.get(row.version);
      if (!file) {
        throw new Error(
          `Applied migration ${row.version} has no matching local SQL file; refusing to continue`
        );
      }
      if (row.content_sha256 === null) {
        baseline.push({ version: row.version, contentSha256: file.contentSha256 });
        continue;
      }
      if (row.content_sha256 !== file.contentSha256) {
        throw migrationHashMismatch(row.version, row.content_sha256, file.contentSha256);
      }
      recorded.set(row.version, row.content_sha256);
    }

    if (baseline.length > 0) {
      if (!options.allowHashBaseline) {
        throw new Error(
          `${baseline.length} applied migration(s) predate content hashes. ` +
          `Run the one-time audited baseline with MIGRATION_HASH_BASELINE=${MIGRATION_HASH_BASELINE_CONFIRMATION}`
        );
      }
      await baselineMigrationHashes(client, baseline);
      for (const entry of baseline) recorded.set(entry.version, entry.contentSha256);
      (options.onBaseline ?? logMigrationBaseline)(baseline);
    }

    await enforceMigrationHashConstraints(client);
    if (options.transaction === "batch") {
      const pending = files.filter((file) => !recorded.has(file.version));
      if (pending.length > 0) {
        const versionNumber = await client.query<{ version: number }>(
          "SELECT current_setting('server_version_num')::integer AS version"
        );
        assertBatchTransactionSafe(pending, {
          enumAddValueInTransaction: (versionNumber.rows[0]?.version ?? 0) >= 120000
        });
        await applyMigrationBatch(client, pending);
        applied.push(...pending.map((file) => file.version));
      }
    } else {
      for (const file of files) {
        const recordedHash = recorded.get(file.version);
        if (recordedHash !== undefined) {
          if (recordedHash !== file.contentSha256) {
            throw migrationHashMismatch(file.version, recordedHash, file.contentSha256);
          }
          continue;
        }
        await applyMigration(client, file);
        recorded.set(file.version, file.contentSha256);
        applied.push(file.version);
      }
    }
  } catch (error) {
    failure = error;
  }
  if (client && locked) {
    try {
      const unlocked = await client.query<{ unlocked: boolean }>(
        "SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked",
        [MIGRATION_LOCK_NAME]
      );
      if (unlocked.rows[0]?.unlocked !== true && failure === undefined) {
        failure = new Error("Migration advisory lock was not held at release time");
      }
    } catch (error) {
      if (failure === undefined) failure = error;
    }
  }
  client?.release();
  try {
    await pool.end();
  } catch (error) {
    if (failure === undefined) failure = error;
  }
  if (failure !== undefined) throw failure;

  return applied;
}

async function initializeMigrationLedger(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query(
    "ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS content_sha256 text"
  );
}

async function baselineMigrationHashes(
  client: pg.PoolClient,
  entries: ReadonlyArray<{ version: string; contentSha256: string }>
): Promise<void> {
  await client.query("BEGIN");
  try {
    for (const entry of entries) {
      const updated = await client.query(
        `UPDATE schema_migrations
         SET content_sha256 = $2
         WHERE version = $1 AND content_sha256 IS NULL`,
        [entry.version, entry.contentSha256]
      );
      if (updated.rowCount !== 1) {
        throw new Error(`Migration hash baseline lost ownership of ${entry.version}`);
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function enforceMigrationHashConstraints(client: pg.PoolClient): Promise<void> {
  await client.query("ALTER TABLE schema_migrations ALTER COLUMN content_sha256 SET NOT NULL");
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'schema_migrations'::regclass
          AND conname = 'schema_migrations_content_sha256_check'
      ) THEN
        ALTER TABLE schema_migrations
          ADD CONSTRAINT schema_migrations_content_sha256_check
          CHECK (content_sha256 ~ '^[a-f0-9]{64}$');
      END IF;
    END
    $$
  `);
}

async function applyMigration(client: pg.PoolClient, file: MigrationFile): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(file.sql);
    await client.query(
      "INSERT INTO schema_migrations(version, content_sha256) VALUES ($1, $2)",
      [file.version, file.contentSha256]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function applyMigrationBatch(
  client: pg.PoolClient,
  files: ReadonlyArray<MigrationFile>
): Promise<void> {
  await client.query("BEGIN");
  try {
    for (const file of files) {
      await client.query(file.sql);
      // A SAVEPOINT fails outside a transaction block, so this catches a file that ended the batch.
      try {
        await client.query("SAVEPOINT ash_atlas_migration_batch_probe");
        await client.query("RELEASE SAVEPOINT ash_atlas_migration_batch_probe");
      } catch {
        throw new Error(`Migration ${file.version} ended the batch transaction; refusing to continue`);
      }
      await client.query(
        "INSERT INTO schema_migrations(version, content_sha256) VALUES ($1, $2)",
        [file.version, file.contentSha256]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

const NON_TRANSACTIONAL_STATEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(begin|start transaction|commit|end|rollback|abort|prepare transaction)\b/, "transaction control"],
  [/^vacuum\b/, "VACUUM"],
  [/^alter system\b/, "ALTER SYSTEM"],
  [/^(create|drop) (database|tablespace)\b/, "CREATE/DROP DATABASE or TABLESPACE"],
  [/^(create|alter|drop) subscription\b/, "SUBSCRIPTION"],
  [/^reindex\b.*\b(database|system|concurrently)\b/, "REINDEX DATABASE/SYSTEM/CONCURRENTLY"],
  [/\bindex concurrently\b/, "CREATE/DROP INDEX CONCURRENTLY"],
  [/\bdetach partition\b.*\bconcurrently\b/, "DETACH PARTITION CONCURRENTLY"]
];

/**
 * Top-level statements PostgreSQL refuses inside a transaction block, plus explicit transaction
 * control that would end the batch early. Comments, literals and dollar-quoted bodies are ignored.
 */
export function nonTransactionalStatements(
  sql: string,
  options: { enumAddValueInTransaction: boolean }
): string[] {
  const found = new Set<string>();
  for (const raw of stripSqlLiteralsAndComments(sql).split(";")) {
    const statement = raw.trim().replace(/\s+/g, " ").toLowerCase();
    if (!statement) continue;
    for (const [pattern, label] of NON_TRANSACTIONAL_STATEMENTS) {
      if (pattern.test(statement)) found.add(label);
    }
    if (!options.enumAddValueInTransaction && /^alter type\b.*\badd value\b/.test(statement)) {
      found.add("ALTER TYPE ... ADD VALUE (PostgreSQL before 12)");
    }
  }
  return [...found];
}

function assertBatchTransactionSafe(
  files: ReadonlyArray<MigrationFile>,
  options: { enumAddValueInTransaction: boolean }
): void {
  const unsafe = files.flatMap((file) => {
    const found = nonTransactionalStatements(file.sql, options);
    return found.length > 0 ? [`${file.version} (${found.join(", ")})`] : [];
  });
  if (unsafe.length > 0) {
    throw new Error(
      `Pending migration(s) cannot run in one all-or-nothing transaction: ${unsafe.join("; ")}. ` +
      `Add the line "${MIGRATION_NON_TRANSACTIONAL_DIRECTIVE}" to opt the release into per-file transactions`
    );
  }
}

function stripSqlLiteralsAndComments(sql: string): string {
  let output = "";
  let index = 0;
  while (index < sql.length) {
    const char = sql[index]!;
    const next = sql[index + 1];
    if (char === "-" && next === "-") {
      const end = sql.indexOf("\n", index);
      index = end === -1 ? sql.length : end;
      output += " ";
    } else if (char === "/" && next === "*") {
      let depth = 1;
      index += 2;
      while (index < sql.length && depth > 0) {
        if (sql[index] === "/" && sql[index + 1] === "*") { depth += 1; index += 2; }
        else if (sql[index] === "*" && sql[index + 1] === "/") { depth -= 1; index += 2; }
        else index += 1;
      }
      output += " ";
    } else if (char === "'" || char === "\"") {
      const escapes = char === "'" && /[eE]/.test(sql[index - 1] ?? "") &&
        !/[A-Za-z0-9_]/.test(sql[index - 2] ?? "");
      index += 1;
      while (index < sql.length) {
        if (escapes && sql[index] === "\\") { index += 2; continue; }
        if (sql[index] === char) {
          if (sql[index + 1] === char) { index += 2; continue; }
          index += 1;
          break;
        }
        index += 1;
      }
      output += " ";
    } else if (char === "$" && !/[A-Za-z0-9_$]/.test(sql[index - 1] ?? "")) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index))?.[0];
      if (!tag) {
        output += char;
        index += 1;
        continue;
      }
      const end = sql.indexOf(tag, index + tag.length);
      index = end === -1 ? sql.length : end + tag.length;
      output += " ";
    } else {
      output += char;
      index += 1;
    }
  }
  return output;
}

function migrationHashMismatch(version: string, recorded: string, actual: string): Error {
  return new Error(
    `Historical migration ${version} content hash mismatch: recorded ${recorded}, local ${actual}`
  );
}

function logMigrationBaseline(
  entries: ReadonlyArray<{ version: string; contentSha256: string }>
): void {
  console.warn(JSON.stringify({
    event: "migration_hash_baseline",
    warning: "one-time trust initialization for previously applied migration files",
    count: entries.length,
    migrations: entries
  }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const allowHashBaseline =
    process.env.MIGRATION_HASH_BASELINE === MIGRATION_HASH_BASELINE_CONFIRMATION;
  const transaction = process.env.MIGRATION_TRANSACTION ?? "per_file";
  if (transaction !== "per_file" && transaction !== "batch") {
    throw new Error("MIGRATION_TRANSACTION must be per_file or batch");
  }
  // The deploy rehearsal rebuilds its template from only the migrations Main has applied.
  const migrationsDirectory = process.env.MIGRATIONS_DIRECTORY;
  runMigrations(databaseUrl, {
    allowHashBaseline,
    transaction,
    ...(migrationsDirectory ? { migrationsDirectory } : {})
  })
    .then((applied) => {
      console.log(
        JSON.stringify(
          {
            ok: true,
            transaction,
            applied
          },
          null,
          2
        )
      );
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
