import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  equipmentCombatSimulationSuiteJson,
  equipmentCombatSimulationSuiteMarkdown,
  runEquipmentCombatSimulationSuite
} from "./equipmentCombatSimulation.js";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(moduleDirectory, "../../../../..");

export async function writeEquipmentCombatSimulationArtifacts(
  outputDirectory = resolve(repositoryRoot, "docs")
): Promise<{ jsonPath: string; markdownPath: string }> {
  const suite = runEquipmentCombatSimulationSuite();
  const jsonPath = resolve(outputDirectory, "equipment-combat-balance-report.json");
  const markdownPath = resolve(outputDirectory, "equipment-combat-balance-report.md");
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(jsonPath, `${equipmentCombatSimulationSuiteJson(suite)}\n`, "utf8"),
    writeFile(markdownPath, `${equipmentCombatSimulationSuiteMarkdown(suite)}\n`, "utf8")
  ]);
  return { jsonPath, markdownPath };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const result = await writeEquipmentCombatSimulationArtifacts();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
