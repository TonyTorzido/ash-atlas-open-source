import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(import.meta.url);

export function lintGroups(directory) {
  const groups = [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      files.push(`./${entry.name}`);
    } else if (entry.name === "apps" || entry.name === "packages") {
      for (const child of readdirSync(path.join(directory, entry.name))) {
        groups.push([`./${entry.name}/${child}`]);
      }
    } else {
      groups.push([`./${entry.name}`]);
    }
  }
  return files.length ? [files, ...groups] : groups;
}

export function runLint(directory, groups, run = spawnSync) {
  const cli = path.join(path.dirname(require.resolve("eslint/package.json")), "bin/eslint.js");
  let failed = false;
  for (const group of groups) {
    console.log(`Lint: ${group.length === 1 ? group[0] : "root files"}`);
    const result = run(process.execPath, [
      cli,
      // Empty/non-JavaScript partitions remain governed by ESLint's own config.
      "--no-error-on-unmatched-pattern",
      "--no-warn-ignored",
      ...group
    ], { cwd: directory, stdio: "inherit", shell: false });
    if (result.error) console.error(result.error.message);
    if (result.error || result.signal || result.status !== 0) failed = true;
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runLint(root, lintGroups(root));
}
