import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../config.js";
import { createPool } from "../db/pool.js";
import { PostgresPopulationZonesV2Store } from "./populationZonesV2Store.js";

const APPLY_CONFIRMATION = "REPAIR_COMPATIBLE_POPULATION_STONES";

export async function runPopulationStoneConflictRepair(input: Readonly<{
  databaseUrl: string;
  apply: boolean;
  resumeRepairId?: string;
}>): Promise<Readonly<{
  mode: "dry-run" | "apply";
  receipt: Awaited<ReturnType<
    PostgresPopulationZonesV2Store[
      "repairCompatiblePermanentStonePlanFailures"
    ]
  >>;
}>> {
  const pool = createPool({
    databaseUrl: input.databaseUrl,
    applicationName: "population-stone-conflict-repair"
  });
  try {
    const store = new PostgresPopulationZonesV2Store(pool);
    const receipt = await store.repairCompatiblePermanentStonePlanFailures({
      apply: input.apply,
      ...(input.resumeRepairId === undefined
        ? {}
        : { resumeRepairId: input.resumeRepairId })
    });
    return {
      mode: input.apply ? "apply" : "dry-run",
      receipt
    };
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  const apply = arguments_.includes("--apply");
  const confirmationIndex = arguments_.indexOf("--confirm");
  const confirmation = confirmationIndex === -1
    ? null
    : arguments_[confirmationIndex + 1] ?? null;
  const resumeIndex = arguments_.indexOf("--resume-repair");
  const resumeRepairId = resumeIndex === -1
    ? null
    : arguments_[resumeIndex + 1] ?? null;
  const known = new Set([
    "--apply",
    "--confirm",
    confirmation ?? "",
    "--resume-repair",
    resumeRepairId ?? ""
  ]);
  const unknown = arguments_.filter((argument) => !known.has(argument));
  if (unknown.length > 0) {
    throw new Error(`unknown population repair argument ${unknown[0]}`);
  }
  if (apply && confirmation !== APPLY_CONFIRMATION) {
    throw new Error(
      `--apply requires --confirm ${APPLY_CONFIRMATION}`
    );
  }
  if (!apply && confirmation !== null) {
    throw new Error("--confirm is valid only with --apply");
  }
  if (
    resumeIndex !== -1
    && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      resumeRepairId ?? ""
    )
  ) {
    throw new Error("--resume-repair requires a valid repair receipt UUID");
  }
  const config = loadConfig();
  const result = await runPopulationStoneConflictRepair({
    databaseUrl: config.DATABASE_URL,
    apply,
    ...(resumeRepairId === null ? {} : { resumeRepairId })
  });
  console.log(JSON.stringify(result, null, 2));
}

if (
  process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
