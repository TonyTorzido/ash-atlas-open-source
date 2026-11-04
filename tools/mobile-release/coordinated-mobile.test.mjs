import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildCoordinatedChildReceipt,
  coordinatedApprovalFingerprint,
  coordinatedServerEvidenceFingerprint,
  coordinatedServerEvidenceHmac,
  recordCoordinatedMobileReceipt,
  recordCoordinatedServerEvidence,
  coordinatedReceiptFor,
  signCoordinatedServerEvidence,
  validateCoordinatedChildReceipt,
  verifyAuthenticatedCoordinatedServerEvidence
} from "./coordinated-receipts.mjs";
import { coordinatedGate, runCoordinatedMobile } from "./coordinated-mobile.mjs";
import { prepareProductionCandidate } from "./production-registry.mjs";
import { reserveBuilds, transitionRelease } from "./registry.mjs";

const sourceSha = "a".repeat(40);
const artifactSha = "b".repeat(64);
const toolSha = "c".repeat(40);
const metadataSha = "d".repeat(64);
const evidenceKey = Buffer.from("coordinated-server-evidence-fixture-key-32", "utf8");

function candidate(platform, overrides = {}) {
  return {
    platform, releaseId: "coordinated-fixture", operationId: `coord-fixture:${platform}`,
    sourceSha, acceptedSha: sourceSha, generation: "t1250", marketingVersion: "1.2.0",
    build: platform === "android" ? 72 : 22, storeBuildId: platform === "android" ? "72" : "ios-22",
    artifactSha256: artifactSha, toolSha, metadataHash: metadataSha, countries: [],
    rollout: { kind: "update", mode: "staged", fraction: 0.1 }, managedPublishing: platform === "android" ? true : null,
    firstLaunch: false, firstPublicationBootstrapVerified: false, remoteBaselineFingerprint: "e".repeat(64),
    ...overrides
  };
}

function production(candidateValue, action = "submit", status = "succeeded") {
  return { operations: [{ operationId: `${candidateValue.operationId}:${action}`, platform: candidateValue.platform,
    action, status, candidate: candidateValue, updatedAt: "2026-09-21T00:00:00Z",
    receipt: { observed: { authoritative: true, matched: status === "succeeded", partial: false } } }] };
}

function snapshots({ published = false } = {}) {
  return {
    ios: { bundleId: "com.ashatlas.game", versions: [{ id: "ios-version", versionString: "1.2.0",
      state: published ? "READY_FOR_DISTRIBUTION" : "PENDING_DEVELOPER_RELEASE", releaseType: "MANUAL",
      buildId: "ios-22", reviewSubmissionState: "APPROVED" }] },
    android: { packageName: "com.ashatlas.game", productionTrack: { track: "production", releases: [{
      name: "t1250 (72)", versionCodes: ["72"], status: published ? "completed" : "inProgress", userFraction: 0.1 }] },
      productionLifecycle: [{ name: "t1250 (72)", versionCodes: ["72"],
        lifecycleState: published ? "RELEASE_LIFECYCLE_STATE_PUBLISHED" : "RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED" }] }
  };
}

function serverEvidence(phase = "apps_ready", overrides = {}) {
  const phaseIndex = ["manifest_created", "apps_submitted", "apps_ready", "server_published",
    "server_activated", "server_healthy", "apps_release_requested", "completed"].indexOf(phase);
  const evidence = {
    schemaVersion: 1, kind: "ash-atlas-coordinated-server-evidence",
    coordinated_operation_id: "coord-fixture", phase,
    source_sha: sourceSha, server_sha: sourceSha, accepted_master_sha: "e".repeat(40),
    generation: "t1250", authenticated: true, authoritative: true,
    published: phaseIndex >= 3, activated: phaseIndex >= 4, healthy: phaseIndex >= 5,
    candidates: {
      ios: { child_operation_id: "coord-fixture:ios", candidate: candidate("ios") },
      android: { child_operation_id: "coord-fixture:android", candidate: candidate("android") }
    },
    observed_at_utc: "2026-09-21T00:00:00Z", nonce: "1".repeat(32), ...overrides,
    hmac_key_id: "coordinated-server-evidence-v1"
  };
  return signCoordinatedServerEvidence(evidence, evidenceKey);
}

