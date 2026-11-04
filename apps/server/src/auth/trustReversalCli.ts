import { loadConfig } from "../config.js";
import { createPool } from "../db/pool.js";
import { reverseTrustSignals } from "./trust/trustReversal.js";

const USAGE =
  "Usage: pnpm --filter @ash-atlas/server trust:reverse -- (--rule <name>[,<name>] | --all-rules) --reason <text> "
  + "[--since <iso>] [--until <iso>] [--apply]   (dry run unless --apply)";

type CliOptions = Readonly<{
  rules: readonly string[];
  allRules: boolean;
  since: Date | null;
  until: Date | null;
  reason: string;
  apply: boolean;
}>;

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const args = process.argv.slice(2);
  const options = parseOptions(args[0] === "--" ? args.slice(1) : args);
  const config = loadConfig();
  const pool = createPool({
    databaseUrl,
    max: 2,
    applicationName: "ash-atlas-trust-reversal"
  });
  try {
    const result = await reverseTrustSignals(pool, {
      ...options,
      now: new Date(),
      tauDays: config.TRUST_DECAY_TAU_DAYS,
      thresholds: config.TRUST_QUARANTINE_MODE === "off"
        ? null
        : {
            quarantine: config.TRUST_QUARANTINE_THRESHOLD,
            quarantineNew: config.TRUST_QUARANTINE_THRESHOLD_NEW,
            warning: config.TRUST_WARNING_THRESHOLD
          }
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await pool.end();
  }
}

export function parseOptions(args: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--apply" || key === "--all-rules") {
      if (flags.has(key)) throw new Error(`Duplicate option ${key}`);
      flags.add(key);
      continue;
    }
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) throw new Error(USAGE);
    if (values.has(key)) throw new Error(`Duplicate option ${key}`);
    values.set(key, value);
    index += 1;
  }
  const known = new Set(["--rule", "--since", "--until", "--reason"]);
  for (const key of values.keys()) if (!known.has(key)) throw new Error(`Unknown option ${key}\n${USAGE}`);
  const allRules = flags.has("--all-rules");
  const rules = (values.get("--rule") ?? "").split(",").map((rule) => rule.trim()).filter(Boolean);
  if (allRules === (rules.length > 0)) throw new Error(`Pass exactly one of --rule or --all-rules\n${USAGE}`);
  const reason = values.get("--reason")?.trim() ?? "";
  if (!reason) throw new Error(`Missing --reason\n${USAGE}`);
  const since = parseDate(values.get("--since"), "--since");
  const until = parseDate(values.get("--until"), "--until");
  if (since && until && since >= until) throw new Error("--since must be before --until");
  return { rules, allRules, since, until, reason, apply: flags.has("--apply") };
}

function parseDate(value: string | undefined, name: string): Date | null {
  if (value === undefined) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${name} must be an ISO-8601 timestamp`);
  return date;
}

if (process.argv[1] && /trustReversalCli\.[tj]s$/.test(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
