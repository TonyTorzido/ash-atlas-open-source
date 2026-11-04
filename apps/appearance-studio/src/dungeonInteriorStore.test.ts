import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DUNGEON_CATALOG, INTERIOR_DATA_RELATIVE_DIR } from "@ash-atlas/shared";
import { afterEach, describe, expect, it } from "vitest";

import { loadDungeonCatalogFromInteriors, readDungeonInteriorFiles } from "./dungeonInteriorStore.js";

const committed = path.join(
  fileURLToPath(new URL("../../..", import.meta.url)),
  INTERIOR_DATA_RELATIVE_DIR
);
const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function copyOfCommitted(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "interiors-"));
  cleanup.push(directory);
  await cp(committed, directory, { recursive: true });
  return directory;
}

describe("dungeon interior store", () => {
  it("loads the committed files as the same dungeon view the runtime uses", async () => {
    expect(await loadDungeonCatalogFromInteriors(committed)).toEqual(DUNGEON_CATALOG);
  });

  it("treats a CRLF checkout of the files as the committed LF form", async () => {
    const directory = await copyOfCommitted();
    const committedTexts = (await readDungeonInteriorFiles(committed)).texts;
    for (const name of await readdir(directory)) {
      const file = path.join(directory, name);
      const lines = (await readFile(file, "utf8")).split(/\r?\n/u);
      await writeFile(file, lines.join("\r\n"));
    }
    expect((await readDungeonInteriorFiles(directory)).texts).toEqual(committedTexts);
    expect(await loadDungeonCatalogFromInteriors(directory)).toEqual(DUNGEON_CATALOG);
  });
});
