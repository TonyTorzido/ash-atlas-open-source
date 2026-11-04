import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import {
  INTERIOR_INDEX_FILE_NAME,
  INTERIOR_LIBRARY_FILE_NAME,
  interiorCatalogSchema,
  parseDungeonCatalog,
  dungeonCatalogFromInterior,
  type DungeonCatalog,
  type InteriorCatalog
} from "@ash-atlas/shared";

/**
 * Disk side of the dungeon catalog. The single source of truth is
 * `packages/shared/src/data/interiors/` (one JSON per dungeon space plus
 * `_library.json`). This module reads the files (and projects the dungeon view); writes go
 * through `interiorCatalogStore.ts`.
 */

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)])
    );
  }
  return value;
}

/** Same formatting as the bridge's `stableJson` (sorted keys, 2 spaces, trailing newline). */
export function stableJson(value: unknown): string {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

export type DungeonInteriorFiles = Readonly<{
  /** File name -> text currently on disk (CRLF checkouts normalized to LF, the committed form) (library, space JSON files and index.ts). */
  texts: ReadonlyMap<string, string>;
  interior: InteriorCatalog;
}>;

/** Read every interior file under `directory` (an absolute path to `data/interiors`). */
export async function readDungeonInteriorFiles(directory: string): Promise<DungeonInteriorFiles> {
  const names = (await readdir(directory)).filter((name) =>
    name === INTERIOR_INDEX_FILE_NAME || name.endsWith(".json"));
  const texts = new Map<string, string>();
  for (const name of names.sort()) {
    // Windows checkouts may hand back CRLF; the committed (and written) form is LF.
    texts.set(name, (await readFile(path.join(directory, name), "utf8")).replace(/\r\n/gu, "\n"));
  }
  const libraryText = texts.get(INTERIOR_LIBRARY_FILE_NAME);
  if (libraryText === undefined) throw new Error(`Missing ${INTERIOR_LIBRARY_FILE_NAME} in ${directory}`);
  const spaces = [...texts.entries()]
    .filter(([name]) => name.endsWith(".json") && name !== INTERIOR_LIBRARY_FILE_NAME)
    .map(([, text]) => JSON.parse(text) as { id: string })
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  // Structural parse only: dungeon semantics are validated on the dungeon view below.
  const interior = interiorCatalogSchema.parse({ library: JSON.parse(libraryText), spaces });
  return { texts, interior };
}

/** Load the dungeon-shaped view from disk (throws `SyntaxError` on malformed JSON). */
export async function loadDungeonCatalogFromInteriors(directory: string): Promise<DungeonCatalog> {
  const { interior } = await readDungeonInteriorFiles(directory);
  return parseDungeonCatalog(dungeonCatalogFromInterior(interior));
}

export type InteriorFileWrite = Readonly<{ fileName: string; text: string }>;
