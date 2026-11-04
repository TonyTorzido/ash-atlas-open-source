import { randomBytes } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  INTERIOR_INDEX_FILE_NAME,
  INTERIOR_LIBRARY_FILE_NAME,
  interiorIndexSource,
  interiorSpaceFileName,
  type InteriorCatalog,
  type InteriorLibrary,
  type InteriorSpace
} from "@ash-atlas/shared";

import { readDungeonInteriorFiles, stableJson, type InteriorFileWrite } from "./dungeonInteriorStore.js";
import type { InteriorCatalogSnapshot } from "./interiorStudioModel.js";

/**
 * Disk side of the unified interior catalog as the InteriorStudio sees it:
 * the whole catalog to read, and single-space (plus companion) writes to save.
 * The dungeon, Manor and Greenhouse stores remain for the legacy workspaces.
 */

export function interiorSnapshot(interior: InteriorCatalog): InteriorCatalogSnapshot {
  return {
    catalogRevision: interior.library.catalogRevision,
    library: interior.library,
    spaces: interior.spaces,
    spaceRevisions: Object.fromEntries(interior.spaces.map((space) => [space.id, space.revision]))
  };
}

/** Load the whole unified catalog (library plus every space) from an interiors directory. */
export async function loadInteriorSnapshot(directory: string): Promise<InteriorCatalogSnapshot> {
  return interiorSnapshot((await readDungeonInteriorFiles(directory)).interior);
}

/** `spaces` replaced or added, sorted by id like the reader lists them. */
export function withInteriorSpaces(current: InteriorCatalog, library: InteriorLibrary, spaces: readonly InteriorSpace[]): InteriorCatalog {
  const byId = new Map(current.spaces.map((space) => [space.id, space]));
  for (const space of spaces) byId.set(space.id, space);
  return {
    library,
    spaces: [...byId.values()].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  };
}

/**
 * The files that must change on disk to publish `spaces` with `library`. Only
 * files whose text differs are returned; unlisted spaces are untouched.
 */
export function planInteriorSpaceWrites(
  existing: ReadonlyMap<string, string>,
  existingInterior: InteriorCatalog,
  spaces: readonly InteriorSpace[],
  library: InteriorLibrary
): InteriorFileWrite[] {
  const files: InteriorFileWrite[] = [
    { fileName: INTERIOR_LIBRARY_FILE_NAME, text: stableJson(library) },
    ...spaces.map((space) => ({ fileName: interiorSpaceFileName(space.id), text: stableJson(space) }))
  ];
  const spaceIds = new Set<string>(existingInterior.spaces.map((space) => space.id));
  for (const space of spaces) spaceIds.add(space.id);
  files.push({ fileName: INTERIOR_INDEX_FILE_NAME, text: interiorIndexSource([...spaceIds]) });
  return files.filter((file) => existing.get(file.fileName) !== file.text);
}

/**
 * Write `writes` into `directory` as one unit: every file goes to a temporary sibling first, the
 * directory is re-read to make sure nothing changed since `before` was read (a Studio save in
 * between aborts the write), then the temporaries are renamed into place.
 */
export async function applyInteriorWrites(
  directory: string,
  before: ReadonlyMap<string, string>,
  writes: readonly InteriorFileWrite[]
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const temporaries: { temporary: string; destination: string }[] = [];
  try {
    for (const write of writes) {
      const destination = path.join(directory, write.fileName);
      const temporary = `${destination}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      await writeFile(temporary, write.text, { encoding: "utf8", flag: "wx" });
      temporaries.push({ temporary, destination });
    }
    const after = (await readDungeonInteriorFiles(directory)).texts;
    const unchanged = after.size === before.size && [...before].every(([name, text]) => after.get(name) === text);
    if (!unchanged) return { ok: false, reason: "The interior data changed on disk while writing (is the Studio saving?)." };
    for (const { temporary, destination } of temporaries) await rename(temporary, destination);
    temporaries.length = 0;
    return { ok: true };
  } finally {
    await Promise.all(temporaries.map(({ temporary }) => unlink(temporary).catch(() => undefined)));
  }
}
