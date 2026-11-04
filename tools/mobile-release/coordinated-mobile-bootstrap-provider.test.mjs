import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  assertProductionCandidateCanBeReplaced,
  internalUploadRecoveryAction,
  releaseIdForOperation,
  runCoordinatedBootstrap,
  safeProviderFailureReason,
  validateBootstrapPlan
} from "./coordinated-mobile-bootstrap-provider.mjs";

const operationId = "coord-provider-fixture";
const generation = "t1251";
const serverSha = "a".repeat(40);
const acceptedMasterSha = "b".repeat(40);
const currentServerSha = "c".repeat(40);

function packet(platform) {
  return {
    schemaVersion: 1,
    platform,
    ...(platform === "ios" ? { bundleId: "com.ashatlas.game" } : { packageName: "com.ashatlas.game" }),
    marketingVersion: "1.2.0",
    localizations: [{ locale: "en-US", description: "Ash Atlas", keywords: "ash atlas" }],
    policy: { countries: ["US"], rollout: { kind: "update", mode: "manual" } }
  };
}

test("protected bootstrap plan derives both exact metadata identities", () => {
  const directory = mkdtempSync(join(tmpdir(), "ash-atlas-provider-plan-"));
  try {
    const ios = join(directory, "ios.json");
    const android = join(directory, "android.json");
    writeFileSync(ios, `${JSON.stringify(packet("ios"))}\n`);
    writeFileSync(android, `${JSON.stringify(packet("android"))}\n`);
    const plan = validateBootstrapPlan({
      schemaVersion: 1,
      kind: "ash-atlas-coordinated-mobile-bootstrap-plan",
      apps: {
        ios: { metadata_packet_path: ios },
        android: { metadata_packet_path: android, managed_publishing: true }
      }
    }, { operationId, generation, serverSha, acceptedMasterSha, currentServerSha, workspace: resolve(".") });
    assert.equal(plan.apps.ios.marketingVersion, "1.2.0");
    assert.equal(plan.apps.android.metadataHash.length, 64);
    assert.equal(releaseIdForOperation(operationId).startsWith("coord-"), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("provider rejects metadata packets inside the checked-out tag", () => {
  assert.throws(() => validateBootstrapPlan({
    schemaVersion: 1,
    kind: "ash-atlas-coordinated-mobile-bootstrap-plan",
    apps: {
      ios: { metadata_packet_path: resolve("package.json") },
      android: { metadata_packet_path: resolve("package.json"), managed_publishing: true }
    }
  }, { operationId, generation, serverSha, acceptedMasterSha, currentServerSha, workspace: resolve(".") }),
  /outside the checked-out repository/u);
});

test("fixture resume uses the same operation boundary without credentials or store calls", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ash-atlas-provider-fixture-"));
  try {
    const fixturePath = join(directory, "result.json");
    const fixture = { schemaVersion: 1, kind: "ash-atlas-coordinated-mobile-result",
      coordinated_operation_id: operationId, receipts: [], platforms: {} };
    writeFileSync(fixturePath, `${JSON.stringify(fixture)}\n`);
    const result = await runCoordinatedBootstrap({ action: "resume", operationId, generation,
      serverSha, acceptedMasterSha, currentServerSha,
      env: { COORDINATED_BOOTSTRAP_FIXTURE_RESULT: fixturePath } });
    assert.equal(result.coordinated_operation_id, operationId);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("provisioned private control provider is invoked through the external boundary", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ash-atlas-provider-external-"));
  try {
    const source = join(directory, "source");
    const tooling = join(directory, "tooling");
    mkdirSync(source); mkdirSync(tooling);
    const builder = join(directory, "builder.mjs");
    const signer = join(directory, "signer.mjs");
    const supervisor = join(directory, "supervisor.mjs");
    const gate = join(directory, "gate.mjs");
    const provider = join(directory, "private-control.mjs");
    for (const path of [builder, signer, supervisor, gate]) writeFileSync(path, "");
    writeFileSync(provider, `import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2); const request = JSON.parse(readFileSync(args[args.indexOf("--request") + 1], "utf8"));
writeFileSync(args[args.indexOf("--output") + 1], JSON.stringify({ schemaVersion: 1, kind: "ash-atlas-coordinated-mobile-result", status: "ok", coordinated_operation_id: request.operation_id, receipts: [] }));`);
    const result = await runCoordinatedBootstrap({ action: "start", operationId, generation, serverSha,
      acceptedMasterSha, currentServerSha, env: {
        COORDINATED_SOURCE_REPOSITORY: source, COORDINATED_TOOLING_ROOT: tooling,
        ASH_ATLAS_REGISTRY_REPOSITORY: "example-org/game",
        COORDINATED_ISOLATED_BUILDER: builder,
        COORDINATED_ISOLATED_BUILDER_SHA256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        COORDINATED_TRUSTED_SIGNER: signer,
        COORDINATED_ISOLATED_BUILD_SUPERVISOR: supervisor,
        COORDINATED_ISOLATED_BUILD_SUPERVISOR_SHA256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        COORDINATED_ISOLATED_BUILD_GATE: gate,
        COORDINATED_ISOLATED_BUILD_GATE_SHA256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        COORDINATED_ISOLATED_BUILD_IDENTITY: "fixture-builder", COORDINATED_TRUSTED_SIGNER_ID: "fixture-signer",
        COORDINATED_MOBILE_CONTROL_PROVIDER: provider
      } });
    assert.equal(result.status, "ok");
    assert.equal(result.coordinated_operation_id, operationId);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("missing trusted prerequisites writes durable ACTION_REQUIRED through the real CLI", () => {
  const directory = mkdtempSync(join(tmpdir(), "ash-atlas-provider-action-required-"));
  try {
    const output = join(directory, "provider-result.json");
    assert.throws(() => execFileSync(process.execPath, ["tools/mobile-release/coordinated-mobile-bootstrap-provider.mjs",
      "--action", "start", "--operation-id", operationId, "--generation", generation,
      "--server-sha", serverSha, "--accepted-master-sha", acceptedMasterSha,
      "--current-server-sha", currentServerSha, "--output", output], {
      cwd: process.cwd(), env: { ...process.env, MOBILE_PRODUCTION_MUTATION_TOKEN: "" },
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
    }));
    const result = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(result.status, "ACTION_REQUIRED");
    assert.equal(result.coordinated_operation_id, operationId);
    assert.match(result.reason, /ACTION_REQUIRED_PROVISION_ISOLATED_BUILD/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("provider failure receipts never expose command stderr or signing secrets", () => {
  const secret = "signing-password-sentinel";
  const error = Object.assign(new Error(`Command failed: keytool --storepass ${secret}`), {
    stderr: Buffer.from(`Gradle printed ${secret}`), status: 1
  });
  const reason = safeProviderFailureReason(error);
  assert.doesNotMatch(reason, new RegExp(secret, "u"));
  assert.equal(reason, "trusted Mac provider failed during a protected step");
});

test("terminal production candidates can be replaced while active candidates remain fenced", () => {
  const candidate = { operationId: "old:ios", storeBuildId: "ios-22" };
  assert.doesNotThrow(() => assertProductionCandidateCanBeReplaced({
    phase: "completed", candidate, baseline: { storeBuildId: "ios-22" }
  }, "ios", "new:ios"));
  assert.throws(() => assertProductionCandidateCanBeReplaced({
    phase: "submitted", candidate, baseline: { storeBuildId: "ios-22" }
  }, "ios", "new:ios"), /active production candidate/u);
  assert.throws(() => assertProductionCandidateCanBeReplaced({
    phase: "completed", candidate, baseline: { storeBuildId: "ios-21" }
  }, "ios", "new:ios"), /active production candidate/u);
});

test("an interruption before upload-attempt persistence remains unresolved", () => {
  assert.equal(internalUploadRecoveryAction({ uploadAttempted: true }, "ios"), "verify");
  assert.equal(internalUploadRecoveryAction({}, "ios"), "upload");
  assert.throws(() => internalUploadRecoveryAction({ availabilityPending: { artifactSha256: "a".repeat(64) } }, "ios"),
    /upload outcome is unresolved/u);
});
