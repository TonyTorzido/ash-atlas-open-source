import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assertSafeMarketHarnessDatabaseUrl,
  runMarketHarness,
  type MarketHarnessOptions
} from "./marketHarness.js";

export async function runMarketHarnessCli(
  argv = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const values = parseArguments(argv);
  const databaseUrl =
    values.databaseUrl ??
    env.MARKET_HARNESS_DATABASE_URL ??
    env.MARKET_TEST_DATABASE_URL ??
    env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "Set MARKET_HARNESS_DATABASE_URL, MARKET_TEST_DATABASE_URL, or DATABASE_URL to a dedicated *_test or *_validation database"
    );
  }
  assertSafeMarketHarnessDatabaseUrl(databaseUrl);
  const mode = values.mode ?? parseMode(env.MARKET_HARNESS_MODE ?? "stress");
  const options: MarketHarnessOptions = {
    databaseUrl,
    mode,
    seed: values.seed ?? env.MARKET_HARNESS_SEED ?? "ash-atlas-market-stress-v1",
    playerCount: values.playerCount ?? envInteger(env.MARKET_HARNESS_PLAYERS, 24, "MARKET_HARNESS_PLAYERS"),
    concurrency: values.concurrency ?? envInteger(env.MARKET_HARNESS_CONCURRENCY, 16, "MARKET_HARNESS_CONCURRENCY"),
    operationCount: values.operationCount ?? (
      mode === "stress"
        ? envInteger(env.MARKET_HARNESS_OPERATIONS, 5_000, "MARKET_HARNESS_OPERATIONS")
        : optionalEnvInteger(env.MARKET_HARNESS_OPERATIONS, "MARKET_HARNESS_OPERATIONS")
    ),
    durationMs: values.durationMs ?? (
      mode === "soak"
        ? envNumber(env.MARKET_HARNESS_DURATION_SECONDS, 3_600, "MARKET_HARNESS_DURATION_SECONDS") * 1_000
        : null
    ),
    reconcileEvery: values.reconcileEvery ??
      envInteger(env.MARKET_HARNESS_RECONCILE_EVERY, 500, "MARKET_HARNESS_RECONCILE_EVERY"),
    hotItemRatio: values.hotItemRatio ??
      envNumber(env.MARKET_HARNESS_HOT_ITEM_RATIO, 0.7, "MARKET_HARNESS_HOT_ITEM_RATIO"),
    goldPerPlayer: BigInt(values.goldPerPlayer ?? env.MARKET_HARNESS_GOLD_PER_PLAYER ?? "10000000000"),
    itemUnitsPerPlayer: values.itemUnitsPerPlayer ??
      envInteger(env.MARKET_HARNESS_ITEM_UNITS_PER_PLAYER, 1_000_000, "MARKET_HARNESS_ITEM_UNITS_PER_PLAYER")
  };
  const report = await runMarketHarness(options, env);
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (values.reportPath) {
    const reportPath = path.resolve(values.reportPath);
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, serialized, "utf8");
  }
  if (!values.quiet) process.stdout.write(serialized);
  return report.ok ? 0 : 1;
}

type ParsedArguments = Partial<{
  databaseUrl: string;
  mode: "stress" | "soak";
  seed: string;
  playerCount: number;
  concurrency: number;
  operationCount: number;
  durationMs: number;
  reconcileEvery: number;
  hotItemRatio: number;
  goldPerPlayer: string;
  itemUnitsPerPlayer: number;
  reportPath: string;
  quiet: boolean;
}>;

function parseArguments(argv: string[]): ParsedArguments {
  const parsed: ParsedArguments = {};
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index]!;
    const separator = raw.indexOf("=");
    const key = separator >= 0 ? raw.slice(0, separator) : raw;
    if (key === "--quiet") {
      parsed.quiet = true;
      continue;
    }
    const inline = separator >= 0 ? raw.slice(separator + 1) : null;
    const value = inline ?? argv[++index];
    if (!key.startsWith("--") || value === undefined) {
      throw new Error(`Invalid market harness argument: ${raw}\n${usage()}`);
    }
    switch (key) {
      case "--database-url":
        parsed.databaseUrl = value;
        break;
      case "--mode":
        parsed.mode = parseMode(value);
        break;
      case "--seed":
        parsed.seed = value;
        break;
      case "--players":
        parsed.playerCount = positiveInteger(value, key);
        break;
      case "--concurrency":
        parsed.concurrency = positiveInteger(value, key);
        break;
      case "--operations":
        parsed.operationCount = positiveInteger(value, key);
        break;
      case "--duration-seconds":
        parsed.durationMs = positiveNumber(value, key) * 1_000;
        break;
      case "--reconcile-every":
        parsed.reconcileEvery = positiveInteger(value, key);
        break;
      case "--hot-item-ratio":
        parsed.hotItemRatio = finiteNumber(value, key);
        break;
      case "--gold-per-player":
        if (!/^[1-9]\d*$/.test(value)) throw new Error(`${key} must be a positive integer`);
        parsed.goldPerPlayer = value;
        break;
      case "--item-units-per-player":
        parsed.itemUnitsPerPlayer = positiveInteger(value, key);
        break;
      case "--report":
        parsed.reportPath = value;
        break;
      default:
        throw new Error(`Unknown market harness option: ${key}\n${usage()}`);
    }
  }
  return parsed;
}

function parseMode(value: string): "stress" | "soak" {
  if (value !== "stress" && value !== "soak") throw new Error("Market harness mode must be stress or soak");
  return value;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function positiveNumber(value: string, name: string): number {
  const parsed = finiteNumber(value, name);
  if (parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
}

function finiteNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be finite`);
  return parsed;
}

function envInteger(value: string | undefined, fallback: number, name: string): number {
  return value === undefined ? fallback : positiveInteger(value, name);
}

function optionalEnvInteger(value: string | undefined, name: string): number | null {
  return value === undefined || value === "" ? null : positiveInteger(value, name);
}

function envNumber(value: string | undefined, fallback: number, name: string): number {
  return value === undefined ? fallback : positiveNumber(value, name);
}

function usage(): string {
  return [
    "Usage: pnpm --filter @ash-atlas/server market:stress -- [options]",
    "       pnpm --filter @ash-atlas/server market:soak -- [options]",
    "",
    "The selected PostgreSQL database name must end in _test or _validation.",
    "The harness migrates, resets, and seeds that dedicated database before running.",
    "",
    "Options:",
    "  --database-url URL          Dedicated PostgreSQL URL (or set MARKET_HARNESS_DATABASE_URL).",
    "  --mode stress|soak          Fixed-operation or duration mode.",
    "  --seed TEXT                 Deterministic intent seed.",
    "  --players N                 Seeded authenticated actors (default 24).",
    "  --concurrency N             Concurrent workers (default 16).",
    "  --operations N              Fixed operation count; stress default is 5000.",
    "  --duration-seconds N        Duration for soak mode; default is 3600 seconds.",
    "  --reconcile-every N         Run live reconciliation every N operations (default 500).",
    "  --hot-item-ratio N          Fraction targeting the hot ore book, 0 through 1 (default 0.7).",
    "  --gold-per-player N         Audited starting wallet gold.",
    "  --item-units-per-player N   Audited starting units of every resource.",
    "  --report PATH               Write the aggregate JSON report to PATH.",
    "  --quiet                     Suppress JSON stdout (requires no value).",
    "  --help                      Show this help."
  ].join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runMarketHarnessCli()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 2;
    });
}
