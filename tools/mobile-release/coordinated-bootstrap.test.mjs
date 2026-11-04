import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildActionRequiredResult,
  buildCoordinatedReleaseSeed,
  writeActionRequiredArtifact,
  writeCoordinatedBootstrapArtifacts
} from "./coordinated-bootstrap.mjs";
import { buildCoordinatedChildReceipt } from "./coordinated-receipts.mjs";

const operationId = "coord-bootstrap-fixture";
const generation = "t1251";
const serverSha = "a".repeat(40);
const acceptedMasterSha = "b".repeat(40);
const currentServerSha = "c".repeat(40);
const artifactSha = "d".repeat(64);
const toolSha = "e".repeat(40);
const metadataSha = "f".repeat(64);

function candidate(platform, overrides = {}) {
  return {
    platform,
    releaseId: "coord-bootstrap-release",
    operationId: `${operationId}:${platform}`,
    sourceSha: serverSha,
    acceptedSha: serverSha,
    generation,
    marketingVersion: "1.2.0",
    build: platform === "ios" ? 23 : 73,
    storeBuildId: platform === "ios" ? "ios-23" : "73",
    artifactSha256: artifactSha,
    toolSha,
    metadataHash: metadataSha,
    countries: ["US"],
    rollout: { kind: "update", mode: "staged", fraction: 0.1 },
    managedPublishing: platform === "android",
    firstLaunch: false,
    firstPublicationBootstrapVerified: false,
    ...overrides
  };
}

function snapshot(platform) {
  if (platform === "ios") {
    return { versions: [{ versionString: "1.2.0", state: "PENDING_DEVELOPER_RELEASE", buildId: "ios-23" }] };
  }
  return {
    productionTrack: { releases: [{ name: "t1251 (73)", versionCodes: ["73"], status: "inProgress", userFraction: 0.1 }] },
    productionLifecycle: [{ name: "t1251 (73)", versionCodes: ["73"], lifecycleState: "RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED" }]
  };
}

function production(candidateValue) {
  return {
    operations: [{
      operationId: `${candidateValue.operationId}:submit`,
      action: "submit",
      status: "succeeded",
      candidate: candidateValue,
      updatedAt: "2026-09-21T00:00:00Z",
      receipt: { observed: { authoritative: true, matched: true } }
    }]
  };
}

function childReceipts() {
  return ["ios", "android"].map((platform) => {
    const value = candidate(platform);
    return buildCoordinatedChildReceipt({
      coordinatedOperationId: operationId,
      candidate: value,
      production: production(value),
      snapshot: snapshot(platform),
      observedAt: "2026-09-21T00:00:00Z"
    });
  });
}

function result(receipts = childReceipts()) {
  return {
    schemaVersion: 1,
    kind: "ash-atlas-coordinated-mobile-result",
    coordinated_operation_id: operationId,
    phase: "manifest_created",
    next_phase: "server_published",
    receipts,
    platforms: Object.fromEntries(receipts.map((receipt) => [receipt.platform, receipt])),
    ios: receipts.find((receipt) => receipt.platform === "ios"),
    android: receipts.find((receipt) => receipt.platform === "android"),
    observed_at_utc: "2026-09-21T00:00:00Z"
  };
}

test("bootstrap materializes an exact server seed and both child identities", () => {
  const artifacts = buildCoordinatedReleaseSeed({ operationId, generation, serverSha,
    acceptedMasterSha, currentServerSha, result: result(), now: "2026-09-21T00:00:00Z" });
  assert.deepEqual(artifacts.seed.pinned, {
    generation,
    generation_tag: "test/t1251",
    server_sha: serverSha,
    accepted_integration_sha: serverSha,
    accepted_master_sha: acceptedMasterSha,
    current_server_sha: currentServerSha
  });
  assert.equal(artifacts.seed.apps.ios.child_operation_id, `${operationId}:ios`);
  assert.equal(artifacts.seed.apps.android.child_operation_id, `${operationId}:android`);
  assert.equal(artifacts.seed.apps.android.approval.candidate_fingerprint,
    artifacts.seed.apps.android.approval.fingerprint);
  assert.equal(artifacts.receipt.receipts.length, 2);
});

test("bootstrap preserves daily tester destinations and marks only store-observed testers ready", () => {
  const receipts = ["ios", "android"].map((platform) => {
    const destination = platform === "ios"
      ? { kind: "testflight", group_type: "internal", group_id: "internal-1" }
      : { kind: "google-play-internal", track: "internal" };
    const value = candidate(platform, { tester_destination: destination, managedPublishing: undefined });
    const observed = platform === "ios"
      ? { platform, group_type: "internal", group_id: "internal-1", marketing_version: value.marketingVersion,
        build: value.build, store_build_id: value.storeBuildId, artifact_sha256: value.artifactSha256,
        status: "IN_BETA_TESTING", available: true }
      : { platform, marketing_version: value.marketingVersion, build: value.build,
        store_build_id: value.storeBuildId, artifact_sha256: value.artifactSha256, track: "internal", status: "completed",
        lifecycle_status: "RELEASE_LIFECYCLE_STATE_PUBLISHED", active_artifact_version_code: value.build, available: true };
    return buildCoordinatedChildReceipt({ coordinatedOperationId: operationId, candidate: value,
      production: production(value), snapshot: { tester: observed }, observedAt: "2026-09-21T00:00:00Z" });
  });
  const artifacts = buildCoordinatedReleaseSeed({ operationId, generation, serverSha,
    acceptedMasterSha, currentServerSha, result: result(receipts), now: "2026-09-21T00:00:00Z" });
  assert.equal(artifacts.seed.delivery_mode, "daily-testers");
  assert.equal(artifacts.seed.apps.ios.ready, true);
  assert.equal(artifacts.seed.apps.android.ready, true);
  assert.deepEqual(artifacts.seed.apps.android.candidate.tester_destination,
    { kind: "google-play-internal", track: "internal" });
});

