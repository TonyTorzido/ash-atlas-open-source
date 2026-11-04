import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { artifactSha256 } from "./coordinated-build-boundary.mjs";
import {
  fastlaneInvocation,
  parseCommandJson,
  productionApprovalFingerprint,
  productionEnvironment,
  runTrustedStoreAdapter,
  validateRequest
} from "./coordinated-trusted-store-adapter.mjs";
import { productionCandidateFingerprint } from "./production-registry.mjs";
import { buildCoordinatedChildReceipt, coordinatedApprovalFingerprint } from "./coordinated-receipts.mjs";

const operationId = "coord-adapter-fixture";
const serverSha = "a".repeat(40);
const masterSha = "b".repeat(40);
const toolingSha = "c".repeat(40);
const metadataSha = "d".repeat(64);

function fixture(root, platform = "ios") {
  const source = join(root, "source");
  const tooling = join(root, "tooling");
  const handoff = join(root, "handoff");
  const fastlaneRoot = join(root, "trusted-fastlane");
  const quarantine = join(root, "signed");
  mkdirSync(source); mkdirSync(tooling); mkdirSync(handoff); mkdirSync(fastlaneRoot); mkdirSync(quarantine);
  const artifactPath = join(quarantine, `${platform}.ipa`);
  writeFileSync(artifactPath, `${platform}-signed-bytes`);
  const artifactHash = artifactSha256(artifactPath);
  const manifest = {
    schema_version: 1,
    kind: "ash-atlas-coordinated-signed-artifact-manifest",
    operation_id: operationId,
    generation: "t1251",
    source_sha: serverSha,
    unsigned_manifest_sha256: "e".repeat(64),
    tooling_root: tooling,
    signed_quarantine_root: quarantine,
    artifacts: [{ platform, kind: platform === "ios" ? "ipa" : "aab", signed_path: artifactPath, sha256: artifactHash }],
    manifest_sha256: "f".repeat(64)
  };
  const manifestPath = join(handoff, "signed-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  const candidate = {
    operation_id: `${operationId}:${platform}`, platform, release_id: `coord-${operationId}`,
    source_sha: serverSha, generation: "t1251", marketing_version: "1.2.0", build: 22,
    artifact_sha256: artifactHash, tooling_sha: toolingSha, metadata_sha256: metadataSha,
    metadata_packet_path: join(root, `${platform}-metadata.json`), countries: [],
    rollout: { kind: "update", mode: "manual" }, managed_publishing: platform === "android",
    first_publication_bootstrap_verified: false
  };
  return { source, tooling, handoff, fastlaneRoot, manifestPath, artifactHash, candidate,
    registryFile: join(root, "registry.json") };
}

function requestFor(fixtureValue, action = "upload") {
  const candidate = { ...fixtureValue.candidate,
    ...(action === "upload" ? {} : { store_build_id: "ios-store-22" }) };
  return {
    schema_version: 1, kind: "ash-atlas-coordinated-store-step-request", action,
    attempt_id: `${operationId}:${fixtureValue.candidate.platform}:${action}`,
    coordinated_operation_id: operationId, child_operation_id: fixtureValue.candidate.operation_id,
    platform: fixtureValue.candidate.platform,
    generation: "t1251", source_sha: serverSha, accepted_master_sha: masterSha,
    current_server_sha: serverSha, tooling_sha: toolingSha,
    registry_remote: "example-org/game", registry_branch: "mobile-release-state",
    registry_file: fixtureValue.registryFile, source_repository_root: fixtureValue.source,
    tooling_root: fixtureValue.tooling, handoff_root: fixtureValue.handoff,
    release_id: fixtureValue.candidate.release_id, reservation: { reservation_id: `${fixtureValue.candidate.release_id}:${fixtureValue.candidate.platform}`,
      build: fixtureValue.candidate.build, marketing_version: fixtureValue.candidate.marketing_version },
    candidate, signed_manifest_path: fixtureValue.manifestPath,
    signed_manifest_sha256: "f".repeat(64), protocol: { min: 3, max: 3 }
  };
}

