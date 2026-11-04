import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Ships the committed population grid (apps/server/data) inside the server artifact
// at apps/server/dist/data, next to the esbuild bundle.
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceDirectory = resolve(repositoryRoot, "apps/server/data");
const artifactDirectory = resolve(repositoryRoot, "apps/server/dist/data");

await mkdir(artifactDirectory, { recursive: true });
// The IP geolocation databases are provisioned separately (docs/ops/IPGEO_DATABASES.md).
await cp(sourceDirectory, artifactDirectory, {
  recursive: true,
  filter: (source) => !source.split(/[\\/]/u).includes("ipgeo")
});
process.stdout.write(`Copied server data files to ${artifactDirectory}\n`);
