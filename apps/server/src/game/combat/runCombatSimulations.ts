import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  combatSimulationSuiteJson,
  combatSimulationSuiteMarkdown,
  runCombatSimulationSuite
} from "./combatSimulation.js";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(moduleDirectory, "../../../../..");

export async function writeCombatSimulationArtifacts(
  outputDirectory = resolve(repositoryRoot, "docs")
): Promise<{ jsonPath: string; markdownPath: string }> {
  const suite = runCombatSimulationSuite();
  const jsonPath = resolve(outputDirectory, "combat-balance-summary.json");
  const markdownPath = resolve(outputDirectory, "combat-balance-summary.md");
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(jsonPath, `${combatSimulationSuiteJson(suite)}\n`, "utf8"),
    writeFile(markdownPath, `${combatSimulationSuiteMarkdown(suite)}\n`, "utf8")
  ]);
  return { jsonPath, markdownPath };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const result = await writeCombatSimulationArtifacts();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
