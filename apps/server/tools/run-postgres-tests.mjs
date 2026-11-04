import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

import pg from "pg";

const { Client } = pg;
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");
const serverSource = path.join(repositoryRoot, "apps/server/src");
const adminUrl = requireDisposableAdminUrl(process.env.POSTGRES_TEST_ADMIN_URL);
const templateDatabase = `ash_atlas_stability_ci_template_${process.pid}`;
const blankDatabaseTests = new Set([
  "apps/server/src/db/marketExpiredGoldClaimMigration.integration.test.ts",
  "apps/server/src/game/gameplayEnvironmentProfileStore.integration.test.ts",
  "apps/server/src/game/fieldConsumables.integration.test.ts",
]);
const createdDatabases = new Set();
const databaseUrlVariables = [
  "ACTIVE_RUNTIME_TEST_DATABASE_URL",
  "BALSAM_RESIN_TEST_DATABASE_URL",
  "CHAT_MIGRATION_TEST_DATABASE_URL",
  "CHAT_TEST_DATABASE_URL",
  "DEATH_DROP_TEST_DATABASE_URL",
  "COMBAT_REWARD_TEST_DATABASE_URL",
  "DEVELOPER_AUTH_TEST_DATABASE_URL",
  "DIRECT_MESSAGE_TEST_DATABASE_URL",
  "ENVIRONMENT_POPULATION_TEST_DATABASE_URL",
  "FLAG_CONSTRUCTION_TEST_DATABASE_URL",
  "FLAG_DOMAIN_TEST_DATABASE_URL",
  "FLAG_ENVIRONMENT_TEST_DATABASE_URL",
  "FLAG_PLACEMENT_TEST_DATABASE_URL",
  "FLAG_RESOURCE_TEST_DATABASE_URL",
  "GREENHOUSE_TEST_DATABASE_URL",
  "INBOX_READ_TEST_DATABASE_URL",
  "KINGDOM_TEST_DATABASE_URL",
  "LAND_BONUS_TEST_DATABASE_URL",
  "MANOR_TEST_DATABASE_URL",
  "MARKET_TEST_DATABASE_URL",
  "MASTERY_TEST_DATABASE_URL",
  "PET_TEST_DATABASE_URL",
  "PROFILE_TEST_DATABASE_URL",
  "REPEATABLE_RESOURCE_TEST_DATABASE_URL",
  "RESOURCE_JOBS_TEST_DATABASE_URL",
  "RESET_TEST_DATABASE_URL",
  "SETTLEMENT_TEST_DATABASE_URL",
  "TERRITORY_COLLAPSE_TEST_DATABASE_URL",
  "TEST_DATABASE_URL",
  "TRAVEL_HUNGER_TEST_DATABASE_URL",
  "TRAVEL_INVITES_TEST_DATABASE_URL",
  "WAR_STRUCTURES_TEST_DATABASE_URL",
  "WATER_CADENCE_TEST_DATABASE_URL",
  "WORLD_ENVIRONMENT_PROFILE_TEST_DATABASE_URL"
];
const adminUrlVariables = [
  "CARRY_PATHS_TEST_ADMIN_URL",
  "EQUIPMENT_TEST_ADMIN_URL",
  "FISHING_UNRESOLVED_WATER_IDS_MIGRATION_TEST_ADMIN_URL",
  "FLAG_ACCESS_TEST_ADMIN_URL",
  "MIGRATION_RUNNER_TEST_ADMIN_URL",
  "PARTY_INVITE_OPERATION_MIGRATION_TEST_ADMIN_URL",
  "PARTY_SLOTS_MIGRATION_TEST_ADMIN_URL",
  "PET_MIGRATION_TEST_ADMIN_URL",
  "PLAYER_PACKAGE_TEST_ADMIN_URL",
  "UNIVERSAL_LOCATION_MIGRATION_TEST_ADMIN_URL",
  "WARRIOR_V3_MIGRATION_TEST_ADMIN_URL",
  "LAUNCH_CLASS_V1_TEST_ADMIN_URL",
  "DAMAGE_MATRIX_V1_TEST_ADMIN_URL",
  "XORAL_MIGRATION_TEST_ADMIN_URL"
];

