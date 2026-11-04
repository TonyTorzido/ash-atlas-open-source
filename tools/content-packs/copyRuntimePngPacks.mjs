import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceDirectory = resolve(repositoryRoot, "apps/server/content/runtime-png-packs");
const artifactDirectory = resolve(repositoryRoot, "apps/server/dist/content/runtime-png-packs");

await rm(artifactDirectory, { recursive: true, force: true });
await mkdir(dirname(artifactDirectory), { recursive: true });
await cp(sourceDirectory, artifactDirectory, { recursive: true });
process.stdout.write(`Copied runtime PNG packs to ${artifactDirectory}\n`);
