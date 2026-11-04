import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createHash } from "node:crypto";
import { changeReleaseRetirement, RETIREMENT_NOTE } from "./registry.mjs";

const gate = fileURLToPath(new URL("./server-compatibility-gate.mjs", import.meta.url));

test("blocks a server protocol that excludes a supported tester build", () => {
  const directory = mkdtempSync(join(tmpdir(), "mobile-gate-"));
  const registry = {
    schemaVersion: 1,
    buildFloor: { ios: 2, android: 2 },
    nextBuild: { ios: 3, android: 2 },
    releases: [{
      reservationId: "release:ios", releaseId: "release", platform: "ios",
      marketingVersion: "1.0.0", build: 2, generation: "t1175", sourceSha: "a".repeat(40),
      protocol: { min: 3, max: 3 }, reservedAt: "2026-09-16T00:00:00Z",
      uploadAttempted: true, uploaded: true, processed: true, internal: true,
      externalApproved: false, open: false, downloadTested: false, supported: false,
      compatibilityProtected: true,
      artifactSha256: "b".repeat(64), storeBuildId: "2",
      receiptUrl: "https://example.test/receipt"
    }]
  };
  const path = join(directory, "registry.json");
  writeFileSync(path, JSON.stringify(registry));
  assert.throws(() => execFileSync(process.execPath, [gate, "--registry", path,
    "--protocol-min", "4", "--protocol-max", "4"]), /Command failed/u);
  const output = execFileSync(process.execPath, [gate, "--registry", path,
    "--protocol-min", "3", "--protocol-max", "4"], { encoding: "utf8" });
  assert.match(output, /compatible/u);
  assert.throws(() => execFileSync(process.execPath, [gate, "--registry", path,
    "--protocol-min", "3", "--protocol-max", "3", "--ios-hard-version", "1.0.0",
    "--ios-hard-build", "3"]), /Command failed/u);
});


test("retirement excludes legacy minimum violations in every authoritative compatibility gate", () => {
  const directory = mkdtempSync(join(tmpdir(), "retirement-gates-"));
  try {
    const path = join(directory, "registry.json");
    const seed = JSON.parse(readFileSync(new URL("../../config/mobile-release-registry.seed.json", import.meta.url)));
    const request = { reservationId: seed.releases[0].reservationId, action: "retire",
      actionId: "retire-gate-ios-1", actor: "operator", note: RETIREMENT_NOTE, recordedAt: "2026-09-25T12:00:00Z" };
    const retired = changeReleaseRetirement(seed, request);
    // Build 8 stays protected through the upload-attempt fallback, even without support flags.
    const current = { ...seed.releases[0], reservationId: "beta-ios-8:ios", releaseId: "beta-ios-8",
      build: 8, compatibilityProtected: false };
    retired.releases.push(current); retired.nextBuild.ios = 9;
    const intent = { schemaVersion: 1, intentId: "retirement-gate-intent", serverSha: "b".repeat(40),
      candidateComponentSha: "c".repeat(40), preparedReceiptSha: "d".repeat(64), preSwitchEnvSha: "e".repeat(64),
      serverProtocol: { min: 3, max: 3 }, hardMinimum: { ios: { version: "1.0.0", build: 8 },
      android: { version: "1.0.0", build: 0 } }, createdAt: "2026-09-25T13:00:00Z" };
    const nativeJson = JSON.stringify({ serverProtocol: intent.serverProtocol, hardMinimum: intent.hardMinimum });
    const nativeSha = createHash("sha256").update(nativeJson).digest("hex");
    const runners = [["module", (registry) => {
      writeFileSync(path, JSON.stringify(registry));
      return execFileSync(process.execPath, [gate, "--registry", path, "--protocol-min", "3", "--protocol-max", "3",
        "--ios-hard-version", "1.0.0", "--ios-hard-build", "8"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    }]];
    for (const file of ["deploy-control.sh", "deploy-test-update.sh"]) {
      const source = readFileSync(new URL(`../release/vps/${file}`, import.meta.url), "utf8");
      const anchor = source.indexOf('const [path, intentId, target, preparedReceipt, preparedEnv, component');
      const start = source.lastIndexOf('const fs = require("node:fs");', anchor);
      const end = source.indexOf("\nNODE", anchor);
      const code = source.slice(start, end);
      runners.push([file, (registry) => {
        writeFileSync(path, JSON.stringify({ ...registry, activationIntent: intent }));
        const args = [path, intent.intentId, intent.serverSha, intent.preparedReceiptSha, intent.preSwitchEnvSha,
          intent.candidateComponentSha, nativeJson, nativeSha];
        // Inline fences are the actual standalone Node programs shipped to the VPS.
        return execFileSync(process.execPath, ["-e", code.replace("process.argv.slice(2)", "process.argv.slice(1)"), ...args],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      }]);
    }
    for (const [name, run] of runners) {
      assert.equal(JSON.parse(run(retired)).checked, 2, name);
      const duplicated = structuredClone(retired);
      duplicated.releases.push({ ...duplicated.releases[0], reservationId: "duplicate-ios-1:ios", releaseId: "duplicate-ios-1" });
      duplicated.retirementAudit.push({ ...duplicated.retirementAudit[0], actionId: "duplicate-retire-ios-1",
        identity: { ...duplicated.retirementAudit[0].identity, reservationId: "duplicate-ios-1:ios", releaseId: "duplicate-ios-1" } });
      assert.throws(() => run(duplicated), /Command failed/u, `${name}: duplicate allocated build audit refused`);
      const restored = changeReleaseRetirement(retired, { ...request, action: "unretire", actionId: "unretire-gate-ios-1",
        note: "restore support", recordedAt: "2026-09-25T12:01:00Z" });
      assert.throws(() => run(restored), /Command failed/u, `${name}: unretired legacy minimum is enforced`);
      const incompatible = structuredClone(retired); incompatible.releases[2].protocol = { min: 2, max: 2 };
      assert.throws(() => run(incompatible), /Command failed/u, `${name}: beta remains protected`);
      const other = structuredClone(retired); other.releases[1].protocol = { min: 2, max: 2 };
      assert.throws(() => run(other), /Command failed/u, `${name}: other legacy remains protected`);
      for (const audit of [null, {}, [{ ...retired.retirementAudit[0], note: "wrong" }],
        [retired.retirementAudit[0], retired.retirementAudit[0]],
        [{ ...retired.retirementAudit[0], identity: { ...retired.retirementAudit[0].identity, build: 8,
          reservationId: current.reservationId, releaseId: current.releaseId } }]]) {
        assert.throws(() => run({ ...retired, retirementAudit: audit }), /Command failed/u, `${name}: malformed audit refused`);
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
