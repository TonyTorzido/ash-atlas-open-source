import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  APPEARANCE_STUDIO_CONTRACT_VERSION,
  APPEARANCE_STUDIO_MINIMUM_DESKTOP_VERSION
} from "../src/desktopContracts.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(packageRoot, "../..");
const packageManifest = JSON.parse(await readFile(
  path.join(packageRoot, "package.json"),
  "utf8"
)) as { version?: unknown };
const compatibility = JSON.parse(await readFile(
  path.join(repositoryRoot, "config/appearance-studio.compatibility.json"),
  "utf8"
)) as { contractVersion?: unknown; minimumDesktopVersion?: unknown };

if (compatibility.contractVersion !== APPEARANCE_STUDIO_CONTRACT_VERSION) {
  throw new Error(
    `Workspace contract ${String(compatibility.contractVersion)} does not match ` +
      `desktop contract ${APPEARANCE_STUDIO_CONTRACT_VERSION}.`
  );
}
if (compatibility.minimumDesktopVersion !== APPEARANCE_STUDIO_MINIMUM_DESKTOP_VERSION) {
  throw new Error(
    `Workspace minimum desktop ${String(compatibility.minimumDesktopVersion)} does not match ` +
      `contract ${APPEARANCE_STUDIO_CONTRACT_VERSION} release ` +
      `${APPEARANCE_STUDIO_MINIMUM_DESKTOP_VERSION}.`
  );
}
if (
  typeof packageManifest.version !== "string" ||
  compareVersions(packageManifest.version, APPEARANCE_STUDIO_MINIMUM_DESKTOP_VERSION) < 0
) {
  throw new Error(
    `Appearance Studio package ${String(packageManifest.version)} must be at least ` +
      `${APPEARANCE_STUDIO_MINIMUM_DESKTOP_VERSION}.`
  );
}

console.log(
  `Appearance Studio contract ${APPEARANCE_STUDIO_CONTRACT_VERSION} verified for desktop ` +
    `${packageManifest.version}.`
);

function compareVersions(left: string, right: string): number {
  const leftParts = semanticVersion(left);
  const rightParts = semanticVersion(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

function semanticVersion(value: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(value);
  if (!match) throw new Error(`Invalid Appearance Studio version: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