test("bootstrap refuses a child candidate from another accepted generation", () => {
  const receipts = childReceipts();
  receipts[1] = buildCoordinatedChildReceipt({
    coordinatedOperationId: operationId,
    candidate: candidate("android", { sourceSha: "9".repeat(40), acceptedSha: "9".repeat(40) }),
    production: production(candidate("android", { sourceSha: "9".repeat(40), acceptedSha: "9".repeat(40) })),
    snapshot: snapshot("android"),
    observedAt: "2026-09-21T00:00:00Z"
  });
  assert.throws(() => buildCoordinatedReleaseSeed({ operationId, generation, serverSha,
    acceptedMasterSha, currentServerSha, result: result(receipts) }), /source SHA/u);
});

test("bootstrap writes BOM-free seed and receipt files atomically", () => {
  const directory = mkdtempSync(join(tmpdir(), "ash-atlas-coordinated-bootstrap-"));
  try {
    const artifacts = buildCoordinatedReleaseSeed({ operationId, generation, serverSha,
      acceptedMasterSha, currentServerSha, result: result(), now: "2026-09-21T00:00:00Z" });
    const seedPath = join(directory, "coordinated-seed.json");
    const receiptPath = join(directory, "coordinated-mobile-receipt.json");
    writeCoordinatedBootstrapArtifacts({ seedPath, receiptPath, ...artifacts });
    assert.notEqual(readFileSync(seedPath)[0], 0xef);
    assert.equal(JSON.parse(readFileSync(seedPath, "utf8")).operation_id, operationId);
    assert.equal(JSON.parse(readFileSync(receiptPath, "utf8")).receipts.length, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("missing signing or store prerequisites produce a durable ACTION_REQUIRED record", () => {
  const directory = mkdtempSync(join(tmpdir(), "ash-atlas-coordinated-action-required-"));
  try {
    const actionRequired = buildActionRequiredResult({ operationId, generation, serverSha,
      acceptedMasterSha, currentServerSha, reason: "trusted Mac provider is not configured",
      now: "2026-09-21T00:00:00Z" });
    const path = join(directory, "coordinated-action-required.json");
    writeActionRequiredArtifact(path, actionRequired);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).status, "ACTION_REQUIRED");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).coordinated_operation_id, operationId);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI materializes a provider result through its real file boundary", () => {
  const directory = mkdtempSync(join(tmpdir(), "ash-atlas-coordinated-bootstrap-cli-"));
  try {
    const providerPath = join(directory, "provider-result.json");
    const seedPath = join(directory, "coordinated-seed.json");
    const receiptPath = join(directory, "coordinated-mobile-receipt.json");
    writeFileSync(providerPath, `${JSON.stringify(result())}\n`);
    execFileSync(process.execPath, ["tools/mobile-release/coordinated-bootstrap.mjs",
      "--result-file", providerPath, "--operation-id", operationId, "--generation", generation,
      "--server-sha", serverSha, "--accepted-master-sha", acceptedMasterSha,
      "--current-server-sha", currentServerSha, "--seed-path", seedPath, "--receipt-path", receiptPath],
    { encoding: "utf8" });
    assert.equal(JSON.parse(readFileSync(seedPath, "utf8")).kind, "ash-atlas-coordinated-release-seed");
    assert.equal(JSON.parse(readFileSync(receiptPath, "utf8")).coordinated_operation_id, operationId);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Google review action requirement cannot be materialized as a server seed", () => {
  const directory = mkdtempSync(join(tmpdir(), "ash-atlas-coordinated-google-action-required-"));
  try {
    const providerPath = join(directory, "provider-result.json");
    const seedPath = join(directory, "coordinated-seed.json");
    const receiptPath = join(directory, "coordinated-mobile-receipt.json");
    writeFileSync(providerPath, `${JSON.stringify({
      schemaVersion: 1, kind: "ash-atlas-coordinated-mobile-result", coordinated_operation_id: operationId,
      status: "ACTION_REQUIRED", reason: "Google Play Send for review is required"
    })}\n`);
    assert.throws(() => execFileSync(process.execPath, ["tools/mobile-release/coordinated-bootstrap.mjs",
      "--result-file", providerPath, "--operation-id", operationId, "--generation", generation,
      "--server-sha", serverSha, "--accepted-master-sha", acceptedMasterSha,
      "--current-server-sha", currentServerSha, "--seed-path", seedPath, "--receipt-path", receiptPath],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), /Send for review/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