try {
  await createDatabase(templateDatabase);
  createdDatabases.add(templateDatabase);
  await runPnpm(["db:migrate"], {
    DATABASE_URL: databaseUrl(templateDatabase)
  });

  const files = (await integrationTestFiles(serverSource)).sort();
  await assertEnvironmentCoverage(files);
  const failures = [];
  for (const [index, file] of files.entries()) {
    const relativeFile = path.relative(repositoryRoot, file).replaceAll("\\", "/");
    const suffix = createHash("sha256").update(file).digest("hex").slice(0, 12);
    const database = `ash_atlas_stability_ci_${suffix}_test`;
    await createDatabase(database, blankDatabaseTests.has(relativeFile) ? undefined : templateDatabase);
    createdDatabases.add(database);
    const url = databaseUrl(database);
    process.stdout.write(`[postgres ${index + 1}/${files.length}] ${relativeFile}\n`);
    try {
      await runPnpm([
        "--filter",
        "@ash-atlas/server",
        "exec",
        "vitest",
        "run",
        path.relative(path.join(repositoryRoot, "apps/server"), file).replaceAll("\\", "/"),
        "--no-file-parallelism",
        "--maxWorkers=1"
      ], databaseTestEnvironment(url));
    } catch (error) {
      failures.push(`${relativeFile}: ${String(error)}`);
    } finally {
      await dropDatabase(database);
      createdDatabases.delete(database);
    }
  }
  if (failures.length > 0) {
    throw new Error(`PostgreSQL suites failed:\n${failures.join("\n")}`);
  }
} finally {
  for (const database of [...createdDatabases].reverse()) {
    await dropDatabase(database).catch((error) => {
      process.stderr.write(`failed to remove ${database}: ${String(error)}\n`);
    });
  }
}

async function integrationTestFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await integrationTestFiles(absolute));
    if (entry.isFile() && entry.name.endsWith(".integration.test.ts")) files.push(absolute);
  }
  return files;
}

function databaseTestEnvironment(url) {
  const environment = Object.fromEntries(databaseUrlVariables.map((name) => [name, url]));
  for (const name of adminUrlVariables) {
    environment[name] = adminUrl.toString();
  }
  return { ...environment, DATABASE_URL: url, NODE_ENV: "test" };
}

async function assertEnvironmentCoverage(files) {
  const configured = new Set([...databaseUrlVariables, ...adminUrlVariables]);
  const uncovered = new Set();
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/process\.env\.([A-Z0-9_]+)/gu)) {
      const name = match[1];
      if (name.endsWith("_DATABASE_URL") || name.endsWith("_ADMIN_URL")) {
        if (!configured.has(name)) uncovered.add(name);
      }
    }
  }
  if (uncovered.size > 0) {
    throw new Error(`PostgreSQL test environment is missing: ${[...uncovered].sort().join(", ")}`);
  }
}

async function createDatabase(database, template) {
  assertDisposableName(database);
  const client = new Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    const templateClause = template ? ` TEMPLATE ${quotedIdentifier(template)}` : "";
    await client.query(`CREATE DATABASE ${quotedIdentifier(database)}${templateClause}`);
  } finally {
    await client.end();
  }
}

async function dropDatabase(database) {
  assertDisposableName(database);
  const client = new Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${quotedIdentifier(database)} WITH (FORCE)`);
    const remaining = await client.query(
      "SELECT count(*)::int AS count FROM pg_database WHERE datname = $1",
      [database]
    );
    if (remaining.rows[0]?.count !== 0) throw new Error(`${database} was not removed`);
  } finally {
    await client.end();
  }
}

function databaseUrl(database) {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

function requireDisposableAdminUrl(value) {
  if (!value) throw new Error("POSTGRES_TEST_ADMIN_URL is required");
  const url = new URL(value);
  const database = url.pathname.slice(1);
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error("PostgreSQL CI tests require a local disposable server");
  }
  if (database !== "ash_atlas_stability") {
    throw new Error("POSTGRES_TEST_ADMIN_URL must name ash_atlas_stability");
  }
  return url;
}

function assertDisposableName(database) {
  if (!/^ash_atlas_stability_ci_[a-z0-9_]+$/u.test(database)) {
    throw new Error(`unsafe disposable database name ${database}`);
  }
}

function quotedIdentifier(value) {
  assertDisposableName(value);
  return `"${value}"`;
}

function runPnpm(arguments_, extraEnvironment) {
  return new Promise((resolve, reject) => {
    const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    const child = spawn(command, arguments_, {
      cwd: repositoryRoot,
      env: { ...process.env, ...extraEnvironment },
      shell: process.platform === "win32",
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`pnpm exited with ${code ?? signal ?? "unknown status"}`));
    });
  });
}
