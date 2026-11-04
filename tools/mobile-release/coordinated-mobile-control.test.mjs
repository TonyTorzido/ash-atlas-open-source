import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildTrustedStoreRequest,
  runCoordinatedControl,
  validateStoreStepResult
} from "./coordinated-mobile-control.mjs";
import { releaseIdForOperation } from "./coordinated-mobile-bootstrap-provider.mjs";
import { signCoordinatedServerEvidence } from "./coordinated-receipts.mjs";
import { artifactSha256 } from "./coordinated-build-boundary.mjs";
import { validateRequest as validateTrustedStoreRequest } from "./coordinated-trusted-store-adapter.mjs";

const operationId = "coord-control-fixture";
const generation = "t1251";
const serverSha = "a".repeat(40);
const acceptedMasterSha = "b".repeat(40);
const currentServerSha = "c".repeat(40);
const toolingSha = "d".repeat(40);
const now = "2026-09-22T12:00:00.000Z";

function manifestFingerprint(manifest) {
  const copy = structuredClone(manifest);
  delete copy.manifest_sha256;
  return createHash("sha256").update(JSON.stringify(copy)).digest("hex");
}

function fixturePlan({ daily = false } = {}) {
  const plan = { apps: {
    ios: { marketing_version: "1.2.0", metadata_sha256: "1".repeat(64), countries: ["US"],
      rollout: { kind: "update", mode: "manual" }, managed_publishing: false },
    android: { marketing_version: "1.2.0", metadata_sha256: "2".repeat(64), countries: ["US"],
      rollout: { kind: "update", mode: "staged", fraction: 0.1 }, managed_publishing: true }
  } };
  if (daily) {
    plan.delivery_mode = "daily-testers";
    plan.apps.ios.tester_destination = { kind: "testflight", group_type: "internal", group_id: "internal-1" };
    plan.apps.android.tester_destination = { kind: "google-play-internal", track: "internal" };
  }
  return plan;
}

