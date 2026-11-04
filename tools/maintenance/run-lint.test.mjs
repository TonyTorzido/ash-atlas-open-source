import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { lintGroups, runLint } from "./run-lint.mjs";

test("partitions every root entry, including new packages, hidden paths and spaces", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "ash-atlas-lint-"));
  try {
    for (const folder of ["apps/client", "apps/new app", "packages/shared", "tools", ".hidden", "node_modules"]) {
      mkdirSync(path.join(directory, folder), { recursive: true });
    }
    for (const file of ["root.ts", "README.md", "apps/extra.mjs"]) writeFileSync(path.join(directory, file), "");
    assert.deepEqual(lintGroups(directory).flat().sort(), [
      "./.hidden", "./README.md", "./apps/client", "./apps/extra.mjs", "./apps/new app",
      "./node_modules", "./packages/shared", "./root.ts", "./tools"
    ].sort());
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runs every group sequentially and propagates failure, signals and spawn errors", () => {
  for (const outcome of [{ status: 1 }, { status: null, signal: "SIGTERM" }, { error: new Error("spawn failed") }]) {
    const calls = [];
    const status = runLint("repository with spaces", [["./first"], ["./second path"]], (...args) => {
      calls.push(args);
      return calls.length === 1 ? outcome : { status: 0 };
    });
    assert.equal(status, 1);
    assert.equal(calls.length, 2);
    assert.equal(calls[0][0], process.execPath);
    assert.equal(calls[1][1].at(-1), "./second path");
    assert.equal(calls[1][2].shell, false);
  }
  assert.equal(runLint("repo", [["./ok"]], () => ({ status: 0 })), 0);
});
