import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { INTERIOR_DATA_RELATIVE_DIR } from "../../packages/shared/src/index.js";
import { applyInteriorWrites, planInteriorSpaceWrites } from "../../apps/appearance-studio/src/interiorCatalogStore.js";
import { readDungeonInteriorFiles } from "../../apps/appearance-studio/src/dungeonInteriorStore.js";
import { scaffoldInterior } from "../../apps/appearance-studio/src/interiorScaffold.js";

/**
 * Re-scaffolds the Drowned City from its spec in place: the published dungeon, its scaffolded chest
 * reward tables and its entrance template are dropped in memory, the spec is compiled again (same
 * ids), and the entrance template is put back. `pnpm exec tsx tools/appearance-studio/rescaffold-drowned-city.ts`
 */
const root = fileURLToPath(new URL("../..", import.meta.url));
const directory = path.join(root, INTERIOR_DATA_RELATIVE_DIR);
const DUNGEON_ID = "drowned_city";
const spec: unknown = JSON.parse(await readFile(path.join(root, "tools/appearance-studio/interior-specs/drowned_city.json"), "utf8"));

const before = await readDungeonInteriorFiles(directory);
const entrance = before.interior.library.entrances.find((candidate) => candidate.dungeonId === DUNGEON_ID);
const ownTable = (id: string): boolean => id.startsWith(`${DUNGEON_ID}_`);
const stripped = {
  library: {
    ...before.interior.library,
    entrances: before.interior.library.entrances.filter((candidate) => candidate.dungeonId !== DUNGEON_ID),
    rewardTables: before.interior.library.rewardTables.filter((table) => !ownTable(table.id)),
    rewardTableIds: before.interior.library.rewardTableIds.filter((id) => !ownTable(id))
  },
  spaces: before.interior.spaces.filter((space) => space.id !== DUNGEON_ID)
};
const result = scaffoldInterior(stripped, "dungeon", spec);
const library = entrance ? { ...result.library, entrances: [...result.library.entrances, entrance] } : result.library;
const writes = planInteriorSpaceWrites(before.texts, before.interior, [result.space], library);
const outcome = await applyInteriorWrites(directory, before.texts, writes);
if (!outcome.ok) throw new Error(outcome.reason);
console.log(`Re-scaffolded ${DUNGEON_ID} (${writes.map((write) => write.fileName).join(", ") || "no changes"}).`);