function releaseFor(request, overrides = {}) {
  return { reservationId: request.reservation.reservation_id, releaseId: request.release_id,
    platform: request.platform, marketingVersion: request.candidate.marketing_version,
    build: request.candidate.build, generation: request.generation, sourceSha: request.source_sha,
    protocol: { min: 3, max: 3 }, uploadAttempted: false, uploaded: false, processed: false,
    internal: false, compatibilityProtected: false, externalApproved: false, open: false,
    downloadTested: false, supported: false, artifactSha256: null, storeBuildId: null,
    receiptUrl: null, releaseMode: "production", availabilityPending: null, milestones: { reserved: true }, ...overrides };
}

function productionCandidateFor(request) {
  return {
    schemaVersion: 1, platform: request.platform, releaseId: request.release_id,
    sourceSha: request.source_sha, acceptedSha: request.source_sha,
    generation: request.generation, marketingVersion: request.candidate.marketing_version,
    build: Number(request.candidate.build), storeBuildId: request.candidate.store_build_id,
    artifactSha256: request.candidate.artifact_sha256, protocol: { min: 3, max: 3 },
    toolingApproval: { approved: true, toolSha: request.tooling_sha, actor: "fixture",
      receiptUrl: "https://github.com/fixture/receipt", approvedAt: "2026-09-22T00:00:00.000Z" },
    toolSha: request.tooling_sha, metadataHash: request.candidate.metadata_sha256,
    countries: [], rollout: structuredClone(request.candidate.rollout), serverCompatibility: null,
    remoteBaselineFingerprint: null, publishedMasterSha: request.accepted_master_sha,
    activationFenceFingerprint: null, managedPublishing: false,
    firstPublicationBootstrapVerified: false, firstLaunch: false,
    preparedAt: "2026-09-22T00:00:00.000Z", operationId: `${request.child_operation_id}:prepare`
  };
}

