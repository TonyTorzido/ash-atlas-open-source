import { fileURLToPath } from "node:url";

import { loadConfig } from "../config.js";
import { createPool } from "../db/pool.js";
import {
  MarketReconciliationService,
  type MarketReconciliationFreezeMode
} from "../game/marketReconciliation.js";

type CliOptions = {
  recordCriticalAudit?: boolean;
  freezeOnFailure?: MarketReconciliationFreezeMode;
  honorAutomaticProtection?: boolean;
};

type ReconciliationCliMode = "read_only" | "audit" | "affected_books" | "global";

export async function runMarketReconciliationCli(
  argv = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  const options = parseOptions(argv);
  if (options === "help") {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const config = loadConfig(env);
  const pool = createPool({ databaseUrl: config.DATABASE_URL });
  try {
    const report = await new MarketReconciliationService(pool).reconcile(options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.ok ? 0 : 1;
  } finally {
    await pool.end();
  }
}

function parseOptions(argv: string[]): CliOptions | "help" {
  let selectedMode: ReconciliationCliMode | null = null;
  for (const argument of argv) {
    switch (argument) {
      case "--help":
      case "-h":
        return "help";
      case "--audit":
        selectedMode = selectMode(selectedMode, "audit");
        break;
      case "--freeze-books":
        selectedMode = selectMode(selectedMode, "affected_books");
        break;
      case "--freeze-global":
        selectedMode = selectMode(selectedMode, "global");
        break;
      case "--protect":
        selectedMode = selectMode(selectedMode, "affected_books");
        break;
      case "--read-only":
        selectedMode = selectMode(selectedMode, "read_only");
        break;
      default:
        throw new Error(`Unknown market reconciliation option: ${argument}\n${usage()}`);
    }
  }
  switch (selectedMode) {
    case "read_only":
      return { recordCriticalAudit: false, freezeOnFailure: "none", honorAutomaticProtection: false };
    case "audit":
      return { recordCriticalAudit: true, freezeOnFailure: "none", honorAutomaticProtection: false };
    case "affected_books":
      return { recordCriticalAudit: true, freezeOnFailure: "affected_books", honorAutomaticProtection: false };
    case "global":
      return { recordCriticalAudit: true, freezeOnFailure: "global", honorAutomaticProtection: false };
    default:
      return {};
  }
}

function selectMode(
  current: ReconciliationCliMode | null,
  next: ReconciliationCliMode
): ReconciliationCliMode {
  if (current && current !== next) {
    throw new Error("Choose only one reconciliation mode\n" + usage());
  }
  return next;
}

function usage(): string {
  return [
    "Usage: pnpm --filter @ash-atlas/server market:reconcile [options]",
    "",
    "With no options, the database auto-pause policy is honored (enabled by default).",
    "A mismatch exits 1 after any configured audit/freeze protection is committed.",
    "  --read-only      Inspect and exit without auditing or changing circuit breakers.",
    "  --audit          Record one critical audit summary, but do not freeze.",
    "  --freeze-books   Audit and freeze affected books; unscoped failures fall back to global read-only.",
    "  --freeze-global  Audit and place the whole market in read-only mode on failure.",
    "  --protect        Alias for --freeze-books.",
    "  --help           Show this help."
  ].join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runMarketReconciliationCli()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 2;
    });
}