test("coordinated receipts bind approval and exact readiness states", () => {
  const android = candidate("android");
  const receipt = buildCoordinatedChildReceipt({ coordinatedOperationId: "coord-fixture", candidate: android,
    production: production(android), snapshot: snapshots().android, observedAt: "2026-09-21T00:00:00Z" });
  assert.equal(receipt.operation_id, "coord-fixture:android");
  assert.equal(receipt.store_status, "RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED");
  assert.equal(receipt.managed_publishing, true);
  assert.equal(receipt.public_available, false);
  assert.equal(receipt.approval.fingerprint, coordinatedApprovalFingerprint(receipt.candidate));
  assert.throws(() => buildCoordinatedChildReceipt({ coordinatedOperationId: "coord-fixture",
    candidate: { ...android, managedPublishing: false }, production: production(android), snapshot: snapshots().android }),
  /managed publishing/u);
});

test("coordinated receipts preserve empty Apple scope and non-applicable flags", () => {
  const ios = candidate("ios", { countries: [], managedPublishing: null, firstPublicationBootstrapVerified: false });
  const receipt = buildCoordinatedChildReceipt({ coordinatedOperationId: "coord-fixture", candidate: ios,
    production: production(ios), snapshot: snapshots().ios, observedAt: "2026-09-21T00:00:00Z" });
  assert.deepEqual(receipt.candidate.countries, []);
  assert.equal(receipt.managed_publishing, false);
  assert.equal(receipt.first_publication_bootstrap_verified, false);
  assert.doesNotThrow(() => validateCoordinatedChildReceipt(receipt));
});

test("coordinated receipt represents verified internal upload without claiming production readiness", () => {
  const ios = candidate("ios");
  const receipt = buildCoordinatedChildReceipt({ coordinatedOperationId: "coord-fixture", candidate: ios,
    production: { operations: [] }, snapshot: { internal_verified: {
      platform: "ios", marketing_version: ios.marketingVersion, build: ios.build,
      store_build_id: ios.storeBuildId, artifact_sha256: ios.artifactSha256, status: "verified"
    } }, observedAt: "2026-09-21T00:00:00Z" });
  assert.equal(receipt.store_status, "INTERNAL_VERIFIED");
  assert.equal(receipt.submitted, false);
  assert.equal(receipt.public_available, false);
  assert.equal(receipt.release_requested, false);
});

test("coordinated gate blocks server publication until both children are ready", () => {
  const ios = candidate("ios");
  const android = candidate("android");
  const fixtureSnapshots = snapshots();
  const iosReceipt = buildCoordinatedChildReceipt({ coordinatedOperationId: "coord-fixture", candidate: ios,
    production: production(ios), snapshot: fixtureSnapshots.ios });
  const androidReceipt = buildCoordinatedChildReceipt({ coordinatedOperationId: "coord-fixture", candidate: android,
    production: production(android), snapshot: fixtureSnapshots.android });
  const gate = coordinatedGate([iosReceipt, androidReceipt], {
    serverEvidence: serverEvidence("apps_ready")
  });
  assert.equal(gate.ready, true);
  assert.equal(gate.allowedServerPublication, true);
  assert.equal(gate.nextPhase, "server_published");
  const alreadyPublicIos = buildCoordinatedChildReceipt({ coordinatedOperationId: "coord-fixture", candidate: ios,
    production: production(ios, "release"), snapshot: snapshots({ published: true }).ios });
  const mixedGate = coordinatedGate([alreadyPublicIos, androidReceipt], {
    serverEvidence: serverEvidence("apps_ready")
  });
  assert.equal(mixedGate.ready, true, "a public child remains ready while the other child is pending");
  const spoofed = coordinatedGate([iosReceipt, androidReceipt], {
    serverPublished: true, serverActivated: true, serverHealthy: true
  });
  assert.equal(spoofed.serverHealthy, false, "caller-supplied server flags never unlock the gate");
});

