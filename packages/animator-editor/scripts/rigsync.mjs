/*
 * Re-sync the editor's pro rigs from the swag branch (the garment rigs: mesh arms, chest.leather, chest.jacket_b).
 *
 *   pnpm rigsync [ref] [--backup <dir>] [--dir <rig folder>]... [--dry]
 *
 * ref defaults to origin/feature/swag-pieces--from-t1587 (fetched first). Reads from git objects only, never from the swag worktree.
 * For each rig folder (default kit-body-cutout, the turned rig; kit-body-front0 is retired) under packages/animator/rigs:
 *   - the current folder is copied to the backup dir first (default: <tmp>/atlas-rigsync-backups/<timestamp>);
 *   - every file at the ref is written over the working copy;
 *   - files git tracks here but the ref no longer has (stale atlas pages) are removed;
 *   - untracked files are left alone. User clips live in packages/animator-editor/clips and are never touched.
 * Vite picks the new files up on the next page reload; no server restart needed.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const RIGS = "packages/animator/rigs";
const args = process.argv.slice(2);
let ref = "origin/feature/swag-pieces--from-t1587";
let backup = join(tmpdir(), "atlas-rigsync-backups", new Date().toISOString().replace(/[:.]/g, "-"));
let dry = false;
const dirs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--backup") backup = resolve(args[++i]);
  else if (args[i] === "--dir") dirs.push(args[++i]);
  else if (args[i] === "--dry") dry = true;
  else ref = args[i];
}
// front view retired 2026-10-25: kit-body-front0 is no longer synced by default (pass --dir kit-body-front0 to sync it).
if (!dirs.length) dirs.push("kit-body-cutout");

const git = (...a) => execFileSync("git", a, { cwd: repo, maxBuffer: 1 << 30 });
const lines = (b) => b.toString("utf8").split("\0").filter(Boolean);

if (ref.startsWith("origin/")) git("fetch", "origin", ref.slice(7));
const sha = git("rev-parse", ref).toString().trim();
console.log(`rigsync from ${ref} (${sha.slice(0, 9)}), rigs: ${dirs.join(", ")}${dry ? " [dry run]" : ""}`);

for (const d of dirs) {
  const rel = `${RIGS}/${d}`;
  const wanted = lines(git("ls-tree", "-r", "-z", "--name-only", sha, "--", rel));
  if (!wanted.length) throw new Error(`${rel} does not exist at ${ref}`);
  const tracked = lines(git("ls-files", "-z", "--", rel));
  const stale = tracked.filter((f) => !wanted.includes(f));
  console.log(`${d}: ${wanted.length} files from ref, ${stale.length} stale tracked files to remove`);
  if (dry) continue;
  if (existsSync(join(repo, rel))) {
    mkdirSync(join(backup, d), { recursive: true });
    cpSync(join(repo, rel), join(backup, d), { recursive: true });
  }
  for (const f of stale) rmSync(join(repo, f), { force: true });
  for (const f of wanted) {
    const out = join(repo, f);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, git("show", `${sha}:${f}`));
  }
}
if (!dry) console.log(`done. Backup of the replaced folders: ${backup}\nReload the editor page. Then: git add ${RIGS} && git commit.`);
