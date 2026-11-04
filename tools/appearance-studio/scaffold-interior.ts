import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { INTERIOR_DATA_RELATIVE_DIR } from "../../packages/shared/src/index.js";
import { applyInteriorWrites, planInteriorSpaceWrites } from "../../apps/appearance-studio/src/interiorCatalogStore.js";
import { readDungeonInteriorFiles } from "../../apps/appearance-studio/src/dungeonInteriorStore.js";
import { DungeonScaffoldError } from "../../apps/appearance-studio/src/dungeonScaffold.js";
import {
  INTERIOR_SCAFFOLD_KINDS,
  InteriorScaffoldError,
  scaffoldInterior,
  type InteriorScaffoldKind
} from "../../apps/appearance-studio/src/interiorScaffold.js";

const USAGE = `Usage: pnpm interior:scaffold [--kind dungeon|manor] <spec.json> [--dry-run]
       (pnpm dungeon:scaffold <spec.json> is --kind dungeon)
       Set INTERIOR_DATA_DIR to write into another copy of data/interiors (tests, trial runs).`;
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const interiorDirectory = process.env.INTERIOR_DATA_DIR
  ? path.resolve(process.env.INTERIOR_DATA_DIR)
  : path.join(repositoryRoot, INTERIOR_DATA_RELATIVE_DIR);

function parseArguments(args: readonly string[]): { kind: InteriorScaffoldKind; dryRun: boolean; spec: string } | null {
  let kind: InteriorScaffoldKind = "dungeon";
  let dryRun = false;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--dry-run") dryRun = true;
    else if (argument === "--kind" || argument.startsWith("--kind=")) {
      const value = argument === "--kind" ? args[++index] : argument.slice("--kind=".length);
      if (!INTERIOR_SCAFFOLD_KINDS.includes(value as InteriorScaffoldKind)) return null;
      kind = value as InteriorScaffoldKind;
    } else if (argument.startsWith("--")) return null;
    else positional.push(argument);
  }
  return positional.length === 1 ? { kind, dryRun, spec: positional[0]! } : null;
}

async function main(): Promise<number> {
  const parsed = parseArguments(process.argv.slice(2));
  if (!parsed) {
    console.error(USAGE);
    return 2;
  }
  const specPath = [process.env.INIT_CWD, process.cwd()]
    .filter((base): base is string => Boolean(base))
    .map((base) => path.resolve(base, parsed.spec))
    .find((candidate) => existsSync(candidate));
  if (!specPath) {
    console.error(`Spec file not found: ${parsed.spec}\n${USAGE}`);
    return 2;
  }
  let spec: unknown;
  try {
    spec = JSON.parse(await readFile(specPath, "utf8"));
  } catch (error) {
    console.error(`Could not read ${specPath} as JSON: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const before = await readDungeonInteriorFiles(interiorDirectory);
  let result;
  try {
    result = scaffoldInterior(before.interior, parsed.kind, spec);
  } catch (error) {
    if (error instanceof DungeonScaffoldError || error instanceof InteriorScaffoldError) {
      console.error(error.message);
      console.error(`\nNothing was written. Fix ${path.relative(process.cwd(), specPath) || specPath} and re-run.`);
      return 1;
    }
    throw error;
  }

  console.log(result.summary);
  if (parsed.dryRun) {
    console.log("\nDry run: nothing was written.");
    return 0;
  }

  // Same publish rules as the Studio bridge: catalogRevision bump in _library.json, stable key order,
  // generated index.ts, and only changed files replaced (all-or-nothing).
  const writes = planInteriorSpaceWrites(before.texts, before.interior, [result.space], result.library);
  const outcome = await applyInteriorWrites(interiorDirectory, before.texts, writes);
  if (!outcome.ok) {
    console.error(`\n${outcome.reason} Nothing was written; re-run.`);
    return 1;
  }
  console.log(`\nWrote ${writes.map((write) => write.fileName).join(", ")} under ${INTERIOR_DATA_RELATIVE_DIR} (catalog revision ${result.library.catalogRevision}).`);
  console.log("Open the Interiors workspace -> Reload from disk (or restart the Studio) to edit it.");
  return 0;
}

process.exitCode = await main();