test("server evidence is durable, monotonic, and candidate-bound", () => {
  const seed = JSON.parse(readFileSync(new URL("../../config/mobile-release-registry.seed.json", import.meta.url)));
  const initial = serverEvidence("apps_ready");
  let registry = recordCoordinatedServerEvidence(seed, initial);
  registry = recordCoordinatedServerEvidence(registry, initial);
  assert.equal(registry.coordinatedServerEvidence.length, 1);
  const healthy = serverEvidence("server_healthy", { observed_at_utc: "2026-09-21T00:01:00Z" });
  registry = recordCoordinatedServerEvidence(registry, healthy);
  assert.equal(registry.coordinatedServerEvidence.length, 2);
  assert.throws(() => recordCoordinatedServerEvidence(registry,
    serverEvidence("server_healthy", { source_sha: "f".repeat(40), server_sha: "f".repeat(40) })),
  /changed during reconciliation/u);

  const directory = mkdtempSync(join(tmpdir(), "ash-atlas-coordinated-server-evidence-"));
  try {
    const registryPath = join(directory, "registry.json");
    const evidencePath = join(directory, "evidence.json");
    writeFileSync(registryPath, `${JSON.stringify(seed)}\n`);
    writeFileSync(evidencePath, `${JSON.stringify(initial)}\n`);
    execFileSync(process.execPath, ["tools/mobile-release/registry-remote.mjs", "coordinated-server-evidence",
      "--evidence-file", evidencePath, "--file", registryPath], { encoding: "utf8" });
    const stored = JSON.parse(readFileSync(registryPath, "utf8"));
    assert.equal(stored.coordinatedServerEvidence.length, 1);
    assert.equal(stored.coordinatedServerEvidence[0].coordinated_operation_id, "coord-fixture");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("controller server evidence requires the exact HMAC envelope and key", () => {
  const evidence = serverEvidence("server_healthy");
  assert.doesNotThrow(() => verifyAuthenticatedCoordinatedServerEvidence(evidence, evidenceKey));
  assert.throws(() => verifyAuthenticatedCoordinatedServerEvidence(evidence, Buffer.from("wrong-key-32-bytes-aaaaaaaaaaaaaaa")),
    /HMAC/u);
  const tampered = { ...evidence, health: { ...evidence.health, public_release_sha: "f".repeat(40) } };
  assert.throws(() => verifyAuthenticatedCoordinatedServerEvidence(tampered, evidenceKey), /fingerprint|HMAC/u);
});

test("server evidence HMAC uses the cross-language canonical JSON bytes", () => {
  const value = { n: [true, null], b: 2, a: "x" };
  const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
  const hmac = "cd5f98f09d7136559555dde956242d5b3641833f8c984721cc9a3278c1e1d525";
  assert.equal(coordinatedServerEvidenceHmac(value, key), hmac);
  assert.equal(coordinatedServerEvidenceFingerprint({ ...value, hmac_sha256: hmac }),
    "7fd3ca49814ace17063a68290955832479a10743c120bc7aba452174036b70d3");
  assert.equal(coordinatedServerEvidenceFingerprint(value),
    "b61e0e4a982f500d546709094316af966397b3fbb733447888bc600b8cd94057");
});

test("actual coordinated resume imports controller evidence before the release gate", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ash-atlas-coordinated-resume-"));
  const keys = ["PRODUCTION_REGISTRY_FILE", "COORDINATED_FIXTURE_SNAPSHOTS", "COORDINATED_SERVER_EVIDENCE_B64",
    "COORDINATED_SERVER_EVIDENCE_SHA256", "COORDINATED_SERVER_EVIDENCE_HMAC_KEY", "COORDINATED_SERVER_EVIDENCE_HMAC_KEY_ID",
    "COORDINATED_MOBILE_RECEIPT_PATH", "ASH_ATLAS_JOB_TEMP", "DRY_RUN", "ASH_ATLAS_PRODUCTION_MUTATION"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    const registryPath = join(directory, "registry.json");
    const snapshotPath = join(directory, "snapshots.json");
    const receiptPath = join(directory, "receipt.json");
    let registry = JSON.parse(readFileSync(new URL("../../config/mobile-release-registry.seed.json", import.meta.url)));
    registry = reserveBuilds(registry, { releaseId: "coordinated-fixture", platforms: ["ios", "android"],
      marketingVersions: { ios: "1.2.0", android: "1.2.0" }, generation: "t1250", sourceSha,
      protocolMin: 3, protocolMax: 3, releaseMode: "internal", remoteMaximum: { ios: 21, android: 71 },
      now: "2026-09-21T00:00:00Z" }).registry;
    for (const platform of ["ios", "android"]) {
      const release = registry.releases.find((entry) => entry.releaseId === "coordinated-fixture" && entry.platform === platform);
      registry = transitionRelease(registry, release.reservationId, { uploadAttempted: true, uploaded: true,
        processed: true, internal: true, artifactSha256: artifactSha,
        storeBuildId: platform === "android" ? String(release.build) : `ios-${release.build}`,
        receiptUrl: "https://github.com/example/repo/actions/runs/1" });
      const prepared = candidate(platform);
      const toolingApproval = { approved: true, toolSha, actor: "fixture",
        receiptUrl: "https://github.com/example/repo/actions/runs/1", approvedAt: "2026-09-21T00:00:00Z" };
      registry = prepareProductionCandidate(registry, { platform, release: registry.releases.find((entry) => entry.reservationId === release.reservationId),
        operationId: prepared.operationId, toolingApproval, metadataHash: metadataSha,
        countries: prepared.countries, rollout: prepared.rollout, serverCompatibility: prepared.serverCompatibility,
        remoteBaseline: null, publishedMasterSha: sourceSha, activationFenceFingerprint: null,
        managedPublishing: platform === "android", firstPublicationBootstrapVerified: false,
        preparedAt: prepared.preparedAt });
    }
    writeFileSync(registryPath, `${JSON.stringify(registry)}\n`);
    writeFileSync(snapshotPath, `${JSON.stringify(snapshots())}\n`);
    const evidence = serverEvidence("server_healthy");
    const evidenceBytes = Buffer.from(JSON.stringify(evidence), "utf8");
    Object.assign(process.env, {
      PRODUCTION_REGISTRY_FILE: registryPath,
      COORDINATED_FIXTURE_SNAPSHOTS: snapshotPath,
      COORDINATED_SERVER_EVIDENCE_B64: evidenceBytes.toString("base64"),
      COORDINATED_SERVER_EVIDENCE_SHA256: createHash("sha256").update(evidenceBytes).digest("hex"),
      COORDINATED_SERVER_EVIDENCE_HMAC_KEY: evidenceKey.toString("base64"),
      COORDINATED_SERVER_EVIDENCE_HMAC_KEY_ID: "coordinated-server-evidence-v1",
      COORDINATED_MOBILE_RECEIPT_PATH: receiptPath,
      ASH_ATLAS_JOB_TEMP: directory,
      DRY_RUN: "false",
      ASH_ATLAS_PRODUCTION_MUTATION: "false"
    });
    const result = await runCoordinatedMobile({ action: "resume", coordinatedOperationId: "coord-fixture",
      execute: false, now: "2026-09-21T00:02:00Z" });
    assert.equal(result.coordinated_operation_id, "coord-fixture");
    assert.equal(result.gate.serverHealthy, true);
    assert.equal(JSON.parse(readFileSync(registryPath, "utf8")).coordinatedServerEvidence.length, 1);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("coordinated receipts are durable, idempotent, and advance after public availability", () => {
  const seed = JSON.parse(readFileSync(new URL("../../config/mobile-release-registry.seed.json", import.meta.url)));
  const android = candidate("android");
  const pending = buildCoordinatedChildReceipt({ coordinatedOperationId: "coord-fixture", candidate: android,
    production: production(android), snapshot: snapshots().android, observedAt: "2026-09-21T00:00:00Z" });
  let registry = recordCoordinatedMobileReceipt(seed, pending);
  registry = recordCoordinatedMobileReceipt(registry, pending);
  assert.equal(registry.coordinatedMobileReceipts.length, 1);
  const published = buildCoordinatedChildReceipt({ coordinatedOperationId: "coord-fixture", candidate: android,
    production: production(android, "release"), snapshot: snapshots({ published: true }).android,
    observedAt: "2026-09-21T00:01:00Z" });
  registry = recordCoordinatedMobileReceipt(registry, published);
  assert.equal(registry.coordinatedMobileReceipts.length, 2);
  assert.equal(coordinatedReceiptFor(registry, "coord-fixture", "android").public_available, true);
});

test("registry remote persists a child receipt through its real file CLI", () => {
  const directory = mkdtempSync(join(tmpdir(), "ash-atlas-coordinated-registry-"));
  try {
    const registryPath = join(directory, "registry.json");
    const receiptPath = join(directory, "receipt.json");
    const seed = JSON.parse(readFileSync(new URL("../../config/mobile-release-registry.seed.json", import.meta.url)));
    const android = candidate("android");
    const receipt = buildCoordinatedChildReceipt({ coordinatedOperationId: "coord-cli", candidate: android,
      production: production(android), snapshot: snapshots().android });
    writeFileSync(registryPath, `${JSON.stringify(seed)}\n`);
    writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
    execFileSync(process.execPath, ["tools/mobile-release/registry-remote.mjs", "coordinated-mobile-receipt",
      "--receipt-file", receiptPath, "--file", registryPath], { encoding: "utf8" });
    const stored = JSON.parse(readFileSync(registryPath, "utf8"));
    assert.equal(stored.coordinatedMobileReceipts.length, 1);
    assert.equal(stored.coordinatedMobileReceipts[0].operation_id, "coord-cli:android");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
