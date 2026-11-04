import { createPool } from "../db/pool.js";
import { AccountDeletionService } from "./accountDeletionService.js";

type CliOptions = Readonly<{
  requestId: string;
  accountId: string;
  processingNote?: string;
}>;

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const options = parseOptions(process.argv.slice(2));
  const pool = createPool({
    databaseUrl,
    max: 1,
    applicationName: "ash-atlas-account-deletion-processor"
  });
  try {
    const result = await new AccountDeletionService(pool).processRequest(options);
    console.log(JSON.stringify(result));
  } finally {
    await pool.end();
  }
}

function parseOptions(args: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(
        "Usage: pnpm --filter @ash-atlas/server auth:process-deletion -- --request-id <uuid> --account-id <uuid> [--note <text>]"
      );
    }
    if (values.has(key)) throw new Error(`Duplicate option ${key}`);
    values.set(key, value);
    index += 1;
  }
  const requestId = requireOption(values, "--request-id");
  const accountId = requireOption(values, "--account-id");
  const note = values.get("--note")?.trim();
  if (values.size > (note ? 3 : 2)) throw new Error("Unknown account deletion option");
  return {
    requestId,
    accountId,
    ...(note ? { processingNote: note } : {})
  };
}

function requireOption(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key)?.trim();
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
