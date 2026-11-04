import { createHash } from "node:crypto";
import { readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import {
  RUNTIME_PNG_ASSET_REGISTRY,
  RUNTIME_PNG_CLIENT_ASSET_ROOT,
  type RuntimePngAssetRegistration
} from "@ash-atlas/shared";

import { validatePng } from "./pngValidation.js";

export const DEFAULT_ATLAS_PNG_SOURCE_DIRECTORY = path.join(
  homedir(),
  "Documents",
  "AtlasPNGS"
);

export type AtlasPngSourceAsset = {
  sourceFile: string;
  sourcePath: string;
  label: string;
  destinationFile: string;
  destinationCandidates: readonly string[];
  mappingStatus: "generic" | "registered" | "ambiguous";
  width: number;
  height: number;
  bytes: number;
  contentHash: string;
};

export type AtlasPngDestinationResolution = Readonly<{
  destinationFile: string;
  destinationCandidates: readonly string[];
  mappingStatus: AtlasPngSourceAsset["mappingStatus"];
}>;

/**
 * Discover only valid, top-level PNG files from the user's art inbox.
 * The inbox is intentionally read-only until Studio stages an explicit import.
 */
export async function discoverAtlasPngSourceAssets(
  sourceRoot: string
): Promise<AtlasPngSourceAsset[]> {
  const resolvedRoot = path.resolve(sourceRoot);
  let root: string;
  try {
    root = await realpath(resolvedRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" ||
        (error as NodeJS.ErrnoException).code === "ENOTDIR") return [];
    throw error;
  }

  const assets: AtlasPngSourceAsset[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".png")) continue;
    const stem = atlasPngFileStem(entry.name);
    if (!stem) continue;
    const destination = resolveAtlasPngDestination(stem);
    const sourcePath = path.join(root, entry.name);
    try {
      const buffer = await readFile(sourcePath);
      const dimensions = validatePng(buffer);
      assets.push({
        sourceFile: entry.name,
        sourcePath,
        label: atlasPngLabel(stem),
        ...destination,
        ...dimensions,
        bytes: buffer.length,
        contentHash: createHash("sha256").update(buffer).digest("hex")
      });
    } catch {
      // Invalid or partially copied files are not actionable candidates yet.
    }
  }
  return assets.sort((left, right) => left.sourceFile.localeCompare(right.sourceFile));
}

/**
 * Resolve a top-level inbox stem to a registered nested slot when there is
 * exactly one basename match. Multiple registered slots with the same basename
 * are intentionally left on the generic target and marked ambiguous so the
 * bridge can refuse the import rather than guessing.
 */
export function resolveAtlasPngDestination(
  stem: string,
  registrations: readonly Pick<RuntimePngAssetRegistration, "relativeFile">[] =
    RUNTIME_PNG_ASSET_REGISTRY
): AtlasPngDestinationResolution {
  const genericDestination = `${RUNTIME_PNG_CLIENT_ASSET_ROOT}${stem}.png`;
  const destinationCandidates = [...new Set(
    registrations
      .map(({ relativeFile }) => relativeFile)
      .filter((relativeFile) => relativeFile.startsWith(RUNTIME_PNG_CLIENT_ASSET_ROOT))
      .filter((relativeFile) => {
        const fileName = relativeFile.split("/").at(-1) ?? relativeFile;
        return atlasPngFileStem(fileName) === stem;
      })
  )];
  if (destinationCandidates.length === 1) {
    return {
      destinationFile: destinationCandidates[0]!,
      destinationCandidates,
      mappingStatus: "registered"
    };
  }
  return {
    destinationFile: genericDestination,
    destinationCandidates,
    mappingStatus: destinationCandidates.length > 1 ? "ambiguous" : "generic"
  };
}

export function atlasPngFileStem(fileName: string): string | null {
  const base = path.basename(fileName, path.extname(fileName))
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/([a-z\d])([A-Z])/gu, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64);
  return base || null;
}

export function atlasPngLabel(stem: string): string {
  return stem
    .split("-")
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
