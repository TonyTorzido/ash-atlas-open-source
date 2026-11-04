
import { spawnSync } from "node:child_process";

const DEFAULT_SEEDS = Array.from({ length: 10 }, (_, index) => 600_001 + index);

function propertySeeds(value) {
  if (value === undefined || value.trim() === "") return DEFAULT_SEEDS;
  const seeds = value.split(",").map((entry) => {
    const trimmed = entry.trim();
    const seed = Number(trimmed);
    if (!Number.isSafeInteger(seed) || seed <= 0) {
      throw new Error(`MARKET_PROPERTY_SEEDS contains an invalid seed: ${JSON.stringify(trimmed)}`);
    }
    return seed;
  });
  if (seeds.length === 0 || new Set(seeds).size !== seeds.length) {
    throw new Error("MARKET_PROPERTY_SEEDS must contain distinct positive safe integers");
  }
  return seeds;
}

function main() {
  if (!process.env.MARKET_TEST_DATABASE_URL) {
    throw new Error("Set MARKET_TEST_DATABASE_URL to a dedicated *_test or *_validation database");
  }
  const pnpmCli = process.env.npm_execpath;
  if (!pnpmCli) throw new Error("Run this matrix through pnpm so npm_execpath is available");

  const seeds = propertySeeds(process.env.MARKET_PROPERTY_SEEDS);
  for (const seed of seeds) {
    process.stdout.write(`\n=== market property seed ${seed} ===\n`);
    const result = spawnSync(
      process.execPath,
      [pnpmCli, "test:market:property", "--", "--reporter=verbose"],
      {
        env: { ...process.env, MARKET_PROPERTY_SEED: String(seed) },
        stdio: "inherit"
      }
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      process.stderr.write(
        `Property seed ${seed} failed. Reproduce with MARKET_PROPERTY_SEED=${seed} pnpm test:market:property\n`
      );
      process.exitCode = result.status ?? 1;
      return;
    }
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