test("trusted adapter binds Fastlane commands to the control root and exact artifact", () => {
  const root = mkdtempSync(join(tmpdir(), "ash-atlas-adapter-command-"));
  try {
    const value = fixture(root);
    const request = requestFor(value);
    const invocation = fastlaneInvocation({ platform: "ios", artifactPath: value.manifestPath,
      env: { COORDINATED_FASTLANE_ROOT: value.fastlaneRoot, COORDINATED_BUNDLE_EXECUTABLE: "bundle" },
      sourceRepositoryRoot: value.source, request });
    assert.deepEqual(invocation.args, ["exec", "fastlane", "ios", "upload_internal"]);
    const daily = fastlaneInvocation({ platform: "ios", artifactPath: value.manifestPath,
      env: { COORDINATED_FASTLANE_ROOT: value.fastlaneRoot },
      sourceRepositoryRoot: value.source, request: { delivery_mode: "daily-testers", candidate: value.candidate,
        release_id: value.candidate.release_id, source_sha: serverSha, generation: "t1251" } });
    assert.equal(daily.env.COORDINATED_DAILY_TESTERS, "true");
    assert.equal(invocation.cwd, value.fastlaneRoot);
    assert.throws(() => fastlaneInvocation({ platform: "ios", artifactPath: value.manifestPath,
      env: {}, sourceRepositoryRoot: value.source }), /trusted Fastlane root/u);
    assert.throws(() => fastlaneInvocation({ platform: "ios", artifactPath: value.manifestPath,
      env: { COORDINATED_FASTLANE_ROOT: value.source }, sourceRepositoryRoot: value.source }), /source mirror/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("daily adapter carries the validated tester observation into the durable receipt", async () => {
  const root = mkdtempSync(join(tmpdir(), "ash-atlas-adapter-daily-observation-"));
  try {
    const value = fixture(root);
    const request = requestFor(value, "submit");
    request.delivery_mode = "daily-testers";
    request.candidate = { ...request.candidate,
      tester_destination: { kind: "testflight", group_type: "internal", group_id: "internal-1" } };
    const release = releaseFor(request, { uploadAttempted: true, uploaded: true, processed: true,
      internal: true, compatibilityProtected: true, artifactSha256: value.artifactHash,
      storeBuildId: "ios-store-22" });
    const observation = { platform: "ios", group_type: "internal", group_id: "internal-1",
      marketing_version: request.candidate.marketing_version, build: request.candidate.build,
      store_build_id: "ios-store-22", artifact_sha256: value.artifactHash,
      status: "IN_BETA_TESTING", available: true, prepared: true };
    const result = await runTrustedStoreAdapter({ request,
      registryRunner: ({ command }) => command === "inspect" ? { reservations: { ios: release } } : {},
      dailyVerifier: async ({ options }) => {
        assert.equal(options.allowMutations, false);
        assert.equal(options.activate, false);
        return { storeBuildId: "ios-store-22", pending: false,
          snapshot: { ignored_snapshot_field: true }, observation };
      } });
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(result.snapshot.tester.available, true);
    const receipt = buildCoordinatedChildReceipt({ coordinatedOperationId: request.coordinated_operation_id,
      candidate: result.candidate, production: result.production, snapshot: result.snapshot,
      operation: result.operation, observedAt: "2026-09-22T00:00:00.000Z" });
    assert.equal(receipt.tester_available, true);
    assert.equal(receipt.tester_prepared, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("daily external TestFlight submit enables review preparation without distribution", async () => {
  const root = mkdtempSync(join(tmpdir(), "ash-atlas-adapter-daily-external-review-"));
  try {
    const value = fixture(root);
    const request = requestFor(value, "submit");
    request.delivery_mode = "daily-testers";
    request.candidate = { ...request.candidate, tester_destination: {
      kind: "testflight", group_type: "external", group_id: "public-1",
      public_link: "https://testflight.apple.com/join/Example" } };
    const release = releaseFor(request, { uploadAttempted: true, uploaded: true, processed: true,
      internal: true, compatibilityProtected: true, artifactSha256: value.artifactHash,
      storeBuildId: "ios-store-22" });
    let verifierOptions;
    const result = await runTrustedStoreAdapter({ request,
      registryRunner: ({ command }) => command === "inspect" ? { reservations: { ios: release } } : {},
      dailyVerifier: async ({ options }) => {
        verifierOptions = options;
        return { storeBuildId: "ios-store-22", pending: true,
          observation: { platform: "ios", group_type: "external", group_id: "public-1",
            public_link: "https://testflight.apple.com/join/Example",
            marketing_version: request.candidate.marketing_version, build: request.candidate.build,
            store_build_id: "ios-store-22", artifact_sha256: value.artifactHash,
            status: "WAITING_FOR_REVIEW", available: false, prepared: true } };
      } });
    assert.equal(result.status, "pending", JSON.stringify(result));
    assert.equal(verifierOptions.allowMutations, false);
    assert.equal(verifierOptions.activate, false);
    assert.equal(verifierOptions.allowReviewSubmission, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("daily activation rejects pre-health calls and enables mutation only with exact server evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "ash-atlas-adapter-daily-activation-"));
  try {
    const value = fixture(root);
    const request = requestFor(value, "release");
    request.delivery_mode = "daily-testers";
    request.candidate = { ...request.candidate,
      store_build_id: "ios-store-22",
      tester_destination: { kind: "testflight", group_type: "internal", group_id: "internal-1" } };
    let verifierCalls = 0;
    const noEvidence = await runTrustedStoreAdapter({ request,
      dailyVerifier: async () => { verifierCalls += 1; throw new Error("mutation must be gated"); } });
    assert.equal(noEvidence.status, "ACTION_REQUIRED");
    assert.equal(verifierCalls, 0);
    const evidenceRequest = { ...request, server_evidence: { authenticated: true, authoritative: true,
      published: true, activated: true, healthy: true,
      candidates: { ios: { candidate: request.candidate,
        approval_fingerprint: coordinatedApprovalFingerprint(request.candidate) } } } };
    const release = releaseFor(evidenceRequest, { uploadAttempted: true, uploaded: true, processed: true,
      internal: true, compatibilityProtected: true, artifactSha256: value.artifactHash,
      storeBuildId: "ios-store-22" });
    const result = await runTrustedStoreAdapter({ request: evidenceRequest,
      registryRunner: ({ command }) => command === "inspect" ? { reservations: { ios: release } } : {},
      dailyVerifier: async ({ options }) => {
        verifierCalls += 1;
        assert.equal(options.allowMutations, true);
        assert.equal(options.activate, true);
        return { storeBuildId: "ios-store-22", pending: false,
          observation: { platform: "ios", group_type: "internal", group_id: "internal-1",
            marketing_version: request.candidate.marketing_version, build: request.candidate.build,
            store_build_id: "ios-store-22", artifact_sha256: value.artifactHash,
            status: "IN_BETA_TESTING", available: true, prepared: true } };
      } });
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(verifierCalls, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("production environment carries exact candidate packet, registry, and operation identity", () => {
  const root = mkdtempSync(join(tmpdir(), "ash-atlas-adapter-env-"));
  try {
    const value = fixture(root);
    const request = requestFor(value, "release");
    const approval = productionApprovalFingerprint(request);
    const env = { COORDINATED_PRODUCTION_RELEASE_APPROVAL_SHA256: approval };
    const result = productionEnvironment(request, env, "release", request.attempt_id);
    assert.equal(result.PRODUCTION_REGISTRY_REMOTE, request.registry_remote);
    assert.equal(result.PRODUCTION_REGISTRY_FILE, request.registry_file);
    assert.equal(result.PRODUCTION_OPERATION_ID, request.attempt_id);
    assert.equal(result.IOS_PRODUCTION_METADATA_PACKET_PATH, request.candidate.metadata_packet_path);
    assert.equal(result.PRODUCTION_RELEASE_APPROVAL_SHA256, approval);
    assert.equal(result.SOURCE_SHA, serverSha);
    assert.equal(result.PRODUCTION_MASTER_SHA, masterSha);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("production environment carries the external Google Console attestation path", () => {
  const root = mkdtempSync(join(tmpdir(), "ash-atlas-adapter-google-attestation-"));
  try {
    const value = fixture(root, "android");
    const request = requestFor(value, "submit");
    const attestationPath = join(root, "managed-publishing-attestation.json");
    const result = productionEnvironment(request, {
      GOOGLE_PLAY_MANAGED_PUBLISHING_ATTESTATION_PATH: attestationPath
    }, "submit", request.attempt_id);
    assert.equal(result.GOOGLE_PLAY_MANAGED_PUBLISHING_ATTESTATION_PATH, attestationPath);
    assert.equal(result.GOOGLE_PLAY_MANAGED_PUBLISHING, "true");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("production adapter delegates the exact prepared candidate to the immutable tooling CLI", async () => {
  const root = mkdtempSync(join(tmpdir(), "ash-atlas-adapter-production-"));
  try {
    const value = fixture(root);
    const request = requestFor(value, "prepare");
    const release = releaseFor(request, { storeBuildId: "ios-store-22" });
    const calls = [];
    const result = await runTrustedStoreAdapter({ request, env: {},
      productionRunner: async (input) => {
        calls.push(input);
        return { action: "prepare", dryRun: false, platforms: { ios: { prepared: true } } };
      },
      registryRunner: ({ command }) => command === "production-status"
        ? { production: { candidate: null, operations: [] } }
        : { reservations: { ios: release } },
      snapshotRunner: async () => ({ versions: [] }) });
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, "prepare");
    assert.equal(calls[0].request.candidate.store_build_id, "ios-store-22");
    assert.equal(calls[0].env.PRODUCTION_REGISTRY_REMOTE, request.registry_remote);
    assert.equal(calls[0].env.PRODUCTION_TOOL_SHA, toolingSha);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("upload reserves an availability marker, runs once, and verifies before clearing it", async () => {
  const root = mkdtempSync(join(tmpdir(), "ash-atlas-adapter-upload-"));
  try {
    const value = fixture(root);
    const request = requestFor(value);
    const calls = [];
    let release = releaseFor(request);
    const registryRunner = ({ command, args }) => {
      calls.push({ command, args });
      if (command === "inspect") return { reservations: { ios: release } };
      if (command === "transition") {
        const patch = JSON.parse(args[args.indexOf("--patch") + 1]);
        release = { ...release, ...patch };
        if (patch.availabilityPending !== undefined) release.availabilityPending = patch.availabilityPending;
        if (patch.availabilityPending === null) release.availabilityPending = null;
        return { reservations: { ios: release } };
      }
      return { production: { platforms: { ios: { candidate: null, phase: "idle", history: [] }, android: { candidate: null, phase: "idle", history: [] } }, operations: [] } };
    };
    const commands = [];
    const result = await runTrustedStoreAdapter({ request, now: "2026-09-22T00:00:00.000Z",
      env: { COORDINATED_FASTLANE_ROOT: value.fastlaneRoot, GITHUB_SERVER_URL: "https://github.com",
        GITHUB_REPOSITORY: "example-org/game", GITHUB_RUN_ID: "42" },
      registryRunner,
      commandRunner: (command, args, options) => { commands.push({ command, args, options }); return ""; },
      internalVerifier: async () => ({ storeBuildId: "ios-store-22" }),
      compatibilityVerifier: async () => ({ schemaVersion: 1, platform: "ios", sourceSha: serverSha,
        marketingVersion: "1.2.0", build: 22, protocol: { min: 3, max: 3 }, serverUrl: "https://playashatlas.com",
        serverSha, serverProtocol: { min: 3, max: 3 }, hardMinimum: { version: "1.0.0", build: 1 }, status: "supported",
        observedAt: "2026-09-22T00:00:00.000Z" }) });
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(result.candidate.store_build_id, "ios-store-22");
    assert.equal(result.snapshot.internal_verified.status, "verified");
    for (const platform of ["ios", "android"]) {
      const storeBuildId = platform === "ios" ? "ios-store-22" : "22";
      const candidate = { ...result.candidate, platform, operation_id: `${operationId}:${platform}`,
        store_build_id: storeBuildId, tester_destination: platform === "ios"
          ? { kind: "testflight", group_type: "internal", group_id: "internal-1" }
          : { kind: "google-play-internal", track: "internal" } };
      const receipt = buildCoordinatedChildReceipt({ coordinatedOperationId: operationId, candidate,
        production: result.production, snapshot: { internal_verified: {
          ...result.snapshot.internal_verified, platform, store_build_id: storeBuildId } } });
      assert.equal(receipt.store_status, "INTERNAL_VERIFIED");
      assert.equal(receipt.tester_available, false);
      assert.equal(receipt.candidate.store_build_id, storeBuildId);
    }
    assert.equal(release.internal, true);
    assert.equal(release.availabilityPending, null);
    assert.equal(commands.length, 1);
    assert.deepEqual(commands[0].args, ["exec", "fastlane", "ios", "upload_internal"]);
    assert.equal(calls.filter((entry) => entry.command === "transition").length, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("upload response loss resumes verification without running Fastlane again", async () => {
  const root = mkdtempSync(join(tmpdir(), "ash-atlas-adapter-recovery-"));
  try {
    const value = fixture(root);
    const request = requestFor(value);
    let release = releaseFor(request, { uploadAttempted: true, artifactSha256: value.artifactHash,
      availabilityPending: { schemaVersion: 1, reservationId: request.reservation.reservation_id,
        releaseId: request.release_id, platform: "ios", sourceSha: serverSha, marketingVersion: "1.2.0",
        build: 22, protocol: { min: 3, max: 3 }, artifactSha256: value.artifactHash,
        preparedAt: "2026-09-22T00:00:00.000Z" } });
    let commandCount = 0;
    const options = { request,
      env: { COORDINATED_FASTLANE_ROOT: value.fastlaneRoot, GITHUB_SERVER_URL: "https://github.com",
        GITHUB_REPOSITORY: "example-org/game", GITHUB_RUN_ID: "43" },
      registryRunner: ({ command, args }) => {
        if (command === "inspect") return { reservations: { ios: release } };
        if (command === "transition") {
          release = { ...release, ...JSON.parse(args[args.indexOf("--patch") + 1]) };
          return { reservations: { ios: release } };
        }
        return { production: { platforms: { ios: { candidate: null, phase: "idle", history: [] }, android: { candidate: null, phase: "idle", history: [] } }, operations: [] } };
      },
      commandRunner: () => { commandCount += 1; return ""; },
      internalVerifier: async () => ({ storeBuildId: "ios-store-22" }),
      compatibilityVerifier: async () => ({ status: "supported", serverSha, observedAt: "2026-09-22T00:00:00.000Z" }) };
    const result = await runTrustedStoreAdapter(options);
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(commandCount, 0);
    assert.equal(release.availabilityPending, null);
    assert.equal(release.internal, true);
    const recorded = { receiptUrl: release.receiptUrl, serverCompatibility: structuredClone(release.serverCompatibility) };
    const replay = await runTrustedStoreAdapter({ ...options,
      env: { ...options.env, GITHUB_RUN_ID: "44" },
      compatibilityVerifier: async () => ({ status: "supported", serverSha, observedAt: "2026-09-22T01:00:00.000Z" }) });
    assert.equal(replay.status, "ok", JSON.stringify(replay));
    assert.equal(commandCount, 0);
    assert.deepEqual({ receiptUrl: release.receiptUrl, serverCompatibility: release.serverCompatibility }, recorded);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("upload reconciliation proves no mutation before retrying the upload", async () => {
  const root = mkdtempSync(join(tmpdir(), "ash-atlas-adapter-upload-reconcile-"));
  try {
    const value = fixture(root);
    const request = { ...requestFor(value, "reconcile"),
      previous_platform_state: { pending: { action: "upload" } },
      attempt_id: `${value.candidate.operation_id}:upload` };
    delete request.candidate.store_build_id;
    const release = releaseFor(request);
    let commandCount = 0;
    const result = await runTrustedStoreAdapter({ request,
      registryRunner: ({ command }) => command === "inspect"
        ? { reservations: { ios: release } }
        : { production: { platforms: {}, operations: [] } },
      commandRunner: () => { commandCount += 1; return ""; } });
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(result.action, "reconcile");
    assert.equal(result.mutation_status, "not_mutated");
    assert.equal(result.candidate, null);
    assert.equal(commandCount, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("upload reconciliation confirms a prior attempt without repeating Fastlane", async () => {
  const root = mkdtempSync(join(tmpdir(), "ash-atlas-adapter-upload-confirm-"));
  try {
    const value = fixture(root);
    const request = { ...requestFor(value, "reconcile"), target_action: "upload",
      attempt_id: `${value.candidate.operation_id}:upload` };
    delete request.candidate.store_build_id;
    let release = releaseFor(request, { uploadAttempted: true, artifactSha256: value.artifactHash,
      availabilityPending: { schemaVersion: 1, reservationId: request.reservation.reservation_id,
        releaseId: request.release_id, platform: "ios", sourceSha: serverSha,
        marketingVersion: "1.2.0", build: 22, protocol: { min: 3, max: 3 },
        artifactSha256: value.artifactHash, preparedAt: "2026-09-22T00:00:00.000Z" } });
    const result = await runTrustedStoreAdapter({ request,
      registryRunner: ({ command, args }) => {
        if (command === "inspect") return { reservations: { ios: release } };
        if (command === "transition") {
          release = { ...release, ...JSON.parse(args[args.indexOf("--patch") + 1]),
            availabilityPending: null, uploaded: true, processed: true, internal: true,
            compatibilityProtected: true, storeBuildId: "ios-store-22" };
          return { reservations: { ios: release } };
        }
        return { production: { platforms: {}, operations: [] } };
      },
      commandRunner: () => { throw new Error("Fastlane must not run during upload reconciliation"); },
      internalVerifier: async () => ({ storeBuildId: "ios-store-22" }),
      compatibilityVerifier: async () => ({ status: "supported", serverSha }) });
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(result.action, "reconcile");
    assert.equal(result.mutation_status, "confirmed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("upload recovery rejects a changed verified store build identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "ash-atlas-adapter-upload-identity-"));
  try {
    const value = fixture(root);
    const request = { ...requestFor(value, "reconcile"), target_action: "upload",
      attempt_id: `${value.candidate.operation_id}:upload` };
    const release = releaseFor(request, { uploadAttempted: true, uploaded: true, processed: true,
      internal: true, compatibilityProtected: true, artifactSha256: value.artifactHash,
      storeBuildId: "ios-store-other" });
    const result = await runTrustedStoreAdapter({ request,
      registryRunner: ({ command }) => command === "inspect"
        ? { reservations: { ios: release } }
        : { production: { platforms: {}, operations: [] } },
      commandRunner: () => { throw new Error("Fastlane must not run during upload reconciliation"); } });
    assert.equal(result.status, "ACTION_REQUIRED");
    assert.equal(result.code, "ACTION_REQUIRED_PROVISION_TRUSTED_STORE");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("production reconciliation keeps the original mutation operation identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "ash-atlas-adapter-production-reconcile-"));
  try {
    const value = fixture(root);
    const request = { ...requestFor(value, "reconcile"), target_action: "submit",
      attempt_id: `${value.candidate.operation_id}:submit` };
    const release = releaseFor(request, { uploadAttempted: true, uploaded: true, processed: true,
      internal: true, compatibilityProtected: true, artifactSha256: value.artifactHash,
      storeBuildId: request.candidate.store_build_id });
    const candidate = productionCandidateFor(request);
    const calls = [];
    const result = await runTrustedStoreAdapter({ request,
      registryRunner: ({ command }) => {
        if (command === "inspect") return { reservations: { ios: release } };
        if (command === "production-status") return { production: { candidate,
          operations: [{ operationId: request.attempt_id, action: "submit", status: "succeeded",
            candidate, receipt: {} }] } };
        return { production: { candidate, operations: [] } };
      },
      productionRunner: async (input) => {
        calls.push(input);
        return { observed: { matched: true, terminal: true, authoritative: true } };
      },
      snapshotRunner: async () => ({ versions: [] }) });
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(result.mutation_status, "confirmed");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, "reconcile");
    assert.equal(calls[0].env.PRODUCTION_OPERATION_ID, request.attempt_id);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("prepare reconciliation recovers the exact durable candidate without a journal operation", async () => {
  const root = mkdtempSync(join(tmpdir(), "ash-atlas-adapter-prepare-reconcile-"));
  try {
    const value = fixture(root);
    const request = { ...requestFor(value, "reconcile"), target_action: "prepare",
      attempt_id: `${value.candidate.operation_id}:prepare` };
    const release = releaseFor(request, { uploadAttempted: true, uploaded: true, processed: true,
      internal: true, compatibilityProtected: true, artifactSha256: value.artifactHash,
      storeBuildId: request.candidate.store_build_id });
    const candidate = productionCandidateFor(request);
    const result = await runTrustedStoreAdapter({ request,
      registryRunner: ({ command }) => command === "inspect"
        ? { reservations: { ios: release } }
        : { production: { candidate, operations: [] } } });
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(result.action, "reconcile");
    assert.equal(result.mutation_status, "confirmed");
    assert.equal(result.candidate.store_build_id, request.candidate.store_build_id);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("production adapter accepts the pretty JSON emitted by the CLI", () => {
  const output = "production log\n{\n  \"action\": \"reconcile\",\n  \"status\": \"ok\"\n}\n";
  assert.deepEqual(parseCommandJson(output, "production adapter"), { action: "reconcile", status: "ok" });
});

test("production release derives a per-candidate approval after authenticated server health", async () => {
    const root = mkdtempSync(join(tmpdir(), "ash-atlas-adapter-production-approval-"));
  try {
    const value = fixture(root);
    const request = requestFor(value, "release");
    request.server_evidence = { authenticated: true, authoritative: true, published: true,
      activated: true, healthy: true,
      candidates: { ios: { candidate: request.candidate,
        approval_fingerprint: coordinatedApprovalFingerprint(request.candidate) } } };
    const release = releaseFor(request, { uploadAttempted: true, uploaded: true, processed: true,
      internal: true, compatibilityProtected: true, artifactSha256: value.artifactHash,
      storeBuildId: request.candidate.store_build_id });
    const candidate = productionCandidateFor(request);
    const calls = [];
    let invoked = false;
    const result = await runTrustedStoreAdapter({ request,
      registryRunner: ({ command }) => {
        if (command === "inspect") return { reservations: { ios: release } };
        if (command === "production-status") return { production: { candidate,
          operations: invoked ? [{ operationId: request.attempt_id, action: "release", status: "succeeded",
            candidate, receipt: {} }] : [] } };
        return { production: { candidate, operations: [] } };
      },
      productionRunner: async (input) => {
        calls.push(input);
        invoked = true;
        return { observed: { matched: true, terminal: true, authoritative: true } };
      },
      snapshotRunner: async () => ({ versions: [] }) });
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].env.PRODUCTION_RELEASE_APPROVED, "true");
    assert.equal(calls[0].env.PRODUCTION_RELEASE_APPROVAL_SHA256,
      productionCandidateFingerprint(candidate));
    assert.notEqual(calls[0].env.PRODUCTION_RELEASE_APPROVAL_SHA256,
      coordinatedApprovalFingerprint(value.candidate));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("availability marker response loss resumes before the upload attempt", async () => {
  const root = mkdtempSync(join(tmpdir(), "ash-atlas-adapter-marker-recovery-"));
  try {
    const value = fixture(root);
    const request = requestFor(value);
    let release = releaseFor(request);
    let markerResponseLost = true;
    let commandCount = 0;
    const registryRunner = ({ command, args }) => {
      if (command === "inspect") return { reservations: { ios: release } };
      if (command === "transition") {
        const patch = JSON.parse(args[args.indexOf("--patch") + 1]);
        release = { ...release, ...patch };
        if (patch.availabilityPending !== undefined) release.availabilityPending = patch.availabilityPending;
        if (markerResponseLost && patch.availabilityPending) {
          markerResponseLost = false;
          throw new Error("simulated availability marker response loss");
        }
        return { reservations: { ios: release } };
      }
      return { production: { platforms: { ios: { candidate: null, phase: "idle", history: [] },
        android: { candidate: null, phase: "idle", history: [] } }, operations: [] } };
    };
    const env = { COORDINATED_FASTLANE_ROOT: value.fastlaneRoot, GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "example-org/game", GITHUB_RUN_ID: "44" };
    const dependencies = { request, env, registryRunner,
      commandRunner: () => { commandCount += 1; return ""; },
      internalVerifier: async () => ({ storeBuildId: "ios-store-22" }),
      compatibilityVerifier: async () => ({ status: "supported", serverSha }) };
    const first = await runTrustedStoreAdapter(dependencies);
    assert.equal(first.status, "ACTION_REQUIRED");
    assert.ok(release.availabilityPending);
    assert.equal(release.uploadAttempted, false);
    const resumed = await runTrustedStoreAdapter(dependencies);
    assert.equal(resumed.status, "ok", JSON.stringify(resumed));
    assert.equal(commandCount, 1);
    assert.equal(release.availabilityPending, null);
    assert.equal(release.uploadAttempted, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("trusted adapter rejects a candidate packet with the wrong source identity", () => {
  const root = mkdtempSync(join(tmpdir(), "ash-atlas-adapter-identity-"));
  try {
    const value = fixture(root);
    assert.throws(() => validateRequest({ ...requestFor(value), candidate: { ...value.candidate, source_sha: "f".repeat(40) } }),
      /candidate identity/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