function makeHarness({ responseLoss = false, responseLossPlatform = "ios", registryResponseLoss = false,
  omitReconcileMutationProof = false, builderFailureOnce = false, artifactBuildMismatch = false,
  marketingVersionMismatch = false, delayedPublic = false, handoffRoot = null,
  operationIdOverride = operationId, daily = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ash-atlas-coordinated-control-"));
  const source = join(root, "source");
  const tooling = join(root, "tooling");
  const handoff = handoffRoot ?? join(root, "handoff");
  const opId = operationIdOverride;
  mkdirSync(source); mkdirSync(tooling); mkdirSync(handoff, { recursive: true });
  const statePath = join(root, "state.json");
  const registryFile = join(root, "registry.json");
  writeFileSync(registryFile, JSON.stringify({
    schemaVersion: 1, buildFloor: { ios: 2, android: 2 }, nextBuild: { ios: 2, android: 2 }, releases: []
  }));
  const calls = [];
  const signerRequests = [];
  const releaseId = () => releaseIdForOperation(opId);
  const reservation = (platform, build) => ({
    reservationId: `${releaseId()}:${platform}`, releaseId: releaseId(), platform,
    marketingVersion: "1.2.0", build, generation, sourceSha: serverSha,
    protocol: { min: 3, max: 3 }, reservedAt: now, uploadAttempted: false,
    uploaded: false, processed: false, internal: false, externalApproved: false, open: false,
    downloadTested: false, supported: false, compatibilityProtected: false,
    artifactSha256: null, storeBuildId: null, receiptUrl: null, releaseMode: "production",
    availabilityPending: null, milestones: { reserved: true }
  });
  let lostSubmit = responseLoss;
  let builderFailed = false;
  let lostReceipt = registryResponseLoss;
  let delayedPublicPending = delayedPublic;
  const registryRunner = (_request, args) => {
    calls.push({ kind: "registry", command: args[0], args });
    if (args[0] === "reserve") {
      return { registrySha256: "e".repeat(64), allocations: { ios: 12, android: 72 },
        reservations: { ios: reservation("ios", 12), android: reservation("android", 72) } };
    }
    if (lostReceipt) {
      lostReceipt = false;
      throw new Error("simulated registry response loss after receipt push");
    }
    return { registrySha256: "f".repeat(64) };
  };
  const unsignedRunner = ({ request }) => {
    if (builderFailureOnce && !builderFailed) {
      builderFailed = true;
      return { status: "ACTION_REQUIRED", reason: "fixture builder unavailable" };
    }
    const artifacts = ["ios.xcarchive", "android.aab"].map((name) => {
      const path = join(request.quarantine_root, name);
      if (name.startsWith("ios")) {
        mkdirSync(path, { recursive: true });
        writeFileSync(join(path, "Info.plist"), name);
      } else writeFileSync(path, name);
      const platform = name.startsWith("ios") ? "ios" : "android";
      const reserved = request.reserved_versions[platform];
      return { platform, kind: platform === "ios" ? "xcarchive" : "aab", path,
        marketing_version: reserved.marketingVersion,
        build: artifactBuildMismatch ? Number(reserved.build) + 1 : Number(reserved.build),
        sha256: artifactSha256(path) };
    });
    const manifest = { schema_version: 1, kind: "ash-atlas-coordinated-unsigned-artifact-manifest",
      operation_id: request.operation_id, generation: request.generation, source_sha: request.source_sha,
      source_repository_root: request.source_repository_root, tooling_root: request.tooling_root,
      registry_remote: request.registry_remote, reserved_versions: request.reserved_versions,
      protocol: request.protocol, push_config: null, quarantine_root: request.quarantine_root, artifacts };
    return { ...manifest, manifest_sha256: manifestFingerprint(manifest), status: "ok" };
  };
  const signerRunner = ({ request, unsignedManifest }) => {
    signerRequests.push(request);
    const artifacts = unsignedManifest.artifacts.map((source) => {
      const path = join(request.signed_quarantine_root, `${source.platform}.signed`);
      writeFileSync(path, `${source.platform}-signed`);
      return { platform: source.platform, kind: source.platform === "ios" ? "ipa" : "aab",
        signed_path: path, sha256: artifactSha256(path) };
    });
    const base = { schema_version: 1, kind: "ash-atlas-coordinated-signed-artifact-manifest",
      operation_id: request.operation_id, generation: request.generation, source_sha: request.source_sha,
      unsigned_manifest_sha256: unsignedManifest.manifest_sha256, tooling_root: request.tooling_root,
      signed_quarantine_root: request.signed_quarantine_root, artifacts: artifacts.map((entry) => ({
        ...entry, unsigned_sha256: unsignedManifest.artifacts.find((source) => source.platform === entry.platform).sha256
      })) };
    return { ...base, manifest_sha256: manifestFingerprint(base), status: "ok" };
  };
  const storeProviderRunner = ({ request, state, platform, action, attemptId, extra = {} }) => {
    const payload = { ...buildTrustedStoreRequest(request, state, platform, action, attemptId), ...extra };
    validateTrustedStoreRequest(payload);
    const candidateRequest = payload.candidate;
    calls.push({ kind: "store", platform, action, attemptId, extra, candidate: candidateRequest });
    if (lostSubmit && platform === responseLossPlatform && action === "submit") {
      lostSubmit = false;
      throw new Error("simulated response loss after remote submit");
    }
    const candidate = { ...candidateRequest, operationId: candidateRequest.operation_id,
      releaseId: candidateRequest.release_id, sourceSha: candidateRequest.source_sha,
      marketingVersion: marketingVersionMismatch ? "9.9.9" : candidateRequest.marketing_version,
      storeBuildId: candidateRequest.tester_destination && platform === "android"
        ? String(candidateRequest.build) : `${platform}-${candidateRequest.build}`,
      artifactSha256: candidateRequest.artifact_sha256, toolingSha: candidateRequest.tooling_sha,
      metadataHash: candidateRequest.metadata_sha256,
      ...(platform === "android" ? { managedPublishing: true } : {}) };
    const targetAction = action === "reconcile" ? extra.target_action : action;
    const terminal = targetAction === "release" || (action === "reconcile" && state.server_evidence);
    const ready = ["submit", "reconcile"].includes(targetAction) || terminal;
    const publicAvailable = terminal && !delayedPublicPending;
    if (action === "reconcile" && state.server_evidence && delayedPublicPending) delayedPublicPending = false;
    const snapshot = candidateRequest.tester_destination
      ? { tester: platform === "ios"
        ? { platform: "ios", group_type: "internal", group_id: "internal-1",
          marketing_version: candidateRequest.marketing_version, build: Number(candidateRequest.build),
          store_build_id: `${platform}-${candidateRequest.build}`, artifact_sha256: candidateRequest.artifact_sha256,
           status: terminal ? "IN_BETA_TESTING" : "READY_FOR_BETA_TESTING", available: terminal,
           prepared: true }
        : { platform: "android", marketing_version: candidateRequest.marketing_version,
          build: Number(candidateRequest.build), store_build_id: String(candidateRequest.build),
          artifact_sha256: candidateRequest.artifact_sha256, track: "internal", status: "completed",
           lifecycle_status: "RELEASE_LIFECYCLE_STATE_PUBLISHED",
           active_artifact_version_code: Number(candidateRequest.build), available: terminal,
           prepared: true } }
      : platform === "ios"
      ? { versions: [{ versionString: "1.2.0", buildId: `${platform}-${candidateRequest.build}`,
        state: publicAvailable ? "READY_FOR_DISTRIBUTION" : ready ? "PENDING_DEVELOPER_RELEASE" : "READY_FOR_REVIEW" }] }
      : { managedPublishing: true,
        productionTrack: { releases: [{ name: `t1251 (${candidateRequest.build})`, versionCodes: [candidateRequest.build], status: publicAvailable ? "inProgress" : "inProgress" }] },
        productionLifecycle: [{ name: `t1251 (${candidateRequest.build})`, versionCodes: [candidateRequest.build],
          lifecycleState: publicAvailable ? "RELEASE_LIFECYCLE_STATE_PUBLISHED" :
            ready ? "RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED" : "RELEASE_LIFECYCLE_STATE_IN_REVIEW" }] };
    const result = { schema_version: 1, kind: "ash-atlas-coordinated-store-step-result", status: "ok",
      coordinated_operation_id: request.operationId, platform, action, candidate, snapshot,
      production: { operations: [] }, operation: { operationId: attemptId, action: targetAction,
        status: "succeeded", receipt: { observed: { authoritative: true, matched: true } } },
      observed_at_utc: now };
    if (action === "reconcile" && state.platforms[platform].pending && !omitReconcileMutationProof) {
      result.mutation_status = "confirmed";
    }
    return result;
  };
  const gitRunner = (_cwd, args) => args[0] === "status" ? "" : (args[0] === "rev-parse" ?
    (_cwd === source ? serverSha : toolingSha) : "");
  const request = {
    action: "start", operationId: opId, generation, serverSha, acceptedMasterSha, currentServerSha, toolingSha,
    sourceRepositoryRoot: source, toolingRoot: tooling, registryRemote: "example-org/game",
    registryFile, handoffRoot: handoff, statePath, seedPath: join(root, "seed.json"),
    receiptPath: join(root, "receipt.json"), reservedVersions: {
      ios: { marketingVersion: "1.2.0" }, android: { marketingVersion: "1.2.0" }
    }, now, env: {}, gitRunner, registryRunner, unsignedRunner, signerRunner, storeProviderRunner,
    plan: fixturePlan({ daily })
  };
  return { root, request, calls, signerRequests,
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("private control runs reservation, signed handoff, store lifecycle, and receipts", () => {
  const harness = makeHarness();
  try {
    const result = runCoordinatedControl(harness.request);
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(result.phase, "apps_ready");
    assert.equal(result.receipts.length, 2);
    assert.equal(harness.signerRequests[0].schema_version, 1);
    assert.equal(harness.signerRequests[0].kind, "ash-atlas-coordinated-sign-request");
    assert.ok(harness.calls.some((entry) => entry.kind === "registry" && entry.command === "reserve"));
    assert.deepEqual(harness.calls.filter((entry) => entry.kind === "store").map((entry) => entry.action),
      ["upload", "prepare", "submit", "reconcile", "upload", "prepare", "submit", "reconcile"]);
    const iosReconcile = harness.calls.find((entry) => entry.kind === "store" && entry.platform === "ios" &&
      entry.action === "reconcile");
    const androidReconcile = harness.calls.find((entry) => entry.kind === "store" && entry.platform === "android" &&
      entry.action === "reconcile");
    assert.equal(iosReconcile.attemptId, `${operationId}:ios:submit`);
    assert.equal(androidReconcile.attemptId, `${operationId}:android:submit`);
    assert.equal(iosReconcile.extra.target_action, "submit");
    assert.equal(androidReconcile.extra.target_action, "submit");
    assert.equal(JSON.parse(readFileSync(harness.request.statePath, "utf8")).signed.unsigned_manifest_sha256.length, 64);
  } finally { harness.cleanup(); }
});

test("daily control prepares both candidates without exposing testers before server publication", () => {
  const harness = makeHarness({ daily: true });
  try {
    const result = runCoordinatedControl(harness.request);
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(result.phase, "apps_ready");
    assert.equal(result.receipts.every((receipt) => receipt.tester_available === false), true);
    assert.equal(result.receipts.every((receipt) => receipt.tester_prepared === true), true);
    assert.equal(result.receipts.every((receipt) => receipt.release_requested === false), true);
    assert.equal(result.receipts.every((receipt) => receipt.public_available === false), true);
    assert.equal(JSON.parse(readFileSync(harness.request.seedPath, "utf8")).delivery_mode, "daily-testers");
    assert.equal(JSON.parse(readFileSync(harness.request.seedPath, "utf8")).apps.android.ready, true);
    assert.deepEqual(harness.calls.filter((entry) => entry.kind === "store").map((entry) => entry.action),
      ["upload", "prepare", "submit", "reconcile", "upload", "prepare", "submit", "reconcile"]);
  } finally { harness.cleanup(); }
});

test("daily tester activation waits for authenticated server health", () => {
  const harness = makeHarness({ daily: true });
  try {
    const prepared = runCoordinatedControl(harness.request);
    const state = JSON.parse(readFileSync(harness.request.statePath, "utf8"));
    const evidence = signCoordinatedServerEvidence({ schemaVersion: 1,
      kind: "ash-atlas-coordinated-server-evidence", coordinated_operation_id: operationId,
      phase: "server_healthy", source_sha: serverSha, server_sha: serverSha,
      accepted_master_sha: acceptedMasterSha, generation, published: true, activated: true, healthy: true,
      nonce: "e".repeat(32), candidates: Object.fromEntries(["ios", "android"].map((platform) => [platform, {
        child_operation_id: `${operationId}:${platform}`, candidate: state.platforms[platform].candidate,
        approval_fingerprint: state.platforms[platform].receipt.approval.fingerprint
      }])), health: { public_release_sha: serverSha, deployment_receipt_sha256: "f".repeat(64), verification_result: "ok" },
      observed_at_utc: now }, Buffer.alloc(32, 7));
    assert.equal(prepared.phase, "apps_ready");
    assert.equal(prepared.receipts.every((receipt) => receipt.tester_available === false), true);
    const result = runCoordinatedControl({ ...harness.request, action: "post-health",
      serverEvidence: evidence, env: { COORDINATED_SERVER_EVIDENCE_HMAC_KEY: Buffer.alloc(32, 7).toString("base64") } });
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(result.phase, "completed");
    assert.equal(result.receipts.every((receipt) => receipt.tester_available === true), true);
    assert.equal(result.receipts.every((receipt) => receipt.release_requested === true), true);
    assert.equal(harness.calls.filter((entry) => entry.kind === "store" && entry.action === "release").length, 2);
    assert.equal(harness.calls.filter((entry) => entry.kind === "store" && entry.action === "reconcile" &&
      entry.extra.target_action === "release").length, 0);
  } finally { harness.cleanup(); }
});

test("resume rejects a delivery mode change for the durable operation", () => {
  const harness = makeHarness({ daily: true });
  try {
    assert.equal(runCoordinatedControl(harness.request).status, "ok");
    assert.throws(() => runCoordinatedControl({ ...harness.request, action: "resume",
      plan: fixturePlan() }), /delivery mode changed for the active operation/u);
  } finally { harness.cleanup(); }
});

test("later store actions retain the verified internal store build identity", () => {
  const harness = makeHarness();
  try {
    assert.equal(runCoordinatedControl(harness.request).status, "ok");
    const prepare = harness.calls.find((entry) => entry.kind === "store" && entry.platform === "ios" &&
      entry.action === "prepare");
    assert.equal(prepare.candidate.store_build_id, "ios-12");
  } finally { harness.cleanup(); }
});

test("lost submit response stays pending and resume reconciles the same attempt", () => {
  const harness = makeHarness({ responseLoss: true });
  try {
    const first = runCoordinatedControl(harness.request);
    assert.equal(first.status, "ACTION_REQUIRED");
    assert.deepEqual(harness.calls.filter((entry) => entry.kind === "store").map((entry) => entry.action),
      ["upload", "prepare", "submit"]);
    const pending = JSON.parse(readFileSync(harness.request.statePath, "utf8"));
    assert.equal(pending.platforms.ios.pending.action, "submit");
    const resumed = runCoordinatedControl({ ...harness.request, action: "resume" });
    assert.equal(resumed.status, "ok", JSON.stringify(resumed));
    assert.equal(resumed.phase, "apps_ready");
    const reconcile = harness.calls.find((entry) => entry.kind === "store" && entry.action === "reconcile");
    assert.equal(reconcile.attemptId, `${operationId}:ios:submit`);
    assert.equal(harness.calls.filter((entry) => entry.kind === "store" && entry.platform === "ios" &&
      entry.action === "submit").length, 1);
  } finally { harness.cleanup(); }
});

test("resume fails closed when a lost submit reconcile omits mutation proof", () => {
  const harness = makeHarness({ responseLoss: true, omitReconcileMutationProof: true });
  try {
    const first = runCoordinatedControl(harness.request);
    assert.equal(first.status, "ACTION_REQUIRED");
    const resumed = runCoordinatedControl({ ...harness.request, action: "resume" });
    assert.equal(resumed.status, "ACTION_REQUIRED");
    assert.match(resumed.action_required.reason, /omitted explicit mutation proof/u);
    const state = JSON.parse(readFileSync(harness.request.statePath, "utf8"));
    assert.equal(state.platforms.ios.pending.action, "submit");
    assert.equal(harness.calls.filter((entry) => entry.kind === "store" && entry.platform === "ios" &&
      entry.action === "submit").length, 1);
  } finally { harness.cleanup(); }
});

test("resume continues a second platform after the first platform loses its submit response", () => {
  const harness = makeHarness({ responseLoss: true, responseLossPlatform: "android" });
  try {
    const first = runCoordinatedControl(harness.request);
    assert.equal(first.status, "ACTION_REQUIRED");
    const pending = JSON.parse(readFileSync(harness.request.statePath, "utf8"));
    assert.equal(pending.platforms.android.pending.action, "submit");
    const resumed = runCoordinatedControl({ ...harness.request, action: "resume" });
    assert.equal(resumed.status, "ok", JSON.stringify(resumed));
    assert.ok(harness.calls.some((entry) => entry.kind === "store" && entry.platform === "android" &&
      entry.action === "reconcile"));
    assert.equal(harness.calls.filter((entry) => entry.kind === "store" && entry.platform === "android" &&
      entry.action === "submit").length, 1);
  } finally { harness.cleanup(); }
});

test("resume clears a builder prerequisite and starts both platform lifecycles", () => {
  const harness = makeHarness({ builderFailureOnce: true });
  try {
    const first = runCoordinatedControl(harness.request);
    assert.equal(first.status, "ACTION_REQUIRED");
    const pending = JSON.parse(readFileSync(harness.request.statePath, "utf8"));
    assert.equal(pending.platforms.ios.pending, null);
    assert.equal(pending.platforms.android.pending, null);
    const resumed = runCoordinatedControl({ ...harness.request, action: "resume" });
    assert.equal(resumed.status, "ok", JSON.stringify(resumed));
    assert.deepEqual(harness.calls.filter((entry) => entry.kind === "store").map((entry) => entry.action),
      ["upload", "prepare", "submit", "reconcile", "upload", "prepare", "submit", "reconcile"]);
  } finally { harness.cleanup(); }
});

test("allocated build identity is checked before store work", () => {
  const harness = makeHarness({ artifactBuildMismatch: true });
  try {
    const result = runCoordinatedControl(harness.request);
    assert.equal(result.status, "ACTION_REQUIRED");
    assert.match(result.action_required.reason, /build does not match its reservation/u);
    assert.equal(harness.calls.some((entry) => entry.kind === "store"), false);
  } finally { harness.cleanup(); }
});

test("store result marketing version remains bound to the reserved candidate", () => {
  const harness = makeHarness({ marketingVersionMismatch: true });
  try {
    const result = runCoordinatedControl(harness.request);
    assert.equal(result.status, "ACTION_REQUIRED");
    assert.match(result.action_required.reason, /immutable identity/u);
  } finally { harness.cleanup(); }
});

test("operation handoff paths isolate day two durable artifacts", () => {
  const shared = mkdtempSync(join(tmpdir(), "ash-atlas-coordinated-handoff-"));
  const handoff = join(shared, "handoff");
  const first = makeHarness({ handoffRoot: handoff, operationIdOverride: "coord-day-one" });
  const second = makeHarness({ handoffRoot: handoff, operationIdOverride: "coord-day-two" });
  try {
    assert.equal(runCoordinatedControl(first.request).status, "ok");
    const firstState = JSON.parse(readFileSync(first.request.statePath, "utf8"));
    const firstManifest = readFileSync(firstState.unsigned.path, "utf8");
    assert.equal(runCoordinatedControl(second.request).status, "ok");
    const secondState = JSON.parse(readFileSync(second.request.statePath, "utf8"));
    assert.notEqual(firstState.handoff_root, secondState.handoff_root);
    assert.notEqual(firstState.unsigned.path, secondState.unsigned.path);
    assert.equal(readFileSync(firstState.unsigned.path, "utf8"), firstManifest);
  } finally {
    first.cleanup();
    second.cleanup();
    rmSync(shared, { recursive: true, force: true });
  }
});

test("post-health releases only after authenticated controller evidence", () => {
  const harness = makeHarness();
  try {
    const prepared = runCoordinatedControl(harness.request);
    const state = JSON.parse(readFileSync(harness.request.statePath, "utf8"));
    const evidence = signCoordinatedServerEvidence({ schemaVersion: 1,
      kind: "ash-atlas-coordinated-server-evidence", coordinated_operation_id: operationId,
      phase: "server_healthy", source_sha: serverSha, server_sha: serverSha,
      accepted_master_sha: acceptedMasterSha, generation, published: true, activated: true, healthy: true,
      nonce: "a".repeat(32), candidates: Object.fromEntries(["ios", "android"].map((platform) => [platform, {
        child_operation_id: `${operationId}:${platform}`, candidate: state.platforms[platform].candidate,
        approval_fingerprint: state.platforms[platform].receipt.approval.fingerprint
      }])), health: { public_release_sha: serverSha, deployment_receipt_sha256: "b".repeat(64), verification_result: "ok" },
      observed_at_utc: now }, Buffer.alloc(32, 7));
    const result = runCoordinatedControl({ ...harness.request, action: "post-health",
      serverEvidence: evidence, env: { COORDINATED_SERVER_EVIDENCE_HMAC_KEY: Buffer.alloc(32, 7).toString("base64") } });
    assert.equal(prepared.phase, "apps_ready");
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(result.phase, "completed");
    assert.equal(result.receipts.every((receipt) => receipt.public_available), true);
  } finally { harness.cleanup(); }
});

test("post-health keeps polling approved apps until public availability", () => {
  const harness = makeHarness({ delayedPublic: true });
  try {
    runCoordinatedControl(harness.request);
    const state = JSON.parse(readFileSync(harness.request.statePath, "utf8"));
    const evidence = signCoordinatedServerEvidence({ schemaVersion: 1,
      kind: "ash-atlas-coordinated-server-evidence", coordinated_operation_id: operationId,
      phase: "server_healthy", source_sha: serverSha, server_sha: serverSha,
      accepted_master_sha: acceptedMasterSha, generation, published: true, activated: true, healthy: true,
      nonce: "c".repeat(32), candidates: Object.fromEntries(["ios", "android"].map((platform) => [platform, {
        child_operation_id: `${operationId}:${platform}`, candidate: state.platforms[platform].candidate,
        approval_fingerprint: state.platforms[platform].receipt.approval.fingerprint
      }])), health: { public_release_sha: serverSha, deployment_receipt_sha256: "d".repeat(64), verification_result: "ok" },
      observed_at_utc: now }, Buffer.alloc(32, 7));
    const first = runCoordinatedControl({ ...harness.request, action: "post-health",
      serverEvidence: evidence, env: { COORDINATED_SERVER_EVIDENCE_HMAC_KEY: Buffer.alloc(32, 7).toString("base64") } });
    assert.equal(first.status, "ok", JSON.stringify(first));
    assert.equal(first.phase, "apps_release_requested");
    assert.equal(first.receipts.every((receipt) => receipt.public_available), false);
    const second = runCoordinatedControl({ ...harness.request, action: "post-health",
      serverEvidence: evidence, env: { COORDINATED_SERVER_EVIDENCE_HMAC_KEY: Buffer.alloc(32, 7).toString("base64") } });
    assert.equal(second.status, "ok", JSON.stringify(second));
    assert.equal(second.phase, "completed");
    assert.equal(second.receipts.every((receipt) => receipt.public_available), true);
    assert.equal(harness.calls.filter((entry) => entry.kind === "store" && entry.platform === "ios" &&
      entry.action === "release").length, 1);
    assert.equal(harness.calls.filter((entry) => entry.kind === "store" && entry.platform === "android" &&
      entry.action === "release").length, 1);
  } finally { harness.cleanup(); }
});

test("registry receipt response loss is retried before the pending store step", () => {
  const harness = makeHarness({ registryResponseLoss: true });
  try {
    const first = runCoordinatedControl(harness.request);
    assert.equal(first.status, "ACTION_REQUIRED");
    const pending = JSON.parse(readFileSync(harness.request.statePath, "utf8"));
    assert.equal(pending.registry_receipt_pending.platform, "ios");
    const resumed = runCoordinatedControl({ ...harness.request, action: "resume" });
    assert.equal(resumed.status, "ok");
    const state = JSON.parse(readFileSync(harness.request.statePath, "utf8"));
    assert.equal(state.registry_receipt_pending, null);
    assert.equal(state.platforms.ios.completed_steps.includes("upload"), true);
    assert.equal(harness.calls.filter((entry) => entry.kind === "store" && entry.platform === "ios" &&
      entry.action === "upload").length, 1);
  } finally { harness.cleanup(); }
});

test("store result rejects a cross-operation candidate before receipt recording", () => {
  const harness = makeHarness();
  try {
    const expected = { ...fixturePlan().apps.ios, release_id: "coord-other", build: 2,
      artifact_sha256: "a".repeat(64), tooling_sha: toolingSha, countries: ["US"],
      rollout: { kind: "update", mode: "manual" } };
    assert.throws(() => validateStoreStepResult({ schema_version: 1,
      kind: "ash-atlas-coordinated-store-step-result", status: "ok", coordinated_operation_id: operationId,
      platform: "ios", action: "upload", candidate: { ...expected, release_id: "coord-different",
        platform: "ios", source_sha: serverSha,
        generation, store_build_id: "ios-2", operation_id: `${operationId}:ios` }, snapshot: {}, production: {} },
      { operationId, generation, serverSha, toolingSha }, "ios", "upload", expected),
    /immutable identity/u);
  } finally { harness.cleanup(); }
});

test("upload reconciliation accepts an explicit no-mutation result without a candidate", () => {
  const result = validateStoreStepResult({
    schema_version: 1, kind: "ash-atlas-coordinated-store-step-result", status: "ok",
    coordinated_operation_id: operationId, platform: "ios", action: "reconcile",
    candidate: null, snapshot: { internal_verified: { status: "not_attempted" } },
    production: { operations: [] }, mutation_status: "not_mutated"
  }, { operationId, generation, serverSha, toolingSha }, "ios", "reconcile", {});
  assert.equal(result.mutation_status, "not_mutated");
  assert.throws(() => validateStoreStepResult({ ...result, mutation_status: undefined },
    { operationId, generation, serverSha, toolingSha }, "ios", "reconcile", {}),
  /missing its candidate identity/u);
});
