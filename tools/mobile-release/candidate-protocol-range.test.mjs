import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

import { readCandidateProtocolRange } from "./candidate-protocol-range.mjs";

test("recovery reads the immutable source protocol while current tooling checkout has a newer protocol", async () => {
  const root = await mkdtemp(join(tmpdir(), "candidate-protocol-history-"));
  const directory = join(root, "config");
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "protocol-versions.json"), JSON.stringify({ protocol_id: "ash-atlas", min_protocol: 3, max_protocol: 3 }));
    git("init", "--quiet");
    git("add", ".");
    git("-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "original candidate");
    const sourceSha = git("rev-parse", "HEAD");
    await writeFile(join(directory, "protocol-versions.json"), JSON.stringify({ protocol_id: "ash-atlas", min_protocol: 4, max_protocol: 4 }));
    assert.equal(readCandidateProtocolRange(root).min, 4);
    assert.deepEqual(readCandidateProtocolRange(root, sourceSha), {
      min: 3, max: 3, source: join(directory, "protocol-versions.json")
    });
    assert.throws(() => readCandidateProtocolRange(root, "HEAD"), /must be exact/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("derives protocol range from the exact candidate source", async () => {
  const root = await mkdtemp(join(tmpdir(), "candidate-protocol-"));
  const directory = join(root, "config");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "protocol-versions.json"), JSON.stringify({ protocol_id: "ash-atlas", min_protocol: 7, max_protocol: 9 }));
  await mkdir(join(root, "packages/shared/src"), { recursive: true });
  await writeFile(join(root, "packages/shared/src/protocolCompatibility.ts"), 'export { ASH_ATLAS_MIN_PROTOCOL_VERSION, ASH_ATLAS_MAX_PROTOCOL_VERSION } from "./version.js";');
  try {
    assert.deepEqual(readCandidateProtocolRange(root), {
      min: 7,
      max: 9,
      source: join(directory, "protocol-versions.json")
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed for invalid candidate protocol JSON", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "candidate-protocol-invalid-"));
  const directory = join(root, "config");
  await mkdir(directory, { recursive: true });
  try {
    for (const config of [
      { protocol_id: "other", min_protocol: 3, max_protocol: 3 },
      { protocol_id: "ash-atlas", min_protocol: "3", max_protocol: 3 },
      { protocol_id: "ash-atlas", min_protocol: 0, max_protocol: 3 },
      { protocol_id: "ash-atlas", min_protocol: 4, max_protocol: 3 },
      { protocol_id: "ash-atlas", min_protocol: 3, max_protocol: 1_000_001 },
      { protocol_id: "ash-atlas", min_protocol: 3, max_protocol: 3.5 },
      null
    ]) {
      await t.test(JSON.stringify(config), async () => {
        await writeFile(join(directory, "protocol-versions.json"), JSON.stringify(config));
        assert.throws(() => readCandidateProtocolRange(root), /configuration is invalid/u);
      });
    }
    await writeFile(join(directory, "protocol-versions.json"), "{broken");
    assert.throws(() => readCandidateProtocolRange(root), SyntaxError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
