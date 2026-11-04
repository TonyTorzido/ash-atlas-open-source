import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const manifestName = "capawesome-live-update-manifest.json";
const directory = resolve(process.argv[2] ?? "dist");
const entries = [];

async function visit(folder, relative = "") {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const href = relative ? `${relative}/${entry.name}` : entry.name;
    if (href === manifestName) continue;
    if (entry.isDirectory()) {
      await visit(join(folder, entry.name), href);
      continue;
    }
    if (!entry.isFile()) throw new Error(`Native bundle contains an unsupported entry: ${href}`);
    const file = join(directory, ...href.split("/"));
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    entries.push({ href, checksum: hash.digest("hex"), sizeInBytes: (await stat(file)).size });
  }
}

await visit(directory);
entries.sort((left, right) => left.href < right.href ? -1 : left.href > right.href ? 1 : 0);
await writeFile(join(directory, manifestName), `${JSON.stringify(entries)}\n`);
