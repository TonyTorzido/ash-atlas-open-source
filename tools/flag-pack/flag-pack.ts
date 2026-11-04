import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  TERRITORY_STRUCTURE_CATALOG_RELATIVE_PATH, cloneTerritoryFlagPack,
  parseTerritoryStructureCatalog, territoryStructureValidationIssues,
  type TerritoryStructureCatalog
} from "../../packages/shared/src/territoryStructures.js";

export async function runFlagPackCommand(args: string[], repositoryRoot: string): Promise<string> {
  const [command, ...rest] = args;
  if (command !== "validate" && command !== "clone") throw new Error("Use validate, or clone --id <id> --name <name> [--cloth-color #RRGGBB] [--write].");
  const options = new Map<string, string>();
  let write = false;
  for (let index = 0; index < rest.length; index++) {
    const key = rest[index]!;
    if (key === "--write" && !write) { write = true; continue; }
    if (!["--id", "--name", "--cloth-color"].includes(key) || options.has(key) || !rest[index + 1] || rest[index + 1]!.startsWith("--")) throw new Error(`Invalid or repeated option ${key}.`);
    options.set(key, rest[++index]!);
  }
  if (command === "validate" && (write || options.size)) throw new Error("validate accepts no options and never writes.");
  const catalogPath = path.join(repositoryRoot, TERRITORY_STRUCTURE_CATALOG_RELATIVE_PATH);
  const original = await readFile(catalogPath, "utf8");
  const catalog = parseTerritoryStructureCatalog(JSON.parse(original));
  await assertAssets(catalog, repositoryRoot);
  if (command === "validate") return `Valid: ${Object.keys(catalog.packs).length} pack(s), all required types/roles and PNGs present. Active pack: ${catalog.defaultPackId}.`;
  const id = options.get("--id"), name = options.get("--name");
  if (!id || !name) throw new Error("clone requires --id and --name.");
  const pack = cloneTerritoryFlagPack(catalog, id, name, options.get("--cloth-color"));
  const proposed = parseTerritoryStructureCatalog({ ...catalog, revision: catalog.revision + 1, packs: { ...catalog.packs, [id]: pack } });
  await assertAssets(proposed, repositoryRoot);
  if (write) {
    // Use Studio's real guarded/atomic publisher, without opening a listener or duplicating locks.
    const { createAppearanceStudioBridge } = await import("../../apps/appearance-studio/src/bridge.js");
    const app = await createAppearanceStudioBridge({ repositoryRoot, serveUi: false });
    try {
      const sessionResponse = await app.inject({ method: "GET", url: "/api/session" });
      if (sessionResponse.statusCode !== 200) throw new Error(sessionResponse.body);
      const session = sessionResponse.json<{
        csrfToken: string; origin: string;
        workspace: { worktreePath: string; branch: string | null; commitSha: string };
      }>();
      const response = await app.inject({ method: "POST", url: "/api/territory-structures/publish",
        headers: { origin: session.origin, "x-appearance-studio-token": session.csrfToken },
        payload: { catalog: proposed, expectedRevision: catalog.revision, expectedWorkspace: session.workspace }
      });
      if (response.statusCode !== 200) throw new Error(response.json<{ error: string }>().error);
    } finally { await app.close(); }
  }
  return `${write ? "Created" : "Dry run: would create"} ${id} (${pack.displayName}) with all four structures. ${write ? `Revision ${proposed.revision}.` : "Add --write to save."} Active pack remains ${catalog.defaultPackId}.`;
}

async function assertAssets(catalog: TerritoryStructureCatalog, repositoryRoot: string) {
  const assets = new Set(Object.values(catalog.packs).flatMap((pack) => Object.values(pack.structures).flatMap((visual) => visual!.pieces.map((piece) => piece.asset))));
  const available = new Set<string>();
  await Promise.all([...assets].map(async (asset) => {
    try { await access(path.join(repositoryRoot, asset)); available.add(asset); }
    catch { /* The shared validator reports the exact missing component below. */ }
  }));
  const issues = territoryStructureValidationIssues(catalog, available);
  if (issues.length) throw new Error(issues.join("\n"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
  runFlagPackCommand(process.argv.slice(2), repositoryRoot).then((message) => process.stdout.write(`${message}\n`))
    .catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
