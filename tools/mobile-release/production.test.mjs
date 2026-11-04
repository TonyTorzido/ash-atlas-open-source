import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  allowedProductionRequest,
  assertGooglePreSubmitEligibility,
  buildGoogleProductionTrack,
  productionGoogleSnapshot,
  productionAppleSnapshot,
  pauseAppleProduction,
  resumeAppleProduction,
  releaseAppleProduction,
  submitGoogleProduction,
  submitAppleProduction,
  resumeGoogleProduction
} from "./production-store-api.mjs";
import {
  beginProductionOperation,
  cancelProductionCandidate,
  finishProductionOperation,
  markProductionUncertain,
  recordProductionSubstep,
  prepareProductionCandidate,
  productionCandidateFingerprint,
  productionOperationBlocksActivation,
  productionStatus,
  reconcileProductionOperation,
  sha256Json
} from "./production-registry.mjs";
import {
  assertPreparedCandidate,
  assertRemoteBaseline,
  assertReleaseServerFence,
  approvedMetadataPacketHash,
  applyProductionTransition,
  buildProductionTransition,
  assertPublishedMasterAncestry,
  buildProductionStoreContext,
  candidateRequest,
  classifyObservedProductionAction,
  productionArtifactFingerprint,
  readApprovedMetadataPacket,
  readGoogleManagedPublishingAttestation,
  assertProductionMetadataBinding,
  remoteBaselineFor,
  runProductionAction,
  reconcileProductionAction
} from "./production.mjs";
import { reserveBuilds, setActivationIntent, transitionRelease } from "./registry.mjs";

const seed = () => JSON.parse(readFileSync(new URL("../../config/mobile-release-registry.seed.json", import.meta.url)));
const sourceSha = "a".repeat(40);
const artifactSha = "b".repeat(64);
const toolSha = "c".repeat(40);
const metadataHash = "d".repeat(64);
const serverSha = "e".repeat(40);
const publishedMasterSha = "f".repeat(40);

function googleManagedPublishingAttestation(candidate, overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "ash-atlas-google-managed-publishing-attestation",
    operationId: candidate.operationId,
    candidateFingerprint: productionCandidateFingerprint(candidate),
    packageName: "com.ashatlas.game",
    track: "production",
    consoleIdentity: "play-console:com.ashatlas.game:production",
    managedPublishing: true,
    appPreviouslyAvailable: true,
    observedAt: new Date().toISOString(),
    ...overrides
  };
}

function verifiedRegistry(platforms = ["android"]) {
  const request = {
    releaseId: "production-fixture",
    platforms,
    marketingVersions: Object.fromEntries(platforms.map((platform) => [platform, "1.2.0"])),
    generation: "t1250", sourceSha, protocolMin: 3, protocolMax: 3,
    now: "2026-09-21T00:00:00Z", releaseMode: "internal",
    remoteMaximum: Object.fromEntries(platforms.map((platform) => [platform, platform === "android" ? 71 : 21]))
  };
  let registry = reserveBuilds(seed(), request).registry;
  for (const platform of platforms) {
    const release = registry.releases.find((entry) => entry.releaseId === request.releaseId && entry.platform === platform);
    registry = transitionRelease(registry, release.reservationId, {
      uploadAttempted: true, uploaded: true, processed: true, internal: true,
      artifactSha256: artifactSha, storeBuildId: platform === "android" ? String(release.build) : `ios-${release.build}`,
      receiptUrl: "https://example.test/mobile/internal"
    });
  }
  return registry;
}

function candidate(platform, snapshot, overrides = {}) {
  const release = verifiedRegistry([platform]).releases.find((entry) => entry.releaseId === "production-fixture" && entry.platform === platform);
  return {
    schemaVersion: 1, platform, releaseId: release.releaseId, operationId: `candidate:${platform}`,
    sourceSha, acceptedSha: sourceSha, generation: release.generation,
    marketingVersion: release.marketingVersion, build: release.build, storeBuildId: release.storeBuildId,
    artifactSha256: artifactSha, protocol: { min: 3, max: 3 },
    toolingApproval: { approved: true, toolSha, actor: "fixture", receiptUrl: "https://github.com/example/repo/actions/runs/1", approvedAt: "2026-09-21T00:00:00Z" },
    toolSha, metadataHash, countries: ["US"],
    rollout: { kind: snapshot.firstLaunch ? "first-publish" : "update",
      mode: snapshot.firstLaunch ? (platform === "ios" ? "manual" : "full") : "staged", fraction: 0.1 },
    serverCompatibility: { schemaVersion: 1, serverSha, serverProtocol: { min: 3, max: 3 },
      hardMinimum: { [platform]: { version: "0.0.0", build: 0 } } },
    remoteBaselineFingerprint: sha256Json(remoteBaselineFor(platform, snapshot)), firstLaunch: snapshot.firstLaunch,
    managedPublishing: platform === "android" ? true : null,
    publishedMasterSha, activationFenceFingerprint: null,
    preparedAt: "2026-09-21T00:00:00Z", ...overrides
  };
}

test("production allowlist has no beta credential or endpoint escape", () => {
  assert.equal(allowedProductionRequest("google", "PUT", "/androidpublisher/v3/applications/com.ashatlas.game/edits/1/tracks/production", true), true);
  assert.equal(allowedProductionRequest("google", "POST", "/androidpublisher/v3/applications/com.ashatlas.game/edits/1:commit?changesNotSentForReview=false&changesInReviewBehavior=ERROR_IF_IN_REVIEW", true), true);
  assert.equal(allowedProductionRequest("google", "PUT", "/androidpublisher/v3/applications/com.ashatlas.game/edits/1/tracks/beta", true), false);
  assert.equal(allowedProductionRequest("google", "PUT", "/androidpublisher/v3/applications/com.other/edits/1/tracks/production", true), false);
  assert.equal(allowedProductionRequest("apple", "POST", "/v1/reviewSubmissions", true), true);
  assert.equal(allowedProductionRequest("apple", "POST", "/v1/reviewSubmissionItems", true), true);
  assert.equal(allowedProductionRequest("apple", "PATCH", "/v1/reviewSubmissions/submission-1", true), true);
  assert.equal(allowedProductionRequest("apple", "POST", "/v1/appStoreVersionSubmissions", true), false);
  assert.equal(allowedProductionRequest("apple", "PATCH", "/v1/apps/app", true), false);
  assert.equal(allowedProductionRequest("apple", "POST", "/v1/betaAppReviewSubmissions", true), false);
});

test("wrong app or candidate identity fails before a production write", () => {
  const snapshot = { packageName: "com.ashatlas.game", firstLaunch: true, productionTrack: { track: "production", releases: [] }, maximum: 72 };
  const bad = candidate("android", snapshot, { sourceSha: "f".repeat(40), acceptedSha: sourceSha });
  assert.throws(() => buildGoogleProductionTrack(snapshot, bad, "submit"), /candidate|identity/u);
  assert.equal(snapshot.productionTrack.releases.length, 0);
});

test("Google production update preserves an unrelated newer internal artifact", () => {
  const snapshot = { packageName: "com.ashatlas.game", firstLaunch: false, maximum: 99,
    productionTrack: { track: "production", releases: [{ name: "old", versionCodes: ["50"], status: "completed" }] },
    bundles: [{ versionCode: 72, sha256: artifactSha }, { versionCode: 99, sha256: "f".repeat(64) }] };
  const c = candidate("android", snapshot, { build: 72, storeBuildId: "72", rollout: { kind: "update", mode: "staged", fraction: 0.1 } });
  const desired = buildGoogleProductionTrack(snapshot, c, "submit");
  assert.deepEqual(desired.releases.map((release) => release.versionCodes), [["50"], ["72"]]);
  assert.equal(desired.releases.find((release) => release.versionCodes.includes("99")), undefined);
});

test("Google submit review state can advance to a staged update with a fresh transition snapshot", () => {
  const initial = { packageName: "com.ashatlas.game", firstLaunch: false,
    productionTrack: { track: "production", releases: [{ name: "old", versionCodes: ["50"], status: "completed" }] },
    bundles: [{ versionCode: 72, sha256: artifactSha }] };
  const c = candidate("android", initial, { build: 72, storeBuildId: "72", firstLaunch: false,
    rollout: { kind: "update", mode: "staged", fraction: 0.1 } });
  const submittedTrack = buildGoogleProductionTrack(initial, c, "submit");
  assert.equal(submittedTrack.releases.find((release) => release.versionCodes.includes("72")).status, "inProgress");
  const afterReview = { ...initial, productionTrack: submittedTrack };
  const releasedTrack = buildGoogleProductionTrack(afterReview, c, "release");
  assert.equal(releasedTrack.releases.find((release) => release.versionCodes.includes("72")).status, "inProgress");
  assert.equal(releasedTrack.releases.find((release) => release.versionCodes.includes("72")).name, "t1250 (72)");
});

test("first publish is distinct from Apple phased update", () => {
  const snapshot = { bundleId: "com.ashatlas.game", firstLaunch: true, versions: [], builds: [] };
  const c = candidate("ios", snapshot, { rollout: { kind: "first-publish", mode: "manual" }, build: 22, storeBuildId: "ios-build" });
  assert.throws(() => classifyObservedProductionAction("advance", "ios", c, snapshot), /first publish|identity|version/u);
  const updateSnapshot = { ...snapshot, firstLaunch: false, versions: [{ id: "v1", versionString: c.marketingVersion,
    state: "READY_FOR_SALE", releaseType: "MANUAL", buildId: c.storeBuildId, phasedReleaseId: "phase-1",
    phasedReleaseState: "PAUSED" }] };
  const update = { ...c, firstLaunch: false, rollout: { kind: "update", mode: "staged", fraction: 0.25 },
    remoteBaselineFingerprint: sha256Json(remoteBaselineFor("ios", updateSnapshot)) };
  assert.equal(classifyObservedProductionAction("pause", "ios", update, updateSnapshot).matched, true);
});

test("uncertain store responses remain pending until an authoritative reconcile", () => {
  const snapshot = { platform: "android", packageName: "com.ashatlas.game", firstLaunch: true,
    productionTrack: { track: "production", releases: [] }, maximum: 72 };
  let registry = verifiedRegistry();
  const release = registry.releases.find((entry) => entry.releaseId === "production-fixture" && entry.platform === "android");
  const c = candidate("android", snapshot);
  registry = prepareProductionCandidate(registry, { platform: "android", release, operationId: c.operationId,
    toolingApproval: c.toolingApproval, metadataHash, countries: c.countries, rollout: c.rollout,
    serverCompatibility: c.serverCompatibility, remoteBaseline: remoteBaselineFor("android", snapshot), preparedAt: c.preparedAt });
  const prepared = productionStatus(registry, "android");
  registry = beginProductionOperation(registry, { operationId: "candidate:android:submit", platform: "android", action: "submit",
    candidate: prepared.candidate, expectedBaselineFingerprint: null, expectedRemoteFingerprint: sha256Json(remoteBaselineFor("android", snapshot)) });
  registry = markProductionUncertain(registry, "candidate:android:submit", { receipt: { schemaVersion: 1 } });
  const uncertain = productionStatus(registry, "android").operations[0];
  assert.equal(uncertain.status, "uncertain");
  const unknownObservation = { candidateFingerprint: productionCandidateFingerprint(uncertain.candidate),
    expectedRemoteFingerprint: uncertain.expectedRemoteFingerprint, matched: false, terminal: false, authoritative: false };
  registry = reconcileProductionOperation(registry, uncertain.operationId, { observed: unknownObservation, reconciledAt: "2026-09-21T00:01:00Z" });
  assert.equal(productionStatus(registry, "android").operations[0].status, "uncertain");
  registry = reconcileProductionOperation(registry, uncertain.operationId, { observed: publishedObservation(uncertain.candidate,
    uncertain.expectedRemoteFingerprint, { phase: "submitted" }), reconciledAt: "2026-09-21T00:02:00Z" });
  assert.equal(productionStatus(registry, "android").operations[0].status, "succeeded");
});

test("reconcile does not cancel a journaled unchanged write and advances an observed partial", async () => {
  const initial = { packageName: "com.ashatlas.game", firstLaunch: true,
    productionTrack: { track: "production", releases: [] }, productionLifecycle: [],
    bundles: [{ versionCode: 72, sha256: artifactSha }], apks: [] };
  const c = candidate("android", initial, { countries: [] });
  const release = verifiedRegistry().releases.find((entry) => entry.releaseId === c.releaseId && entry.platform === "android");
  let registry = prepareProductionCandidate(verifiedRegistry(), { platform: "android", release,
    operationId: c.operationId, toolingApproval: c.toolingApproval, metadataHash, countries: [], rollout: c.rollout,
    serverCompatibility: c.serverCompatibility, remoteBaseline: remoteBaselineFor("android", initial),
    publishedMasterSha, activationFenceFingerprint: null, preparedAt: c.preparedAt });
  const prepared = productionStatus(registry, "android").candidate;
  const operationId = "candidate:android:journaled-release";
  registry = beginProductionOperation(registry, { operationId, platform: "android", action: "release", candidate: prepared,
    expectedBaselineFingerprint: null, expectedRemoteFingerprint: prepared.remoteBaselineFingerprint });
  registry = recordProductionSubstep(registry, operationId, { stepId: "google.track.update", status: "uncertain",
    requestFingerprint: "1".repeat(64) });
  registry = markProductionUncertain(registry, operationId);
  const unchangedApi = async (method, path) => {
    if (method === "POST" && path.endsWith("/edits")) return { id: "read-edit" };
    if (method === "DELETE") return {};
    if (path.endsWith("/tracks")) return { tracks: [initial.productionTrack] };
    if (path.endsWith("/bundles")) return { bundles: initial.bundles };
    if (path.endsWith("/apks")) return { apks: initial.apks };
    if (path.endsWith("/tracks/production/releases")) return { releases: [] };
    throw new Error(`unexpected unchanged read ${method} ${path}`);
  };
  const unchanged = await reconcileProductionAction({ action: "release", platform: "android", candidate: prepared,
    clients: { google: unchangedApi }, registry, operationId });
  assert.equal(productionStatus(unchanged.registry, "android").operations[0].status, "uncertain");

  const partialTrack = { track: "production", releases: [{ name: "t1250 (72)", versionCodes: ["72"], status: "completed" }] };
  const partialApi = async (method, path) => {
    if (method === "POST" && path.endsWith("/edits")) return { id: "partial-edit" };
    if (method === "DELETE") return {};
    if (path.endsWith("/tracks")) return { tracks: [partialTrack] };
    if (path.endsWith("/bundles")) return { bundles: initial.bundles };
    if (path.endsWith("/apks")) return { apks: initial.apks };
    if (path.endsWith("/tracks/production/releases")) return { releases: [] };
    throw new Error(`unexpected partial read ${method} ${path}`);
  };
  const partial = await reconcileProductionAction({ action: "release", platform: "android", candidate: prepared,
    clients: { google: partialApi }, registry, operationId });
  const rebased = productionStatus(partial.registry, "android").operations[0];
  assert.equal(rebased.status, "uncertain");
  assert.equal(rebased.expectedRemoteFingerprint, sha256Json(remoteBaselineFor("android", {
    ...initial, firstLaunch: false, productionTrack: partialTrack
  })));
  assert.equal(rebased.substeps.find((step) => step.stepId === "google.track.update").status, "observed");
});

test("platform receipts are independent after a partial batch", () => {
  const iosSnapshot = { bundleId: "com.ashatlas.game", firstLaunch: true, versions: [] };
  const androidSnapshot = { packageName: "com.ashatlas.game", firstLaunch: true, productionTrack: { track: "production", releases: [] } };
  let registry = verifiedRegistry(["ios", "android"]);
  for (const [platform, snapshot] of [["ios", iosSnapshot], ["android", androidSnapshot]]) {
    const release = registry.releases.find((entry) => entry.releaseId === "production-fixture" && entry.platform === platform);
    const c = candidate(platform, snapshot);
    registry = prepareProductionCandidate(registry, { platform, release, operationId: c.operationId, toolingApproval: c.toolingApproval,
      metadataHash, countries: c.countries, rollout: c.rollout, serverCompatibility: c.serverCompatibility,
      remoteBaseline: remoteBaselineFor(platform, snapshot), preparedAt: c.preparedAt });
    registry = beginProductionOperation(registry, { operationId: `${c.operationId}:submit`, platform, action: "submit",
      candidate: productionStatus(registry, platform).candidate, expectedBaselineFingerprint: null,
      expectedRemoteFingerprint: sha256Json(remoteBaselineFor(platform, snapshot)) });
  }
  const iosOperation = productionStatus(registry, "ios").operations[0];
  registry = finishProductionOperation(registry, "candidate:ios:submit", { status: "succeeded", receipt: { schemaVersion: 1 },
    remote: publishedObservation(iosOperation.candidate, iosOperation.expectedRemoteFingerprint, { phase: "submitted" }) });
  assert.equal(productionStatus(registry, "ios").operations[0].status, "succeeded");
  assert.equal(productionStatus(registry, "android").operations[0].status, "pending");
});

test("server activation race and cumulative production source fail closed", () => {
  const snapshot = { packageName: "com.ashatlas.game", firstLaunch: true, productionTrack: { track: "production", releases: [] } };
  const c = candidate("android", snapshot);
  assert.throws(() => assertReleaseServerFence(c, { schemaVersion: 1, serverSha: serverSha,
    serverProtocol: { min: 4, max: 4 }, hardMinimum: { version: "0.0.0", build: 0 } }), /overlap/u);
  let registry = verifiedRegistry();
  const release = registry.releases.find((entry) => entry.releaseId === "production-fixture" && entry.platform === "android");
  registry = prepareProductionCandidate(registry, { platform: "android", release, operationId: c.operationId,
    toolingApproval: c.toolingApproval, metadataHash, countries: c.countries, rollout: c.rollout,
    serverCompatibility: c.serverCompatibility, remoteBaseline: remoteBaselineFor("android", snapshot), preparedAt: c.preparedAt });
  registry = beginProductionOperation(registry, { operationId: "candidate:android:release", platform: "android", action: "release",
    candidate: productionStatus(registry, "android").candidate, expectedBaselineFingerprint: null,
    expectedRemoteFingerprint: sha256Json(remoteBaselineFor("android", snapshot)) });
  const androidOperation = productionStatus(registry, "android").operations[0];
  registry = finishProductionOperation(registry, "candidate:android:release", { status: "succeeded", receipt: { schemaVersion: 1 },
    remote: publishedObservation(androidOperation.candidate, androidOperation.expectedRemoteFingerprint, { phase: "completed" }) });
  assert.equal(productionStatus(registry, "android").baseline.sourceSha, sourceSha);
  const older = { ...productionStatus(registry, "android").candidate, build: 71, operationId: "older" };
  assert.throws(() => prepareProductionCandidate(registry, { platform: "android", release: { ...release, build: 71 }, operationId: "older",
    toolingApproval: c.toolingApproval, metadataHash, countries: c.countries, rollout: c.rollout,
    serverCompatibility: c.serverCompatibility, remoteBaseline: remoteBaselineFor("android", snapshot), preparedAt: c.preparedAt }), /newer than/u);
  assertRemoteBaseline(productionStatus(registry, "android").candidate, "android", snapshot);
  assert.equal(older.storeBuildId, release.storeBuildId);
});

test("snapshot reads production without treating beta as production", async () => {
  const calls = [];
  const api = async (method, path) => {
    calls.push({ method, path });
    if (method === "POST" && path.endsWith("/edits")) return { id: "edit-1" };
    if (method === "DELETE") return {};
    if (path.endsWith("/tracks")) return { tracks: [{ track: "beta", releases: [{ versionCodes: ["80"], status: "completed" }] }] };
    if (path.endsWith("/tracks/production/releases")) return { releases: [] };
    if (path.endsWith("/bundles")) return { bundles: [{ versionCode: 80 }] };
    if (path.endsWith("/apks")) return { apks: [] };
    throw new Error(`unexpected ${method} ${path}`);
  };
  const snapshot = await productionGoogleSnapshot(api);
  assert.equal(snapshot.firstLaunch, true);
  assert.deepEqual(snapshot.productionTrack.releases, []);
  assert.ok(calls.every((call) => !call.path.endsWith("/tracks/beta")));
});

test("Google snapshot keeps the edit track for writes and normalizes live production lifecycle", async () => {
  const api = async (method, path) => {
    if (method === "POST" && path.endsWith("/edits")) return { id: "edit-1" };
    if (method === "DELETE") return {};
    if (path.endsWith("/tracks")) return { tracks: [{ track: "production", releases: [
      { name: "t1250 (72)", versionCodes: ["72"], status: "halted", userFraction: 0.1 }
    ] }] };
    if (path.endsWith("/tracks/production/releases")) return { releases: [{
      releaseName: "t1250 (72)", track: "production", activeArtifacts: [{ versionCode: 72 }],
      releaseLifecycleState: "RELEASE_LIFECYCLE_STATE_PUBLISHED"
    }] };
    if (path.endsWith("/bundles")) return { bundles: [{ versionCode: 72 }] };
    if (path.endsWith("/apks")) return { apks: [] };
    throw new Error(`unexpected ${method} ${path}`);
  };
  const snapshot = await productionGoogleSnapshot(api);
  assert.equal(snapshot.firstLaunch, false);
  assert.equal(snapshot.productionTrack.releases[0].status, "halted");
  assert.deepEqual(snapshot.productionLifecycle, [{ name: "t1250 (72)", track: "production",
    versionCodes: ["72"], lifecycleState: "RELEASE_LIFECYCLE_STATE_PUBLISHED" }]);
  assert.equal(snapshot.productionLifecycleComplete, true);
});

test("Google pre-submit gate is operation-bound and rejects first publication or incomplete lifecycle history before any edit write", async () => {
  const calls = [];
  const productionTrack = { track: "production", releases: [{ name: "t1249 (70)", versionCodes: ["70"], status: "completed" }] };
  const lifecycle = Array.from({ length: 20 }, (_, index) => ({
    releaseName: `t${1249 - index} (${70 - index})`, track: "production",
    activeArtifacts: [{ versionCode: 70 - index }],
    releaseLifecycleState: "RELEASE_LIFECYCLE_STATE_PUBLISHED"
  }));
  const api = async (method, path) => {
    calls.push({ method, path });
    if (method === "POST" && path.endsWith("/edits")) return { id: "snapshot-edit" };
    if (method === "DELETE") return {};
    if (path.endsWith("/tracks")) return { tracks: [productionTrack] };
    if (path.endsWith("/bundles")) return { bundles: [{ versionCode: 72, sha256: artifactSha }] };
    if (path.endsWith("/apks")) return { apks: [] };
    if (path.endsWith("/tracks/production/releases")) return { releases: lifecycle };
    throw new Error(`unexpected Google pre-submit request ${method} ${path}`);
  };
  const snapshot = await productionGoogleSnapshot(api);
  const c = candidate("android", snapshot, { firstLaunch: false, build: 72, storeBuildId: "72", countries: [],
    rollout: { kind: "update", mode: "staged", fraction: 0.1 } });
  const context = { operationId: "candidate:android:submit", candidateFingerprint: productionCandidateFingerprint(c),
    managedPublishingAttestation: googleManagedPublishingAttestation(c, { operationId: "candidate:android:submit" }) };
  assert.throws(() => assertGooglePreSubmitEligibility(snapshot, c, null), /bound to a production operation/u);
  assert.throws(() => assertGooglePreSubmitEligibility({ ...snapshot, managedPublishing: false }, c, context), /not enabled/u);
  assert.throws(() => assertGooglePreSubmitEligibility({ ...snapshot, firstLaunch: true }, c, context), /capped/u);
  await assert.rejects(() => submitGoogleProduction(api, snapshot, c, null, context), /capped/u);
  assert.equal(calls.filter(({ method, path }) => method === "PUT" ||
    (method === "POST" && path.split("?", 1)[0].endsWith(":commit"))).length, 0);
});

test("Google pre-submit refuses omitted Console managed-publishing state and accepts only a fresh operation-bound attestation", async () => {
  const calls = [];
  const productionTrack = { track: "production", releases: [{ name: "t1249 (70)", versionCodes: ["70"], status: "completed" }] };
  const lifecycle = Array.from({ length: 19 }, (_, index) => ({
    releaseName: `t${1249 - index} (${70 - index})`, track: "production",
    activeArtifacts: [{ versionCode: 70 - index }],
    releaseLifecycleState: "RELEASE_LIFECYCLE_STATE_PUBLISHED"
  }));
  const api = async (method, path) => {
    calls.push({ method, path });
    if (method === "POST" && path.endsWith("/edits")) return { id: "snapshot-edit" };
    if (method === "DELETE") return {};
    if (path.endsWith("/tracks")) return { tracks: [productionTrack] };
    if (path.endsWith("/bundles")) return { bundles: [{ versionCode: 72, sha256: artifactSha }] };
    if (path.endsWith("/apks")) return { apks: [] };
    if (path.endsWith("/tracks/production/releases")) return { releases: lifecycle };
    throw new Error(`unexpected Google attestation request ${method} ${path}`);
  };
  const snapshot = await productionGoogleSnapshot(api);
  const c = candidate("android", snapshot, { firstLaunch: false, build: 72, storeBuildId: "72", countries: [],
    rollout: { kind: "update", mode: "staged", fraction: 0.1 } });
  const operationId = "candidate:android:attested-submit";
  const baseContext = { operationId, candidateFingerprint: productionCandidateFingerprint(c) };
  assert.equal(snapshot.managedPublishing, null);
  assert.throws(() => assertGooglePreSubmitEligibility(snapshot, c, baseContext), /attestation is required/u);
  await assert.rejects(() => submitGoogleProduction(api, snapshot, c, null, baseContext), /attestation is required/u);
  assert.equal(calls.filter(({ method, path }) => method === "PUT" ||
    (method === "POST" && path.split("?", 1)[0].endsWith(":commit"))).length, 0);

  const attestation = googleManagedPublishingAttestation(c, { operationId });
  const context = { ...baseContext, managedPublishingAttestation: attestation };
  const proof = assertGooglePreSubmitEligibility(snapshot, c, context);
  assert.equal(proof.managedPublishing, true);
  assert.equal(proof.appPreviouslyAvailable, true);
  assert.equal(typeof proof.managedPublishingAttestationFingerprint, "string");
  assert.throws(() => assertGooglePreSubmitEligibility(snapshot, c, {
    ...context,
    managedPublishingAttestation: { ...attestation,
      observedAt: new Date(Date.now() - 16 * 60 * 1000).toISOString() }
  }), /stale/u);

  const directory = mkdtempSync(join(tmpdir(), "ash-atlas-google-attestation-"));
  const path = join(directory, "managed-publishing.json");
  try {
    writeFileSync(path, `${JSON.stringify(attestation)}\n`);
    assert.deepEqual(readGoogleManagedPublishingAttestation({
      GOOGLE_PLAY_MANAGED_PUBLISHING_ATTESTATION_PATH: path
    }), attestation);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the production CLI store context binds the exact candidate before Google submission", () => {
  const snapshot = { packageName: "com.ashatlas.game", firstLaunch: false,
    productionTrack: { track: "production", releases: [{ name: "t1249 (70)", versionCodes: ["70"], status: "completed" }] },
    productionLifecycle: [{ name: "t1249 (70)", track: "production", versionCodes: ["70"],
      lifecycleState: "RELEASE_LIFECYCLE_STATE_PUBLISHED" }], productionLifecycleComplete: true };
  const c = candidate("android", snapshot, { firstLaunch: false, build: 72, storeBuildId: "72", countries: [],
    rollout: { kind: "update", mode: "staged", fraction: 0.1 } });
  const context = buildProductionStoreContext({ operationId: "candidate:android:cli-submit", candidate: c,
    managedPublishingAttestation: googleManagedPublishingAttestation(c,
      { operationId: "candidate:android:cli-submit" }) });
  assert.equal(context.operationId, "candidate:android:cli-submit");
  assert.equal(context.candidateFingerprint, productionCandidateFingerprint(c));
  assert.equal(context.managedPublishingAttestation.operationId, context.operationId);
  assert.doesNotThrow(() => assertGooglePreSubmitEligibility(snapshot, c, context));
});

test("Google production action classification requires live published lifecycle evidence", () => {
  const snapshot = { packageName: "com.ashatlas.game", firstLaunch: false,
    productionTrack: { track: "production", releases: [{ name: "t1250 (72)", versionCodes: ["72"],
      status: "inProgress", userFraction: 0.1 }] },
    productionLifecycle: [{ name: "t1250 (72)", track: "production", versionCodes: ["72"],
      lifecycleState: "RELEASE_LIFECYCLE_STATE_PUBLISHED" }] };
  const c = candidate("android", snapshot, { firstLaunch: false, build: 72, storeBuildId: "72",
    rollout: { kind: "update", mode: "staged", fraction: 0.1 }, countries: [] });
  const released = classifyObservedProductionAction("release", "android", c, snapshot);
  assert.equal(released.matched, true);
  assert.equal(released.available, true);
  const pending = { ...snapshot, productionLifecycle: [{ ...snapshot.productionLifecycle[0],
    lifecycleState: "RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED" }] };
  const pendingObservation = classifyObservedProductionAction("release", "android", c, pending,
    sha256Json(remoteBaselineFor("android", pending)));
  assert.equal(pendingObservation.matched, false);
  assert.equal(pendingObservation.available, false);
  const draft = { ...snapshot, productionTrack: { track: "production", releases: [{ name: "t1250 (72)",
    versionCodes: ["72"], status: "draft" }] }, productionLifecycle: [] };
  const submitted = classifyObservedProductionAction("submit", "android", c, draft,
    sha256Json(remoteBaselineFor("android", draft)));
  assert.equal(submitted.matched, false);
  assert.match(submitted.actionRequiredReason, /Send for review/u);
  assert.equal(submitted.published, false);
});

test("Google real runner submits for review, waits for approval, and uses a read-only publish handoff", async () => {
  let productionTrack = { track: "production", releases: [
    { name: "t1249 (70)", versionCodes: ["70"], status: "completed" }
  ] };
  let productionLifecycle = [
    { name: "t1249 (70)", versionCodes: ["70"], lifecycleState: "RELEASE_LIFECYCLE_STATE_PUBLISHED" }
  ];
  let editNumber = 0;
  let commitBody;
  let commitPath;
  let trackWrites = 0;
  const api = async (method, path, body) => {
    if (method === "POST" && path.endsWith("/edits")) return { id: `edit-${++editNumber}` };
    if (method === "DELETE") return {};
    if (method === "GET" && path.endsWith("/tracks")) return { tracks: [productionTrack] };
    if (method === "GET" && path.endsWith("/bundles")) return { bundles: [{ versionCode: 72, sha256: artifactSha }] };
    if (method === "GET" && path.endsWith("/apks")) return { apks: [] };
    if (method === "GET" && path.endsWith("/tracks/production/releases")) {
      return { releases: productionLifecycle.map((entry) => ({ releaseName: entry.name, track: "production",
        activeArtifacts: [{ versionCode: Number(entry.versionCodes[0]) }], releaseLifecycleState: entry.lifecycleState })) };
    }
    if (method === "PUT" && path.includes("/tracks/production")) {
      trackWrites += 1;
      productionTrack = structuredClone(body);
      return {};
    }
    if (method === "POST" && path.split("?", 1)[0].endsWith(":commit")) {
      commitBody = body;
      commitPath = path;
      const release = productionTrack.releases.find((entry) => entry.versionCodes.includes("72"));
      productionLifecycle = [...productionLifecycle, { name: release.name, versionCodes: release.versionCodes,
        lifecycleState: "RELEASE_LIFECYCLE_STATE_NOT_SENT_FOR_REVIEW" }];
      return {};
    }
    throw new Error(`unexpected Google runner request ${method} ${path}`);
  };
  const initialSnapshot = await productionGoogleSnapshot(api);
  const c = candidate("android", initialSnapshot, { countries: [] });
  const release = verifiedRegistry().releases.find((entry) => entry.releaseId === c.releaseId && entry.platform === "android");
  let registry = prepareProductionCandidate(verifiedRegistry(), { platform: "android", release,
    operationId: c.operationId, toolingApproval: c.toolingApproval, metadataHash, countries: [], rollout: c.rollout,
    serverCompatibility: c.serverCompatibility, remoteBaseline: remoteBaselineFor("android", initialSnapshot),
    managedPublishing: c.managedPublishing,
    publishedMasterSha, activationFenceFingerprint: null, preparedAt: c.preparedAt });
  const prepared = productionStatus(registry, "android").candidate;
  let submitError;
  try {
    await runProductionAction({ action: "submit", platform: "android", candidate: prepared,
      registry, operationId: "candidate:android:submit", clients: { google: api }, snapshot: initialSnapshot,
      serverProof: prepared.serverCompatibility, expectedRemoteFingerprint: prepared.remoteBaselineFingerprint,
      managedPublishingAttestation: googleManagedPublishingAttestation(prepared,
        { operationId: "candidate:android:submit" }) });
  } catch (error) {
    submitError = error;
  }
  assert.match(submitError?.message ?? "", /Send for review/u);
  registry = submitError.productionRegistry;
  assert.equal(commitBody, undefined);
  const commitUrl = new URL(`https://example.test${commitPath}`);
  assert.equal(commitUrl.searchParams.get("changesNotSentForReview"), "false");
  assert.equal(commitUrl.searchParams.get("changesInReviewBehavior"), "ERROR_IF_IN_REVIEW");
  assert.equal(trackWrites, 1);
  productionLifecycle = productionLifecycle.map((entry) => entry.versionCodes.includes("72")
    ? { ...entry, lifecycleState: "RELEASE_LIFECYCLE_STATE_IN_REVIEW" } : entry);
  const submitted = await reconcileProductionAction({ action: "submit", platform: "android", candidate: prepared,
    clients: { google: api }, registry, operationId: "candidate:android:submit",
    expectedRemoteFingerprint: prepared.remoteBaselineFingerprint });
  registry = submitted.registry;
  assert.equal(productionStatus(registry, "android").operations[0].status, "succeeded");
  assert.equal(submitted.observed.reviewSubmitted, true);
  productionLifecycle = productionLifecycle.map((entry) => entry.versionCodes.includes("72")
    ? { ...entry, lifecycleState: "RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED" } : entry);
  const approvedSnapshot = await productionGoogleSnapshot(api);
  const releaseCandidate = productionStatus(registry, "android").candidate;
  let releaseError;
  try {
    await runProductionAction({ action: "release", platform: "android", candidate: releaseCandidate,
      registry, operationId: "candidate:android:release", clients: { google: api }, snapshot: approvedSnapshot,
      serverProof: releaseCandidate.serverCompatibility, releaseApproved: true,
      approvalFingerprint: productionCandidateFingerprint(releaseCandidate),
      expectedRemoteFingerprint: sha256Json(remoteBaselineFor("android", approvedSnapshot)) });
  } catch (error) {
    releaseError = error;
  }
  assert.match(releaseError?.message ?? "", /Publish changes/u);
  registry = releaseError.productionRegistry;
  const pending = await reconcileProductionAction({ action: "release", platform: "android", candidate: releaseCandidate,
    clients: { google: api }, registry, operationId: "candidate:android:release",
    expectedRemoteFingerprint: sha256Json(remoteBaselineFor("android", approvedSnapshot)) });
  registry = pending.registry;
  assert.equal(pending.observed.assignmentConfirmed, true);
  assert.equal(productionOperationBlocksActivation(productionStatus(registry, "android").operations.at(-1)), false);
  productionLifecycle = productionLifecycle.map((entry) => entry.versionCodes.includes("72")
    ? { ...entry, lifecycleState: "RELEASE_LIFECYCLE_STATE_PUBLISHED" } : entry);
  const published = await reconcileProductionAction({ action: "release", platform: "android", candidate: releaseCandidate,
    clients: { google: api }, registry, operationId: "candidate:android:release",
    expectedRemoteFingerprint: productionStatus(registry, "android").operations.at(-1).expectedRemoteFingerprint });
  assert.equal(productionStatus(published.registry, "android").operations.at(-1).status, "succeeded");
  assert.equal(productionStatus(published.registry, "android").baseline.storeBuildId, releaseCandidate.storeBuildId);
  assert.equal(trackWrites, 1, "post-health publication handoff must not edit the track");
});

test("Google lost edit commit response stays unresolved until the exact candidate lifecycle is observed", async () => {
  let productionTrack = { track: "production", releases: [
    { name: "t1249 (70)", versionCodes: ["70"], status: "completed" }
  ] };
  let productionLifecycle = [
    { name: "t1249 (70)", versionCodes: ["70"], lifecycleState: "RELEASE_LIFECYCLE_STATE_PUBLISHED" }
  ];
  let trackWrites = 0;
  let commitCalls = 0;
  const api = async (method, path, body) => {
    if (method === "POST" && path.endsWith("/edits")) return { id: `edit-${commitCalls + trackWrites + 1}` };
    if (method === "DELETE") return {};
    if (method === "GET" && path.endsWith("/tracks")) return { tracks: [productionTrack] };
    if (method === "GET" && path.endsWith("/bundles")) return { bundles: [{ versionCode: 72, sha256: artifactSha }] };
    if (method === "GET" && path.endsWith("/apks")) return { apks: [] };
    if (method === "GET" && path.endsWith("/tracks/production/releases")) {
      return { releases: productionLifecycle.map((entry) => ({ releaseName: entry.name, track: "production",
        activeArtifacts: [{ versionCode: Number(entry.versionCodes[0]) }], releaseLifecycleState: entry.lifecycleState })) };
    }
    if (method === "PUT" && path.includes("/tracks/production")) {
      trackWrites += 1;
      productionTrack = structuredClone(body);
      return {};
    }
    if (method === "POST" && path.split("?", 1)[0].endsWith(":commit")) {
      commitCalls += 1;
      const release = productionTrack.releases.find((entry) => entry.versionCodes.includes("72"));
      productionLifecycle = [...productionLifecycle, { name: release.name, versionCodes: release.versionCodes,
        lifecycleState: "RELEASE_LIFECYCLE_STATE_NOT_SENT_FOR_REVIEW" }];
      throw new Error("Google edit commit response lost after the request was accepted");
    }
    throw new Error(`unexpected Google lost-commit request ${method} ${path}`);
  };
  const initialSnapshot = await productionGoogleSnapshot(api);
  const c = candidate("android", initialSnapshot, { firstLaunch: false, build: 72, storeBuildId: "72", countries: [],
    rollout: { kind: "update", mode: "staged", fraction: 0.1 } });
  const release = verifiedRegistry().releases.find((entry) => entry.releaseId === c.releaseId && entry.platform === "android");
  let registry = prepareProductionCandidate(verifiedRegistry(), { platform: "android", release,
    operationId: c.operationId, toolingApproval: c.toolingApproval, metadataHash, countries: [], rollout: c.rollout,
    serverCompatibility: c.serverCompatibility, remoteBaseline: remoteBaselineFor("android", initialSnapshot),
    managedPublishing: c.managedPublishing,
    publishedMasterSha, activationFenceFingerprint: null, preparedAt: c.preparedAt });
  const prepared = productionStatus(registry, "android").candidate;
  const operationId = "candidate:android:lost-commit";
  let firstError;
  try {
    await runProductionAction({ action: "submit", platform: "android", candidate: prepared, registry, operationId,
      clients: { google: api }, snapshot: initialSnapshot, serverProof: prepared.serverCompatibility,
      expectedRemoteFingerprint: prepared.remoteBaselineFingerprint,
      managedPublishingAttestation: googleManagedPublishingAttestation(prepared, { operationId }) });
  } catch (error) {
    firstError = error;
  }
  assert.match(firstError?.message ?? "", /Send for review|response lost/u);
  registry = firstError.productionRegistry;
  assert.equal(trackWrites, 1);
  assert.equal(commitCalls, 1);
  assert.equal(productionStatus(registry, "android").operations[0].status, "uncertain");

  const beforeReview = await reconcileProductionAction({ action: "submit", platform: "android", candidate: prepared,
    clients: { google: api }, registry, operationId, expectedRemoteFingerprint: prepared.remoteBaselineFingerprint });
  registry = beforeReview.registry;
  assert.equal(productionStatus(registry, "android").operations[0].status, "uncertain");
  assert.equal(beforeReview.observed.partial, true);
  assert.equal(commitCalls, 1, "reconcile must not replay a lost commit request");

  productionLifecycle = productionLifecycle.map((entry) => entry.versionCodes.includes("72")
    ? { ...entry, lifecycleState: "RELEASE_LIFECYCLE_STATE_IN_REVIEW" } : entry);
  const afterReview = await reconcileProductionAction({ action: "submit", platform: "android", candidate: prepared,
    clients: { google: api }, registry, operationId,
    expectedRemoteFingerprint: productionStatus(registry, "android").operations[0].expectedRemoteFingerprint });
  assert.equal(productionStatus(afterReview.registry, "android").operations[0].status, "succeeded");
  assert.equal(afterReview.observed.reviewSubmitted, true);
  assert.equal(commitCalls, 1);
});

test("Google approved-not-published assignment reopens compatible activation only after Console publication", async () => {
  let productionTrack = { track: "production", releases: [
    { name: "t1249 (70)", versionCodes: ["70"], status: "completed" },
    { name: "t1250 (72)", versionCodes: ["72"], status: "inProgress", userFraction: 0.1 }
  ] };
  let productionLifecycle = [
    { name: "t1249 (70)", versionCodes: ["70"], lifecycleState: "RELEASE_LIFECYCLE_STATE_PUBLISHED" },
    { name: "t1250 (72)", versionCodes: ["72"], lifecycleState: "RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED" }
  ];
  let unexpectedWrites = 0;
  const api = async (method, path) => {
    if (method === "POST" && path.endsWith("/edits")) return { id: "edit-1" };
    if (method === "DELETE") return {};
    if (method === "GET" && path.endsWith("/tracks")) return { tracks: [productionTrack] };
    if (method === "GET" && path.endsWith("/bundles")) return { bundles: [{ versionCode: 72, sha256: artifactSha }] };
    if (method === "GET" && path.endsWith("/apks")) return { apks: [] };
    if (method === "GET" && path.endsWith("/tracks/production/releases")) {
      return { releases: productionLifecycle.map((entry) => ({ releaseName: entry.name, track: "production",
        activeArtifacts: [{ versionCode: Number(entry.versionCodes[0]) }], releaseLifecycleState: entry.lifecycleState })) };
    }
    if (method === "PUT" || (method === "POST" && path.split("?", 1)[0].endsWith(":commit"))) {
      unexpectedWrites += 1;
      throw new Error("release handoff must not write a Google edit");
    }
    throw new Error(`unexpected Google review-fence request ${method} ${path}`);
  };
  const initialSnapshot = await productionGoogleSnapshot(api);
  const c = candidate("android", initialSnapshot, { firstLaunch: false, build: 72, storeBuildId: "72", countries: [],
    rollout: { kind: "update", mode: "staged", fraction: 0.1 } });
  const release = verifiedRegistry().releases.find((entry) => entry.releaseId === c.releaseId && entry.platform === "android");
  let registry = prepareProductionCandidate(verifiedRegistry(), { platform: "android", release,
    operationId: c.operationId, toolingApproval: c.toolingApproval, metadataHash, countries: [], rollout: c.rollout,
    serverCompatibility: c.serverCompatibility, remoteBaseline: remoteBaselineFor("android", initialSnapshot),
    publishedMasterSha, activationFenceFingerprint: null, preparedAt: c.preparedAt });
  const prepared = productionStatus(registry, "android").candidate;
  const operationId = "candidate:android:release-review-fence";
  let firstError;
  try {
    await runProductionAction({ action: "release", platform: "android", candidate: prepared, registry, operationId,
      clients: { google: api }, snapshot: initialSnapshot, serverProof: prepared.serverCompatibility,
      releaseApproved: true, approvalFingerprint: productionCandidateFingerprint(prepared),
      expectedRemoteFingerprint: prepared.remoteBaselineFingerprint });
  } catch (error) {
    firstError = error;
  }
  assert.match(firstError?.message ?? "", /Publish changes/u);
  registry = firstError.productionRegistry;
  const uncertain = productionStatus(registry, "android").operations[0];
  const reconciled = await reconcileProductionAction({ action: "release", platform: "android", candidate: prepared,
    clients: { google: api }, registry, operationId, expectedRemoteFingerprint: uncertain.expectedRemoteFingerprint });
  registry = reconciled.registry;
  const pending = productionStatus(registry, "android").operations[0];
  assert.equal(pending.receipt.observed.assignmentConfirmed, true);
  assert.equal(pending.receipt.observed.mutation, false);
  assert.equal(productionOperationBlocksActivation(pending), false);
  assert.equal(productionStatus(registry, "android").baseline, null);
  productionLifecycle = productionLifecycle.map((entry) => entry.versionCodes.includes("72")
    ? { ...entry, lifecycleState: "RELEASE_LIFECYCLE_STATE_PUBLISHED" } : entry);
  const published = await reconcileProductionAction({ action: "release", platform: "android", candidate: prepared,
    clients: { google: api }, registry, operationId, expectedRemoteFingerprint: pending.expectedRemoteFingerprint });
  assert.equal(productionStatus(published.registry, "android").operations[0].status, "succeeded");
  assert.equal(productionStatus(published.registry, "android").baseline.storeBuildId, prepared.storeBuildId);
  assert.equal(unexpectedWrites, 0);
});

test("Google pre-server lifecycle never treats a draft or public release as ready", () => {
  const base = { packageName: "com.ashatlas.game", firstLaunch: false,
    productionTrack: { track: "production", releases: [{ name: "t1250 (72)", versionCodes: ["72"], status: "inProgress", userFraction: 0.1 }] } };
  const c = candidate("android", base, { firstLaunch: false, build: 72, storeBuildId: "72", countries: [],
    rollout: { kind: "update", mode: "staged", fraction: 0.1 } });
  const draft = classifyObservedProductionAction("submit", c.platform, c,
    { ...base, productionLifecycle: [{ name: "t1250 (72)", track: "production", versionCodes: ["72"],
      lifecycleState: "RELEASE_LIFECYCLE_STATE_DRAFT" }] }, "0".repeat(64));
  assert.equal(draft.matched, false);
  assert.match(draft.actionRequiredReason, /Send for review/u);
  const published = classifyObservedProductionAction("submit", c.platform, c,
    { ...base, productionLifecycle: [{ name: "t1250 (72)", track: "production", versionCodes: ["72"],
      lifecycleState: "RELEASE_LIFECYCLE_STATE_PUBLISHED" }] }, "0".repeat(64));
  assert.equal(published.matched, false);
  assert.match(published.actionRequiredReason, /before server health/u);
  assert.equal(productionOperationBlocksActivation({ platform: "android", action: "submit", status: "uncertain",
    receipt: { observed: published } }), true);
});

test("registry remote fixture persists an uncertain response and resolves it through the real CLI", () => {
  const directory = mkdtempSync(join(tmpdir(), "ash-atlas-production-registry-"));
  const file = join(directory, "registry.json");
  try {
    let registry = verifiedRegistry();
    writeFileSync(file, JSON.stringify(registry));
    const cli = (...args) => JSON.parse(execFileSync(process.execPath,
      ["tools/mobile-release/registry-remote.mjs", ...args, "--file", file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    const snapshot = { platform: "android", firstLaunch: true, productionTrack: { track: "production", releases: [] } };
    const release = registry.releases.find((entry) => entry.releaseId === "production-fixture" && entry.platform === "android");
    const c = candidate("android", snapshot);
    const request = { releaseId: release.releaseId, platform: "android", operationId: c.operationId,
      toolingApproval: c.toolingApproval, metadataHash, countries: c.countries, rollout: c.rollout,
      serverCompatibility: c.serverCompatibility, remoteBaseline: remoteBaselineFor("android", snapshot), preparedAt: c.preparedAt };
    assert.equal(cli("production-prepare", "--request", JSON.stringify(request)).production.platforms.android.phase, "prepared");
    const prepared = cli("production-status", "--platform", "android").production.candidate;
    const operationId = `${c.operationId}:submit`;
    assert.equal(cli("production-begin", "--request", JSON.stringify({ operationId, platform: "android", action: "submit",
      candidate: prepared, expectedBaselineFingerprint: null,
      expectedRemoteFingerprint: sha256Json(remoteBaselineFor("android", snapshot)) })).production.operations.find((entry) => entry.operationId === operationId).status, "pending");
    const journaled = cli("production-substep", "--operation-id", operationId, "--step", JSON.stringify({
      stepId: "google.track.update", status: "sent", requestFingerprint: "1".repeat(64), remoteId: "edit-1" }));
    assert.equal(journaled.production.operations.find((entry) => entry.operationId === operationId).substeps[0].status, "sent");
    assert.equal(cli("production-uncertain", "--operation-id", operationId, "--receipt", JSON.stringify({ schemaVersion: 1 })).production.operations.find((entry) => entry.operationId === operationId).status, "uncertain");
    assert.match(cliError(() => cli("production-reconcile", "--operation-id", "candidate:android:wrong", "--observed", JSON.stringify({ matched: true, terminal: true, published: true, authoritative: true }),
      "--receipt", JSON.stringify({ schemaVersion: 1 }))), /unknown production operation/u);
    const beforeRejectedObservation = readFileSync(file, "utf8");
    assert.match(cliError(() => cli("production-reconcile", "--operation-id", operationId, "--observed", JSON.stringify({
      ...publishedObservation(prepared, sha256Json(remoteBaselineFor("android", snapshot)), { candidateFingerprint: "0".repeat(64) }) }),
      "--receipt", JSON.stringify({ schemaVersion: 1 }))), /candidate identity/u);
    assert.equal(readFileSync(file, "utf8"), beforeRejectedObservation);
    const resolved = cli("production-reconcile", "--operation-id", operationId, "--observed", JSON.stringify({
      ...publishedObservation(prepared, sha256Json(remoteBaselineFor("android", snapshot)), { phase: "submitted" }) }),
      "--receipt", JSON.stringify({ schemaVersion: 1 }));
    assert.equal(resolved.production.operations.find((entry) => entry.operationId === operationId).status, "succeeded");
    const retryResolved = cli("production-reconcile", "--operation-id", operationId, "--observed", JSON.stringify({
      ...publishedObservation(prepared, sha256Json(remoteBaselineFor("android", snapshot)), { phase: "submitted" }) }),
      "--receipt", JSON.stringify({ schemaVersion: 1 }));
    assert.equal(retryResolved.production.operations.find((entry) => entry.operationId === operationId).status, "succeeded");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("production cancellation is a real CLI no-mutation proof before replacement", () => {
  const directory = mkdtempSync(join(tmpdir(), "ash-atlas-production-cancel-"));
  const file = join(directory, "registry.json");
  try {
    const registry = verifiedRegistry();
    writeFileSync(file, JSON.stringify(registry));
    const cli = (...args) => JSON.parse(execFileSync(process.execPath,
      ["tools/mobile-release/registry-remote.mjs", ...args, "--file", file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    const snapshot = { platform: "android", firstLaunch: true, productionTrack: { track: "production", releases: [] } };
    const release = registry.releases.find((entry) => entry.releaseId === "production-fixture" && entry.platform === "android");
    const c = candidate("android", snapshot);
    const request = { releaseId: release.releaseId, platform: "android", operationId: c.operationId,
      toolingApproval: c.toolingApproval, metadataHash, countries: c.countries, rollout: c.rollout,
      serverCompatibility: c.serverCompatibility, remoteBaseline: remoteBaselineFor("android", snapshot),
      publishedMasterSha, activationFenceFingerprint: null, preparedAt: c.preparedAt };
    const prepared = cli("production-prepare", "--request", JSON.stringify(request)).production.platforms.android.candidate;
    const cancellationRequest = { platform: "android",
      candidateFingerprint: productionCandidateFingerprint(prepared),
      remoteBaselineFingerprint: prepared.remoteBaselineFingerprint, reason: "operator rejected candidate" };
    const cancelled = cli("production-cancel", "--request", JSON.stringify(cancellationRequest));
    assert.equal(cancelled.production.platforms.android.candidate, null);
    const retried = cli("production-cancel", "--request", JSON.stringify(cancellationRequest));
    assert.equal(retried.production.cancellations.length, 1);
    const replacement = cli("production-prepare", "--request", JSON.stringify({ ...request,
      operationId: "candidate:android:replacement" }));
    assert.equal(replacement.production.platforms.android.candidate.operationId, "candidate:android:replacement");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("prepared identity binds the verified artifact, tooling, metadata, countries, and rollout", () => {
  const snapshot = { packageName: "com.ashatlas.game", firstLaunch: true, productionTrack: { track: "production", releases: [] } };
  const release = verifiedRegistry().releases.find((entry) => entry.releaseId === "production-fixture" && entry.platform === "android");
  const c = candidate("android", snapshot);
  assert.doesNotThrow(() => assertPreparedCandidateForTest(c, release));
  assert.throws(() => assertPreparedCandidateForTest(c, release, { toolSha: "0".repeat(40) }), /tooling identity/u);
  assert.throws(() => assertPreparedCandidate(c, release, { toolSha, metadataHash, countries: ["US"], rollout: c.rollout,
    sourceSha, generation: release.generation, releaseId: release.releaseId, publishedMasterSha: "0".repeat(40) }), /published master identity/u);
  assert.throws(() => assertPreparedCandidateForTest(c, { ...release, storeBuildId: "wrong" }), /exact verified release/u);
  assert.equal(productionCandidateFingerprint(c).length, 64);
});

test("actual prepare request binds release identity and preserves its approval receipt across workflow retries", () => {
  const directory = mkdtempSync(join(tmpdir(), "ash-atlas-production-prepare-builder-"));
  const packetPath = join(directory, "android-metadata.json");
  try {
    const release = verifiedRegistry().releases.find((entry) => entry.releaseId === "production-fixture" && entry.platform === "android");
    const snapshot = { packageName: "com.ashatlas.game", firstLaunch: true,
      productionTrack: { track: "production", releases: [] }, productionLifecycle: [] };
    const packet = { schemaVersion: 1, platform: "android", packageName: "com.ashatlas.game",
      marketingVersion: release.marketingVersion, localizations: [{ locale: "en-US", title: "Ash Atlas" }],
      policy: { countries: [], rollout: { kind: "first-publish", mode: "full" } } };
    const bytes = Buffer.from(`${JSON.stringify(packet)}\n`);
    writeFileSync(packetPath, bytes);
    const packetHash = createHash("sha256").update(bytes).digest("hex");
    const proof = { schemaVersion: 1, serverSha, serverProtocol: { min: 3, max: 3 },
      hardMinimum: { android: { version: "0.0.0", build: 0 } }, observedAt: "2026-09-21T00:00:00Z" };
    const env = { PRODUCTION_TOOL_SHA: toolSha, PRODUCTION_MASTER_SHA: publishedMasterSha,
      ANDROID_PRODUCTION_METADATA_PACKET_PATH: packetPath, ANDROID_PRODUCTION_METADATA_SHA256: packetHash,
      ANDROID_PRODUCTION_COUNTRIES: "", ANDROID_PRODUCTION_ROLLOUT: JSON.stringify(packet.policy.rollout),
      PRODUCTION_CANDIDATE_ID: "candidate:android:stable", GITHUB_ACTOR: "release-bot",
      GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "example/ash-atlas", GITHUB_RUN_ID: "101" };
    const first = withEnv(env, () => candidateRequest(release, "android", snapshot, proof, { fingerprint: null }));
    assert.equal(first.marketingVersion, release.marketingVersion);
    assert.equal(first.build, release.build);
    assert.equal(first.storeBuildId, release.storeBuildId);
    assert.equal(first.toolingApproval.receiptUrl, "https://github.com/example/ash-atlas/actions/runs/101");
    const second = withEnv({ ...env, GITHUB_RUN_ID: "202", PRODUCTION_MASTER_SHA: "1".repeat(40) }, () =>
      candidateRequest(release, "android", snapshot, proof, { fingerprint: null }, first));
    assert.deepEqual(second.toolingApproval, first.toolingApproval);
    assert.equal(second.toolingApproval.receiptUrl, "https://github.com/example/ash-atlas/actions/runs/101");
    assert.equal(second.publishedMasterSha, first.publishedMasterSha);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("prepared production identity survives a compatible published master advance", () => {
  const directory = mkdtempSync(join(tmpdir(), "ash-atlas-production-master-"));
  try {
    const git = (...args) => execFileSync("git", args, { cwd: directory, stdio: "ignore" });
    git("init", "--quiet");
    git("config", "user.name", "fixture");
    git("config", "user.email", "fixture@example.test");
    writeFileSync(join(directory, "state"), "M\n");
    git("add", "state");
    git("commit", "--quiet", "-m", "M");
    const preparedMaster = execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).trim();
    writeFileSync(join(directory, "state"), "M2\n");
    git("commit", "--quiet", "-am", "M2");
    const currentMaster = execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).trim();
    assert.doesNotThrow(() => assertPublishedMasterAncestry({ publishedMasterSha: preparedMaster }, currentMaster, directory));
    assert.throws(() => assertPublishedMasterAncestry({ publishedMasterSha: currentMaster }, preparedMaster, directory), /descendant|ancestry/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rollout transitions keep the artifact fixed while binding each target to its prior policy", () => {
  const snapshot = { packageName: "com.ashatlas.game", firstLaunch: false,
    productionTrack: { track: "production", releases: [{ name: "t1250 (72)", versionCodes: ["72"],
      status: "inProgress", userFraction: 0.1 }] }, productionLifecycle: [] };
  const c = candidate("android", snapshot, { firstLaunch: false, build: 72, storeBuildId: "72",
    rollout: { kind: "update", mode: "staged", fraction: 0.1 }, countries: [] });
  const target = { kind: "update", mode: "staged", fraction: 0.5 };
  const expectedRemoteFingerprint = sha256Json(remoteBaselineFor("android", snapshot));
  const payload = { schemaVersion: 1, operationId: "candidate:android:advance-50", action: "advance",
    artifactFingerprint: productionArtifactFingerprint(c), expectedRemoteFingerprint,
    expectedPriorPolicyFingerprint: expectedRemoteFingerprint, toRollout: target };
  const transition = buildProductionTransition(c, { ...payload,
    approvalFingerprint: sha256Json(payload) });
  const effective = applyProductionTransition(c, transition);
  assert.equal(effective.rollout.fraction, 0.5);
  assert.equal(effective.sourceSha, c.sourceSha);
  assert.equal(effective.artifactSha256, c.artifactSha256);
  assert.notEqual(transition.fingerprint, transition.approvalFingerprint);
});

test("rollout transitions can advance the same artifact from 10% to 50% to full", () => {
  const c = candidate("android", { packageName: "com.ashatlas.game", firstLaunch: false,
    productionTrack: { track: "production", releases: [{ name: "t1249 (70)", versionCodes: ["70"], status: "completed" }] },
    productionLifecycle: [] }, { firstLaunch: false, countries: [],
    rollout: { kind: "update", mode: "staged", fraction: 0.1 } });
  const remote10 = "1".repeat(64);
  const approval50 = sha256Json({ schemaVersion: 1, operationId: "advance-50", action: "advance",
    artifactFingerprint: productionArtifactFingerprint(c), expectedRemoteFingerprint: remote10,
    expectedPriorPolicyFingerprint: remote10, toRollout: { kind: "update", mode: "staged", fraction: 0.5 } });
  const transition50 = buildProductionTransition(c, { operationId: "advance-50", action: "advance",
    expectedRemoteFingerprint: remote10, toRollout: { kind: "update", mode: "staged", fraction: 0.5 },
    approvalFingerprint: approval50 });
  const candidate50 = applyProductionTransition(c, transition50);
  const remote50 = "2".repeat(64);
  const approvalFull = sha256Json({ schemaVersion: 1, operationId: "advance-full", action: "advance",
    artifactFingerprint: productionArtifactFingerprint(c), expectedRemoteFingerprint: remote50,
    expectedPriorPolicyFingerprint: remote50, toRollout: { kind: "update", mode: "full" } });
  const transitionFull = buildProductionTransition(c, { operationId: "advance-full", action: "advance",
    expectedRemoteFingerprint: remote50, toRollout: { kind: "update", mode: "full" },
    approvalFingerprint: approvalFull });
  const candidateFull = applyProductionTransition(c, transitionFull);
  assert.equal(candidate50.rollout.fraction, 0.5);
  assert.equal(candidateFull.rollout.mode, "full");
  assert.equal(productionArtifactFingerprint(candidate50), productionArtifactFingerprint(candidateFull));
  assert.equal(transitionFull.operationId, "advance-full");
});

test("approval mismatch causes zero writes and a terminal retry is read-only", async () => {
  const snapshot = { packageName: "com.ashatlas.game", firstLaunch: true, productionTrack: { track: "production", releases: [] } };
  let registry = verifiedRegistry();
  const release = registry.releases.find((entry) => entry.releaseId === "production-fixture" && entry.platform === "android");
  const c = candidate("android", snapshot);
  registry = prepareProductionCandidate(registry, { platform: "android", release, operationId: c.operationId,
    toolingApproval: c.toolingApproval, metadataHash, countries: c.countries, rollout: c.rollout,
    serverCompatibility: c.serverCompatibility, remoteBaseline: remoteBaselineFor("android", snapshot),
    publishedMasterSha, activationFenceFingerprint: null, preparedAt: c.preparedAt });
  const prepared = productionStatus(registry, "android").candidate;
  const expected = sha256Json(remoteBaselineFor("android", snapshot));
  registry = beginProductionOperation(registry, { operationId: "candidate:android:release", platform: "android", action: "release",
    candidate: prepared, expectedBaselineFingerprint: null, expectedRemoteFingerprint: expected });
  const pending = productionStatus(registry, "android").operations[0];
  registry = finishProductionOperation(registry, pending.operationId, { status: "succeeded", receipt: { schemaVersion: 1 },
    remote: publishedObservation(pending.candidate, pending.expectedRemoteFingerprint, { phase: "released" }) });
  const beforeRetry = JSON.stringify(registry);
  const retry = await runProductionAction({ action: "release", platform: "android", candidate: prepared,
    registry, operationId: pending.operationId, releaseApproved: false, clients: null, snapshot: null,
    serverProof: null });
  assert.equal(retry.skipped, true);
  assert.equal(JSON.stringify(retry.registry), beforeRetry);
  const candidateB = { ...prepared, countries: ["CA"] };
  await assert.rejects(() => runProductionAction({ action: "release", platform: "android", candidate: prepared,
    registry, operationId: "candidate:android:approved-b", releaseApproved: true,
    approvalFingerprint: productionCandidateFingerprint(candidateB), clients: null, snapshot: null, serverProof: null }),
  /approval is not bound/u);
  assert.equal(JSON.stringify(registry), beforeRetry);
});

test("prepare is stable and cancellation permits a proven no-mutation replacement", () => {
  const snapshot = { packageName: "com.ashatlas.game", firstLaunch: true, productionTrack: { track: "production", releases: [] } };
  const release = verifiedRegistry().releases.find((entry) => entry.releaseId === "production-fixture" && entry.platform === "android");
  const c = candidate("android", snapshot);
  let registry = verifiedRegistry();
  const request = { platform: "android", release, operationId: c.operationId, toolingApproval: c.toolingApproval,
    metadataHash, countries: c.countries, rollout: c.rollout, serverCompatibility: c.serverCompatibility,
    remoteBaseline: remoteBaselineFor("android", snapshot), publishedMasterSha, activationFenceFingerprint: null,
    preparedAt: c.preparedAt };
  registry = prepareProductionCandidate(registry, request);
  const first = productionStatus(registry, "android").candidate;
  registry = prepareProductionCandidate(registry, { ...request, preparedAt: "2026-09-21T01:00:00Z",
    toolingApproval: { ...request.toolingApproval, approvedAt: "2026-09-21T01:00:00Z" } });
  assert.deepEqual(productionStatus(registry, "android").candidate, first);
  registry = cancelProductionCandidate(registry, { platform: "android", candidateFingerprint: productionCandidateFingerprint(first),
    remoteBaselineFingerprint: first.remoteBaselineFingerprint, reason: "operator rejected candidate" });
  const replacement = { ...request, operationId: "candidate:android:replacement", preparedAt: "2026-09-21T01:01:00Z" };
  registry = prepareProductionCandidate(registry, replacement);
  assert.equal(productionStatus(registry, "android").candidate.operationId, replacement.operationId);
});

test("submit review completion and release use separate fresh transition snapshots", () => {
  const before = { packageName: "com.ashatlas.game", firstLaunch: true, productionTrack: { track: "production", releases: [] } };
  const afterSubmit = { packageName: "com.ashatlas.game", firstLaunch: false,
    productionTrack: { track: "production", releases: [{ name: "t1250 (72)", versionCodes: ["72"], status: "draft" }] } };
  let registry = verifiedRegistry();
  const release = registry.releases.find((entry) => entry.releaseId === "production-fixture" && entry.platform === "android");
  const c = candidate("android", before, { firstLaunch: true });
  registry = prepareProductionCandidate(registry, { platform: "android", release, operationId: c.operationId,
    toolingApproval: c.toolingApproval, metadataHash, countries: c.countries, rollout: c.rollout,
    serverCompatibility: c.serverCompatibility, remoteBaseline: remoteBaselineFor("android", before),
    publishedMasterSha, activationFenceFingerprint: null, preparedAt: c.preparedAt });
  const prepared = productionStatus(registry, "android").candidate;
  const submitExpected = sha256Json(remoteBaselineFor("android", before));
  registry = beginProductionOperation(registry, { operationId: "candidate:android:submit", platform: "android", action: "submit",
    candidate: prepared, expectedBaselineFingerprint: null, expectedRemoteFingerprint: submitExpected });
  const submitOperation = productionStatus(registry, "android").operations[0];
  registry = finishProductionOperation(registry, "candidate:android:submit", { status: "succeeded", receipt: { schemaVersion: 1 },
    remote: publishedObservation(submitOperation.candidate, submitOperation.expectedRemoteFingerprint, { phase: "submitted" }) });
  const releaseExpected = sha256Json(remoteBaselineFor("android", afterSubmit));
  registry = beginProductionOperation(registry, { operationId: "candidate:android:release", platform: "android", action: "release",
    candidate: prepared, expectedBaselineFingerprint: null, expectedRemoteFingerprint: releaseExpected });
  const releaseOperation = productionStatus(registry, "android").operations.find((operation) => operation.operationId === "candidate:android:release");
  registry = finishProductionOperation(registry, "candidate:android:release", { status: "succeeded", receipt: { schemaVersion: 1 },
    remote: publishedObservation(releaseOperation.candidate, releaseOperation.expectedRemoteFingerprint, { phase: "released" }) });
  assert.equal(productionStatus(registry, "android").baseline.storeBuildId, prepared.storeBuildId);
});

test("failed retries require a new journal operation and activation CAS fencing", () => {
  const snapshot = { packageName: "com.ashatlas.game", firstLaunch: true, productionTrack: { track: "production", releases: [] } };
  let registry = verifiedRegistry();
  const release = registry.releases.find((entry) => entry.releaseId === "production-fixture" && entry.platform === "android");
  const c = candidate("android", snapshot);
  registry = prepareProductionCandidate(registry, { platform: "android", release, operationId: c.operationId,
    toolingApproval: c.toolingApproval, metadataHash, countries: c.countries, rollout: c.rollout,
    serverCompatibility: c.serverCompatibility, remoteBaseline: remoteBaselineFor("android", snapshot),
    publishedMasterSha, activationFenceFingerprint: null, preparedAt: c.preparedAt });
  const prepared = productionStatus(registry, "android").candidate;
  const expected = sha256Json(remoteBaselineFor("android", snapshot));
  registry = beginProductionOperation(registry, { operationId: "candidate:android:failed", platform: "android", action: "submit",
    candidate: prepared, expectedBaselineFingerprint: null, expectedRemoteFingerprint: expected });
  const failedOperation = productionStatus(registry, "android").operations[0];
  registry = finishProductionOperation(registry, "candidate:android:failed", { status: "failed", receipt: { schemaVersion: 1 },
    remote: noMutationObservation(failedOperation.candidate, failedOperation.expectedRemoteFingerprint) });
  assert.throws(() => beginProductionOperation(registry, { operationId: "candidate:android:failed", platform: "android", action: "submit",
    candidate: prepared, expectedBaselineFingerprint: null, expectedRemoteFingerprint: expected }), /new operation ID/u);
  registry = setActivationIntent(registry, { schemaVersion: 1, intentId: "activation-race", serverSha, candidateComponentSha: sourceSha,
    preparedReceiptSha: metadataHash, preSwitchEnvSha: metadataHash, serverProtocol: { min: 3, max: 3 },
    hardMinimum: { ios: { version: "0.0.0", build: 0 }, android: { version: "0.0.0", build: 0 } }, createdAt: "2026-09-21T00:00:00Z" });
  assert.throws(() => beginProductionOperation(registry, { operationId: "candidate:android:new-attempt", platform: "android", action: "submit",
    candidate: prepared, expectedBaselineFingerprint: null, expectedRemoteFingerprint: expected, expectedActivationFingerprint: null }), /activation intent changed/u);
});

test("activation and production mutation acquisition are mutually exclusive in both orders", () => {
  const directory = mkdtempSync(join(tmpdir(), "ash-atlas-production-cas-"));
  const file = join(directory, "registry.json");
  const intent = { schemaVersion: 1, intentId: "activation-cas-fixture", serverSha, candidateComponentSha: sourceSha,
    preparedReceiptSha: metadataHash, preSwitchEnvSha: metadataHash, serverProtocol: { min: 3, max: 3 },
    hardMinimum: { ios: { version: "0.0.0", build: 0 }, android: { version: "0.0.0", build: 0 } },
    createdAt: "2026-09-21T00:00:00Z" };
  try {
    const snapshot = { packageName: "com.ashatlas.game", firstLaunch: true,
      productionTrack: { track: "production", releases: [] } };
    const release = verifiedRegistry().releases.find((entry) => entry.releaseId === "production-fixture" && entry.platform === "android");
    const c = candidate("android", snapshot);
    let preparedRegistry = prepareProductionCandidate(verifiedRegistry(), { platform: "android", release,
      operationId: c.operationId, toolingApproval: c.toolingApproval, metadataHash, countries: c.countries,
      rollout: c.rollout, serverCompatibility: c.serverCompatibility, remoteBaseline: remoteBaselineFor("android", snapshot),
      publishedMasterSha, activationFenceFingerprint: null, preparedAt: c.preparedAt });
    const prepared = productionStatus(preparedRegistry, "android").candidate;
    const request = { operationId: "candidate:android:cas", platform: "android", action: "submit", candidate: prepared,
      expectedBaselineFingerprint: null, expectedRemoteFingerprint: sha256Json(remoteBaselineFor("android", snapshot)),
      expectedActivationFingerprint: null };
    preparedRegistry = beginProductionOperation(preparedRegistry, request);
    writeFileSync(file, JSON.stringify(preparedRegistry));
    const cli = (...args) => execFileSync(process.execPath,
      ["tools/mobile-release/registry-remote.mjs", ...args, "--file", file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.throws(() => cli("set-activation-intent", "--intent", JSON.stringify(intent)), /production mutation is unresolved/u);
    writeFileSync(file, JSON.stringify(setActivationIntent(preparedRegistry, intent)));
    assert.throws(() => cli("production-begin", "--request", JSON.stringify(request)), /blocked by activation intent/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("confirmed submit assignment releases the short activation mutex but keeps the candidate unbaselined", () => {
  const directory = mkdtempSync(join(tmpdir(), "ash-atlas-production-review-fence-"));
  const file = join(directory, "registry.json");
  const intent = { schemaVersion: 1, intentId: "activation-review-fence", serverSha, candidateComponentSha: sourceSha,
    preparedReceiptSha: metadataHash, preSwitchEnvSha: metadataHash, serverProtocol: { min: 3, max: 3 },
    hardMinimum: { ios: { version: "0.0.0", build: 0 }, android: { version: "0.0.0", build: 0 } },
    createdAt: "2026-09-21T00:00:00Z" };
  try {
    const snapshot = { bundleId: "com.ashatlas.game", firstLaunch: true, versions: [], builds: [] };
    let registry = verifiedRegistry(["ios"]);
    const release = registry.releases.find((entry) => entry.releaseId === "production-fixture" && entry.platform === "ios");
    const c = candidate("ios", snapshot, { firstLaunch: true, countries: [],
      rollout: { kind: "first-publish", mode: "manual" } });
    registry = prepareProductionCandidate(registry, { platform: "ios", release, operationId: c.operationId,
      toolingApproval: c.toolingApproval, metadataHash, countries: [], rollout: c.rollout,
      serverCompatibility: c.serverCompatibility, remoteBaseline: remoteBaselineFor("ios", snapshot),
      publishedMasterSha, activationFenceFingerprint: null, preparedAt: c.preparedAt });
    registry = beginProductionOperation(registry, { operationId: "candidate:ios:submit-review", platform: "ios", action: "submit",
      candidate: productionStatus(registry, "ios").candidate, expectedBaselineFingerprint: null,
      expectedRemoteFingerprint: sha256Json(remoteBaselineFor("ios", snapshot)) });
    const operation = productionStatus(registry, "ios").operations[0];
    const observed = { candidateFingerprint: productionCandidateFingerprint(operation.candidate),
      expectedRemoteFingerprint: operation.expectedRemoteFingerprint, matched: false, partial: true,
      terminal: false, mutation: true, available: false, published: false, authoritative: true,
      phase: "submitted", currentRemoteFingerprint: "2".repeat(64), completedSubsteps: [] };
    registry = reconcileProductionOperation(registry, operation.operationId, { observed,
      receipt: { schemaVersion: 1, operationId: operation.operationId, observed } });
    const reconciled = productionStatus(registry, "ios").operations[0];
    assert.equal(productionOperationBlocksActivation(reconciled), false);
    assert.equal(productionStatus(registry, "ios").baseline, null);
    writeFileSync(file, JSON.stringify(registry));
    const cli = (...args) => JSON.parse(execFileSync(process.execPath,
      ["tools/mobile-release/registry-remote.mjs", ...args, "--file", file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    const result = cli("set-activation-intent", "--intent", JSON.stringify(intent));
    assert.equal(result.activationIntent.intentId, intent.intentId);
    const status = cli("production-status", "--platform", "ios");
    assert.equal(status.production.candidate.storeBuildId, c.storeBuildId);
    assert.equal(status.production.baseline, null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Apple submit uses the current review-submission API and never the retired endpoint", async () => {
  const snapshot = { bundleId: "com.ashatlas.game", appId: "app-1", firstLaunch: true,
    builds: [{ id: "ios-build-22", version: "22", processingState: "VALID", expired: false, audience: "APP_STORE_ELIGIBLE" }],
    versions: [{ id: "version-2", versionString: "1.2.0", state: "READY_FOR_REVIEW", releaseType: "MANUAL",
      buildId: null, phasedReleaseId: null }], reviewSubmissions: [] };
  const c = candidate("ios", snapshot, { countries: [], firstLaunch: true,
    rollout: { kind: "first-publish", mode: "manual" }, storeBuildId: "ios-build-22", build: 22 });
  const calls = [];
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "PATCH" && path.endsWith("/relationships/build")) return {};
    if (method === "POST" && path === "/v1/reviewSubmissions") return { data: { id: "submission-1", type: "reviewSubmissions", attributes: { state: "READY_FOR_REVIEW" } } };
    if (method === "POST" && path === "/v1/reviewSubmissionItems") return { data: { id: "item-1", type: "reviewSubmissionItems" } };
    if (method === "PATCH" && path === "/v1/reviewSubmissions/submission-1") return { data: { id: "submission-1", attributes: { state: "WAITING_FOR_REVIEW" } } };
    throw new Error(`unexpected Apple request ${method} ${path}`);
  };
  const result = await submitAppleProduction(api, snapshot, c);
  assert.equal(result.submissionId, "submission-1");
  assert.deepEqual(calls.map(({ method, path }) => `${method} ${path}`), [
    "PATCH /v1/appStoreVersions/version-2/relationships/build",
    "POST /v1/reviewSubmissions",
    "POST /v1/reviewSubmissionItems",
    "PATCH /v1/reviewSubmissions/submission-1"
  ]);
  assert.ok(calls.every(({ path }) => !path.includes("appStoreVersionSubmissions")));
  assert.deepEqual(calls[1].body.data.relationships.app.data, { type: "apps", id: "app-1" });
  assert.deepEqual(calls[2].body.data.relationships.appStoreVersion.data, { type: "appStoreVersions", id: "version-2" });
  assert.equal(calls[3].body.data.attributes.submitted, true);
});

test("Apple rejected review submissions recover with a new submission identity", async () => {
  const snapshot = { bundleId: "com.ashatlas.game", appId: "app-1", firstLaunch: true,
    builds: [{ id: "ios-build-22", version: "22", processingState: "VALID", expired: false, audience: "APP_STORE_ELIGIBLE" }],
    versions: [{ id: "version-2", versionString: "1.2.0", state: "READY_FOR_REVIEW", releaseType: "MANUAL",
      buildId: "ios-build-22", phasedReleaseId: null }],
    reviewSubmissions: [{ id: "rejected-1", versionId: "version-2", state: "REJECTED", itemId: "old-item" }] };
  const calls = [];
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "POST" && path === "/v1/reviewSubmissions") return { data: { id: "submission-2", attributes: { state: "READY_FOR_REVIEW" } } };
    if (method === "POST" && path === "/v1/reviewSubmissionItems") return { data: { id: "item-2" } };
    if (method === "PATCH" && path.endsWith("/submission-2")) return { data: { id: "submission-2", attributes: { state: "WAITING_FOR_REVIEW" } } };
    throw new Error(`unexpected rejected-review request ${method} ${path}`);
  };
  const result = await submitAppleProduction(api, snapshot, candidate("ios", snapshot, { countries: [], firstLaunch: true,
    rollout: { kind: "first-publish", mode: "manual" }, storeBuildId: "ios-build-22", build: 22 }));
  assert.equal(result.submissionId, "submission-2");
  assert.deepEqual(calls.map(({ method, path }) => `${method} ${path}`), [
    "POST /v1/reviewSubmissions", "POST /v1/reviewSubmissionItems", "PATCH /v1/reviewSubmissions/submission-2"
  ]);
  assert.equal(calls[1].body.data.relationships.reviewSubmission.data.id, "submission-2");
});

test("Apple snapshot derives first launch from published history and reads real phase and review state", async () => {
  const api = async (method, path) => {
    if (path.startsWith("/v1/apps?") && method === "GET") return { data: [{ id: "app-1", attributes: { bundleId: "com.ashatlas.game" } }] };
    if (path.startsWith("/v1/builds?") && method === "GET") return { data: [{ id: "ios-build-2", attributes: {
      version: "2", processingState: "VALID", expired: false, buildAudienceType: "APP_STORE_ELIGIBLE" } }] };
    if (path.includes("/appStoreVersions?") && method === "GET") return { data: [{ id: "version-2", attributes: {
      versionString: "1.2.0", appVersionState: "PENDING_DEVELOPER_RELEASE", releaseType: "MANUAL" },
      relationships: { build: { data: { type: "builds", id: "ios-build-2" } },
        appStoreVersionPhasedRelease: { data: { type: "appStoreVersionPhasedReleases", id: "phase-1" } } } }] };
    if (path.includes("/reviewSubmissions?") && method === "GET") return { data: [{ id: "submission-1", attributes: { state: "WAITING_FOR_REVIEW" },
      relationships: { appStoreVersionForReview: { data: { type: "appStoreVersions", id: "version-2" } } } }] };
    if (path === "/v1/appStoreVersionPhasedReleases/phase-1" && method === "GET") return { data: {
      id: "phase-1", attributes: { phasedReleaseState: "ACTIVE" } } };
    throw new Error(`unexpected Apple snapshot request ${method} ${path}`);
  };
  const snapshot = await productionAppleSnapshot(api);
  assert.equal(snapshot.firstLaunch, true);
  assert.equal(snapshot.versions[0].phasedReleaseState, "ACTIVE");
  assert.equal(snapshot.versions[0].reviewSubmissionState, "WAITING_FOR_REVIEW");
  assert.equal(snapshot.versions[0].published, false);
});

test("Apple current wire states treat READY_FOR_DISTRIBUTION and COMPLETE as published and approved", async () => {
  const api = async (method, path) => {
    if (path.startsWith("/v1/apps?") && method === "GET") return { data: [{ id: "app-1", attributes: { bundleId: "com.ashatlas.game" } }] };
    if (path.startsWith("/v1/builds?") && method === "GET") return { data: [{ id: "ios-build-2", attributes: {
      version: "2", processingState: "VALID", expired: false, buildAudienceType: "APP_STORE_ELIGIBLE" } }] };
    if (path.includes("/appStoreVersions?") && method === "GET") return { data: [{ id: "version-2", attributes: {
      versionString: "1.2.0", appVersionState: "READY_FOR_DISTRIBUTION", releaseType: "MANUAL" },
      relationships: { build: { data: { type: "builds", id: "ios-build-2" } } } }] };
    if (path.includes("/reviewSubmissions?") && method === "GET") return { data: [{ id: "submission-1", attributes: { state: "COMPLETE" },
      relationships: { items: { data: [{ type: "reviewSubmissionItems", id: "item-1" }] } } }], included: [
      { type: "reviewSubmissionItems", id: "item-1", relationships: {
        appStoreVersion: { data: { type: "appStoreVersions", id: "version-2" } }
      } }
    ] };
    throw new Error(`unexpected Apple current-state request ${method} ${path}`);
  };
  const snapshot = await productionAppleSnapshot(api);
  assert.equal(snapshot.firstLaunch, false);
  assert.equal(snapshot.versions[0].published, true);
  assert.equal(snapshot.versions[0].reviewSubmissionState, "COMPLETE");
  assert.equal(snapshot.reviewSubmissions[0].itemId, "item-1");
});

test("Apple real runner resumes from review approval into manual availability", async () => {
  const appleState = {
    app: { id: "app-1", attributes: { bundleId: "com.ashatlas.game" } },
    builds: [{ id: "ios-22", attributes: { version: "22", processingState: "VALID", expired: false,
      buildAudienceType: "APP_STORE_ELIGIBLE" } }], versions: [], submissions: [], nextId: 1
  };
  const api = async (method, path, body) => {
    if (method === "GET" && path.startsWith("/v1/apps?")) return { data: [appleState.app] };
    if (method === "GET" && path.startsWith("/v1/builds?")) return { data: appleState.builds };
    if (method === "GET" && path.includes("/appStoreVersions?")) return { data: appleState.versions };
    if (method === "GET" && path.includes("/reviewSubmissions?")) return { data: appleState.submissions };
    if (method === "GET" && path.startsWith("/v1/appStoreVersionPhasedReleases/")) throw new Error("unexpected phased read");
    if (method === "POST" && path === "/v1/appStoreVersions") {
      const version = { id: `version-${appleState.nextId++}`, type: "appStoreVersions",
        attributes: { versionString: body.data.attributes.versionString, appVersionState: "READY_FOR_REVIEW",
          releaseType: body.data.attributes.releaseType }, relationships: { build: { data: null } } };
      appleState.versions.push(version);
      return { data: version };
    }
    if (method === "PATCH" && /\/v1\/appStoreVersions\/[^/]+\/relationships\/build$/u.test(path)) {
      const version = appleState.versions.find((entry) => path.includes(entry.id));
      version.relationships.build = { data: body.data };
      return { data: version };
    }
    if (method === "POST" && path === "/v1/reviewSubmissions") {
      const submission = { id: `submission-${appleState.nextId++}`, type: "reviewSubmissions",
        attributes: { state: "READY_FOR_REVIEW" }, relationships: { items: { data: [] } } };
      appleState.submissions.push(submission);
      return { data: submission };
    }
    if (method === "POST" && path === "/v1/reviewSubmissionItems") {
      const submission = appleState.submissions.find((entry) => entry.id === body.data.relationships.reviewSubmission.data.id);
      const item = { id: `item-${appleState.nextId++}`, type: "reviewSubmissionItems",
        relationships: { appStoreVersion: { data: body.data.relationships.appStoreVersion.data } } };
      submission.relationships.items.data.push(item);
      return { data: item };
    }
    if (method === "PATCH" && /\/v1\/reviewSubmissions\/[^/]+$/u.test(path)) {
      const submission = appleState.submissions.find((entry) => path.endsWith(entry.id));
      submission.attributes.state = "WAITING_FOR_REVIEW";
      return { data: submission };
    }
    if (method === "POST" && path === "/v1/appStoreVersionReleaseRequests") {
      const versionId = body.data.relationships.appStoreVersion.data.id;
      const version = appleState.versions.find((entry) => entry.id === versionId);
      version.attributes.appVersionState = "READY_FOR_DISTRIBUTION";
      return { data: { id: "release-request-1" } };
    }
    throw new Error(`unexpected Apple runner request ${method} ${path}`);
  };
  const initialSnapshot = await productionAppleSnapshot(api);
  const c = candidate("ios", initialSnapshot, { countries: [], rollout: { kind: "first-publish", mode: "manual" } });
  const release = verifiedRegistry(["ios"]).releases.find((entry) => entry.releaseId === c.releaseId && entry.platform === "ios");
  let registry = prepareProductionCandidate(verifiedRegistry(["ios"]), { platform: "ios", release,
    operationId: c.operationId, toolingApproval: c.toolingApproval, metadataHash, countries: [], rollout: c.rollout,
    serverCompatibility: c.serverCompatibility, remoteBaseline: remoteBaselineFor("ios", initialSnapshot),
    publishedMasterSha, activationFenceFingerprint: null, preparedAt: c.preparedAt });
  const prepared = productionStatus(registry, "ios").candidate;
  const submitted = await runProductionAction({ action: "submit", platform: "ios", candidate: prepared,
    registry, operationId: "candidate:ios:submit", clients: { apple: api }, snapshot: initialSnapshot,
    serverProof: prepared.serverCompatibility, expectedRemoteFingerprint: prepared.remoteBaselineFingerprint });
  registry = submitted.registry;
  appleState.versions[0].attributes.appVersionState = "PENDING_DEVELOPER_RELEASE";
  appleState.submissions[0].attributes.state = "COMPLETE";
  const afterApproval = await productionAppleSnapshot(api);
  const releaseCandidate = productionStatus(registry, "ios").candidate;
  const released = await runProductionAction({ action: "release", platform: "ios", candidate: releaseCandidate,
    registry, operationId: "candidate:ios:release", clients: { apple: api }, snapshot: afterApproval,
    serverProof: releaseCandidate.serverCompatibility, releaseApproved: true,
    approvalFingerprint: productionCandidateFingerprint(releaseCandidate),
    expectedRemoteFingerprint: sha256Json(remoteBaselineFor("ios", afterApproval)) });
  assert.equal(productionStatus(released.registry, "ios").baseline.storeBuildId, releaseCandidate.storeBuildId);
  assert.equal(appleState.versions[0].attributes.appVersionState, "READY_FOR_DISTRIBUTION");
});

test("Apple first publication verifies a pre-provisioned manual shell before attaching the exact build", async () => {
  const snapshot = { bundleId: "com.ashatlas.game", appId: "app-1", firstLaunch: true,
    builds: [{ id: "ios-build-22", version: "22", processingState: "VALID", expired: false, audience: "APP_STORE_ELIGIBLE" }],
    versions: [{ id: "version-2", versionString: "1.2.0", state: "READY_FOR_REVIEW", releaseType: "MANUAL",
      buildId: null, phasedReleaseId: null }], reviewSubmissions: [] };
  const c = candidate("ios", snapshot, { firstLaunch: true, countries: [], storeBuildId: "ios-build-22", build: 22,
    rollout: { kind: "first-publish", mode: "manual" } });
  const packet = { schemaVersion: 1, platform: "ios", bundleId: "com.ashatlas.game", marketingVersion: "1.2.0",
    localizations: [{ locale: "en-US", name: "Ash Atlas", subtitle: "Explore." }],
    policy: { countries: [], rollout: c.rollout }, build: 22, storeBuildId: "ios-build-22" };
  const calls = [];
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "GET" && path.includes("appStoreVersionLocalizations")) {
      return { data: [{ attributes: { locale: "en-US", name: "Ash Atlas", subtitle: "Explore." } }] };
    }
    if (method === "PATCH" && path.endsWith("/relationships/build")) return { data: {} };
    if (method === "POST" && path === "/v1/reviewSubmissions") return { data: { id: "submission-1", attributes: { state: "READY_FOR_REVIEW" } } };
    if (method === "POST" && path === "/v1/reviewSubmissionItems") return { data: { id: "item-1" } };
    if (method === "PATCH" && path.endsWith("/submission-1")) return { data: { id: "submission-1" } };
    if (method === "POST" && path === "/v1/appStoreVersionReleaseRequests") return { data: { id: "release-1" } };
    throw new Error(`unexpected first-publication request ${method} ${path}`);
  };
  const submitted = await submitAppleProduction(api, snapshot, c, packet);
  assert.equal(submitted.versionId, "version-2");
  assert.deepEqual(calls.map(({ method, path }) => `${method} ${path}`), [
    "GET /v1/appStoreVersions/version-2/appStoreVersionLocalizations?limit=200",
    "PATCH /v1/appStoreVersions/version-2/relationships/build",
    "POST /v1/reviewSubmissions", "POST /v1/reviewSubmissionItems", "PATCH /v1/reviewSubmissions/submission-1"
  ]);
  assert.equal(calls.some(({ method, path }) => method === "POST" && path === "/v1/appStoreVersions"), false);
  const releaseSnapshot = { ...snapshot,
    versions: [{ ...snapshot.versions[0], buildId: "ios-build-22", state: "PENDING_DEVELOPER_RELEASE" }] };
  const beforeReleaseCalls = calls.length;
  await releaseAppleProduction(api, releaseSnapshot, c, packet);
  assert.equal(calls[beforeReleaseCalls].path.includes("appStoreVersionLocalizations"), true);
  assert.equal(calls.at(-1).path, "/v1/appStoreVersionReleaseRequests");
});

test("Apple first publication creates a fresh version before verifying metadata", async () => {
  const snapshot = { bundleId: "com.ashatlas.game", appId: "app-1", firstLaunch: true,
    builds: [{ id: "ios-build-22", version: "22", processingState: "VALID", expired: false, audience: "APP_STORE_ELIGIBLE" }],
    versions: [], reviewSubmissions: [] };
  const c = candidate("ios", snapshot, { firstLaunch: true, countries: [], storeBuildId: "ios-build-22", build: 22,
    rollout: { kind: "first-publish", mode: "manual" } });
  const packet = { schemaVersion: 1, platform: "ios", bundleId: "com.ashatlas.game", marketingVersion: "1.2.0",
    localizations: [{ locale: "en-US", name: "Ash Atlas", subtitle: "Explore." }],
    policy: { countries: [], rollout: c.rollout }, build: 22, storeBuildId: "ios-build-22" };
  const calls = [];
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "POST" && path === "/v1/appStoreVersions") {
      return { data: { id: "version-new", attributes: { versionString: "1.2.0", appVersionState: "READY_FOR_REVIEW", releaseType: "MANUAL" },
        relationships: { build: { data: null } } } };
    }
    if (method === "GET" && path === "/v1/appStoreVersions/version-new/appStoreVersionLocalizations?limit=200") {
      return { data: [{ attributes: { locale: "en-US", name: "Ash Atlas", subtitle: "Explore." } }] };
    }
    if (method === "PATCH" && path.endsWith("/relationships/build")) return { data: {} };
    if (method === "POST" && path === "/v1/reviewSubmissions") return { data: { id: "submission-new", attributes: { state: "READY_FOR_REVIEW" } } };
    if (method === "POST" && path === "/v1/reviewSubmissionItems") return { data: { id: "item-new" } };
    if (method === "PATCH" && path === "/v1/reviewSubmissions/submission-new") return { data: { id: "submission-new" } };
    throw new Error(`unexpected fresh-version request ${method} ${path}`);
  };
  const result = await submitAppleProduction(api, snapshot, c, packet);
  assert.equal(result.versionId, "version-new");
  assert.equal(calls[0].path, "/v1/appStoreVersions");
  assert.equal(calls[1].path, "/v1/appStoreVersions/version-new/appStoreVersionLocalizations?limit=200");
  assert.equal(calls[2].path, "/v1/appStoreVersions/version-new/relationships/build");
});

test("Apple retries adopt a recovered version shell after a lost create response", async () => {
  const base = { bundleId: "com.ashatlas.game", appId: "app-1", firstLaunch: true,
    builds: [{ id: "ios-build-22", version: "22", processingState: "VALID", expired: false, audience: "APP_STORE_ELIGIBLE" }],
    versions: [], reviewSubmissions: [] };
  const c = candidate("ios", base, { firstLaunch: true, countries: [], storeBuildId: "ios-build-22", build: 22,
    rollout: { kind: "first-publish", mode: "manual" } });
  const journal = new Map();
  const context = {
    assertSubstepWritable(stepId, requestFingerprint) {
      const prior = journal.get(stepId);
      if (prior) {
        assert.equal(prior.requestFingerprint, requestFingerprint);
        assert.ok(!["sent", "uncertain"].includes(prior.status));
      }
    },
    recordSubstep(step) { journal.set(step.stepId, { ...journal.get(step.stepId), ...step }); }
  };
  const version = { id: "version-2", versionString: "1.2.0", state: "READY_FOR_REVIEW", releaseType: "MANUAL",
    buildId: null, phasedReleaseId: null };
  const calls = [];
  let firstAttempt = true;
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "POST" && path === "/v1/appStoreVersions") {
      firstAttempt = false;
      throw Object.assign(new Error("create response lost"), { remoteCreated: true });
    }
    if (method === "PATCH" && path.endsWith("/relationships/build")) return { data: {} };
    if (method === "POST" && path === "/v1/reviewSubmissions") return { data: { id: "submission-1" } };
    if (method === "POST" && path === "/v1/reviewSubmissionItems") return { data: { id: "item-1" } };
    if (method === "PATCH" && path.endsWith("/submission-1")) return { data: { id: "submission-1" } };
    throw new Error(`unexpected recovered-shell request ${method} ${path}`);
  };
  await assert.rejects(() => submitAppleProduction(api, base, c, null, context), /create response lost/u);
  assert.equal(journal.get("apple.version.create")?.status, "uncertain");
  const recovered = { ...base, versions: [version] };
  const result = await submitAppleProduction(api, recovered, c, null, context);
  assert.equal(result.versionId, "version-2");
  assert.equal(firstAttempt, false);
  assert.equal(calls.filter(({ method, path }) => method === "POST" && path === "/v1/appStoreVersions").length, 1);
  assert.equal(journal.get("apple.version.build")?.status, "acknowledged");
});

test("Apple runner adopts an explicitly approved detached review shell after response loss", async () => {
  const state = { review: null, item: null, calls: [], loseReviewCreate: true };
  const versionWire = () => ({ type: "appStoreVersions", id: "version-2", attributes: {
    versionString: "1.2.0", appVersionState: "READY_FOR_REVIEW", releaseType: "MANUAL"
  }, relationships: { build: { data: { type: "builds", id: "ios-build-22" } } } });
  const api = async (method, path, body) => {
    state.calls.push({ method, path, body });
    if (method === "GET" && path.includes("/v1/apps?")) return { data: [{ id: "app-1", attributes: { bundleId: "com.ashatlas.game" } }] };
    if (method === "GET" && path.includes("/v1/builds?")) return { data: [{ type: "builds", id: "ios-build-22", attributes: {
      version: "22", processingState: "VALID", expired: false, buildAudienceType: "APP_STORE_ELIGIBLE"
    } }] };
    if (method === "GET" && path.includes("/v1/apps/app-1/appStoreVersions?")) return { data: [versionWire()] };
    if (method === "GET" && path.includes("/v1/apps/app-1/reviewSubmissions?")) {
      return { data: state.review ? [{ ...state.review, relationships: {
        ...(state.review.relationships ?? {}),
        items: { data: state.item ? [{ type: "reviewSubmissionItems", id: state.item.id }] : [] }
      } }] : [], included: state.item ? [{ ...state.item }] : [] };
    }
    if (method === "GET" && path === "/v1/reviewSubmissions/submission-1?include=appStoreVersionForReview,items") {
      return { data: state.review ? { ...state.review, relationships: {
        ...(state.review.relationships ?? {}),
        items: { data: state.item ? [{ type: "reviewSubmissionItems", id: state.item.id }] : [] }
      } } : null, included: state.item ? [{ ...state.item }] : [] };
    }
    if (method === "POST" && path === "/v1/reviewSubmissions") {
      state.review = { type: "reviewSubmissions", id: "submission-1", attributes: { state: "READY_FOR_REVIEW" },
        relationships: { app: { data: { type: "apps", id: "app-1" } } } };
      if (state.loseReviewCreate) {
        state.loseReviewCreate = false;
        throw new Error("review shell response lost");
      }
      return { data: state.review };
    }
    if (method === "POST" && path === "/v1/reviewSubmissionItems") {
      state.item = { type: "reviewSubmissionItems", id: "item-1", relationships: {
        appStoreVersion: { data: { type: "appStoreVersions", id: "version-2" } }
      } };
      return { data: { id: state.item.id } };
    }
    if (method === "PATCH" && path === "/v1/reviewSubmissions/submission-1") {
      state.review.attributes.state = "COMPLETE";
      return { data: state.review };
    }
    throw new Error(`unexpected Apple review-shell runner request ${method} ${path}`);
  };
  const initialSnapshot = await productionAppleSnapshot(api);
  const c = candidate("ios", initialSnapshot, { countries: [], firstLaunch: true,
    storeBuildId: "ios-build-22", build: 22, rollout: { kind: "first-publish", mode: "manual" } });
  const release = { ...verifiedRegistry(["ios"]).releases.find((entry) => entry.releaseId === c.releaseId && entry.platform === "ios"),
    storeBuildId: "ios-build-22" };
  let registry = prepareProductionCandidate(verifiedRegistry(["ios"]), { platform: "ios", release,
    operationId: c.operationId, toolingApproval: c.toolingApproval, metadataHash, countries: [], rollout: c.rollout,
    serverCompatibility: c.serverCompatibility, remoteBaseline: remoteBaselineFor("ios", initialSnapshot),
    publishedMasterSha, activationFenceFingerprint: null, preparedAt: c.preparedAt });
  const prepared = productionStatus(registry, "ios").candidate;
  const operationId = "candidate:ios:review-shell-recovery";
  registry = beginProductionOperation(registry, { operationId, platform: "ios", action: "submit", candidate: prepared,
    expectedBaselineFingerprint: null, expectedRemoteFingerprint: prepared.remoteBaselineFingerprint });
  const record = (step, current) => recordProductionSubstep(current, operationId, step);
  const lookup = (stepId, current) => productionStatus(current, "ios").operations[0].substeps.find((step) => step.stepId === stepId);
  const guard = (stepId, requestFingerprint, current) => {
    const step = lookup(stepId, current);
    if (!step) return;
    assert.equal(step?.requestFingerprint, requestFingerprint);
    assert.ok(!["sent", "uncertain"].includes(step?.status));
  };
  let firstError;
  try {
    await runProductionAction({ action: "submit", platform: "ios", candidate: prepared, registry, operationId,
      clients: { apple: api }, snapshot: initialSnapshot, serverProof: prepared.serverCompatibility,
      expectedRemoteFingerprint: prepared.remoteBaselineFingerprint, substepRecorder: record,
      substepGuard: guard, substepLookup: lookup });
  } catch (error) {
    firstError = error;
  }
  assert.match(firstError?.message ?? "", /review shell response lost/u);
  registry = firstError.productionRegistry;
  const uncertain = productionStatus(registry, "ios").operations[0];
  assert.equal(uncertain.substeps.find((step) => step.stepId === "apple.review-submission.create")?.status, "uncertain");
  const reconciled = await reconcileProductionAction({ action: "submit", platform: "ios", candidate: prepared,
    clients: { apple: api }, registry, operationId, expectedRemoteFingerprint: uncertain.expectedRemoteFingerprint,
    reviewSubmissionAdoption: { operationId, remoteId: "submission-1", candidateFingerprint: productionCandidateFingerprint(prepared) } });
  registry = reconciled.registry;
  const recovered = productionStatus(registry, "ios").operations[0].substeps.find((step) => step.stepId === "apple.review-submission.create");
  assert.equal(recovered.status, "observed");
  assert.equal(recovered.remoteId, "submission-1");
  const adoption = { operationId, remoteId: "submission-1", candidateFingerprint: productionCandidateFingerprint(prepared) };
  state.item = { type: "reviewSubmissionItems", id: "unrelated-item", relationships: {
    appStoreVersion: { data: { type: "appStoreVersions", id: "unrelated-version" } }
  } };
  const contaminatedSnapshot = await productionAppleSnapshot(api);
  const writesBeforeGuard = state.calls.filter(({ method }) => method !== "GET").length;
  const contaminatedOperation = productionStatus(registry, "ios").operations[0];
  let contaminationError;
  try {
    await runProductionAction({ action: "submit", platform: "ios", candidate: prepared, registry, operationId,
      clients: { apple: api }, snapshot: contaminatedSnapshot, serverProof: prepared.serverCompatibility,
      expectedRemoteFingerprint: contaminatedOperation.expectedRemoteFingerprint, substepRecorder: record,
      substepGuard: guard, substepLookup: lookup, reviewSubmissionAdoption: adoption });
  } catch (error) {
    contaminationError = error;
  }
  assert.match(contaminationError?.message ?? "", /unrelated item association/u);
  assert.equal(state.calls.filter(({ method }) => method !== "GET").length, writesBeforeGuard);
  registry = contaminationError.productionRegistry;
  state.item = null;
  const retrySnapshot = await productionAppleSnapshot(api);
  const retryOperation = productionStatus(registry, "ios").operations[0];
  const retried = await runProductionAction({ action: "submit", platform: "ios", candidate: prepared, registry, operationId,
    clients: { apple: api }, snapshot: retrySnapshot, serverProof: prepared.serverCompatibility,
    expectedRemoteFingerprint: retryOperation.expectedRemoteFingerprint, substepRecorder: record,
    substepGuard: guard, substepLookup: lookup, reviewSubmissionAdoption: adoption });
  assert.equal(productionStatus(retried.registry, "ios").operations[0].status, "succeeded");
  assert.equal(state.calls.filter(({ method, path }) => method === "POST" && path === "/v1/reviewSubmissions").length, 1);
  assert.equal(state.calls.filter(({ method, path }) => method === "POST" && path === "/v1/reviewSubmissionItems").length, 1);
});

test("Apple reused review shell permits only the exact candidate item", async () => {
  const snapshot = { bundleId: "com.ashatlas.game", appId: "app-1", firstLaunch: true,
    builds: [{ id: "ios-build-22", version: "22", processingState: "VALID", expired: false, audience: "APP_STORE_ELIGIBLE" }],
    versions: [{ id: "version-2", versionString: "1.2.0", state: "READY_FOR_REVIEW", releaseType: "MANUAL",
      buildId: "ios-build-22", phasedReleaseId: null, reviewSubmissionId: "submission-1" }],
    reviewSubmissions: [{ id: "submission-1", state: "READY_FOR_REVIEW", versionId: "version-2", itemId: "item-1" }] };
  const c = candidate("ios", snapshot, { firstLaunch: true, countries: [], storeBuildId: "ios-build-22", build: 22,
    rollout: { kind: "first-publish", mode: "manual" } });
  const calls = [];
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "GET" && path === "/v1/reviewSubmissions/submission-1?include=appStoreVersionForReview,items") {
      return { data: { type: "reviewSubmissions", id: "submission-1", attributes: { state: "READY_FOR_REVIEW" },
        relationships: { app: { data: { type: "apps", id: "app-1" } },
          appStoreVersionForReview: { data: { type: "appStoreVersions", id: "version-2" } },
          items: { data: [{ type: "reviewSubmissionItems", id: "item-1" }] } } },
      included: [
        { type: "appStoreVersions", id: "version-2", attributes: {
          platform: "IOS", versionString: "1.2.0", releaseType: "MANUAL"
        }, relationships: { app: { data: { type: "apps", id: "app-1" } },
          build: { data: { type: "builds", id: "ios-build-22" } } } },
        { type: "reviewSubmissionItems", id: "item-1", relationships: {
          appStoreVersion: { data: { type: "appStoreVersions", id: "version-2" } }
        } }
      ] };
    }
    if (method === "PATCH" && path === "/v1/reviewSubmissions/submission-1") return { data: { id: "submission-1" } };
    throw new Error(`unexpected exact-item request ${method} ${path}`);
  };
  const result = await submitAppleProduction(api, snapshot, c);
  assert.equal(result.submissionId, "submission-1");
  assert.deepEqual(calls.map(({ method, path }) => `${method} ${path}`), [
    "GET /v1/reviewSubmissions/submission-1?include=appStoreVersionForReview,items",
    "PATCH /v1/reviewSubmissions/submission-1"
  ]);
});

test("Apple refuses ambiguous or unjournaled detached review shells before any write", async () => {
  const snapshot = { bundleId: "com.ashatlas.game", appId: "app-1", firstLaunch: true,
    builds: [{ id: "ios-build-22", version: "22", processingState: "VALID", expired: false, audience: "APP_STORE_ELIGIBLE" }],
    versions: [{ id: "version-2", versionString: "1.2.0", state: "READY_FOR_REVIEW", releaseType: "MANUAL",
      buildId: "ios-build-22", phasedReleaseId: null }],
    reviewSubmissions: [{ id: "orphan-1", state: "READY_FOR_REVIEW", versionId: null, itemId: null },
      { id: "orphan-2", state: "READY_FOR_REVIEW", versionId: null, itemId: null }] };
  let writes = 0;
  const api = async () => { writes += 1; return {}; };
  const c = candidate("ios", snapshot, { firstLaunch: true, countries: [], storeBuildId: "ios-build-22", build: 22,
    rollout: { kind: "first-publish", mode: "manual" } });
  await assert.rejects(() => submitAppleProduction(api, snapshot, c), /shell identity is ambiguous/u);
  assert.equal(writes, 0);
});

test("Apple refuses a different detached shell approval and validates an owned shell before binding it", async () => {
  const snapshot = { bundleId: "com.ashatlas.game", appId: "app-1", firstLaunch: true,
    builds: [{ id: "ios-build-22", version: "22", processingState: "VALID", expired: false, audience: "APP_STORE_ELIGIBLE" }],
    versions: [{ id: "version-2", versionString: "1.2.0", state: "READY_FOR_REVIEW", releaseType: "MANUAL",
      buildId: "ios-build-22", phasedReleaseId: null }],
    reviewSubmissions: [{ id: "orphan-1", state: "READY_FOR_REVIEW", appId: "app-1", versionId: null, itemId: null }] };
  const c = candidate("ios", snapshot, { firstLaunch: true, countries: [], storeBuildId: "ios-build-22", build: 22,
    rollout: { kind: "first-publish", mode: "manual" } });
  let writes = 0;
  await assert.rejects(() => submitAppleProduction(async () => { writes += 1; return {}; }, snapshot, c, null, {
    operationId: "candidate:ios:adoption",
    reviewSubmissionAdoption: { operationId: "candidate:ios:adoption", remoteId: "different-shell",
      candidateFingerprint: productionCandidateFingerprint(c) }
  }), /explicit operation-bound adoption approval/u);
  assert.equal(writes, 0);

  const calls = [];
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "GET" && path === "/v1/reviewSubmissions/orphan-1?include=appStoreVersionForReview,items") {
      return { data: { type: "reviewSubmissions", id: "orphan-1", attributes: { state: "READY_FOR_REVIEW" },
        relationships: { app: { data: { type: "apps", id: "app-1" } }, items: { data: [] } } } };
    }
    if (method === "POST" && path === "/v1/reviewSubmissionItems") return { data: { id: "item-1" } };
    if (method === "PATCH" && path === "/v1/reviewSubmissions/orphan-1") return { data: { id: "orphan-1" } };
    throw new Error(`unexpected owned-shell request ${method} ${path}`);
  };
  const result = await submitAppleProduction(api, snapshot, c, null, {
    operationId: "candidate:ios:adoption",
    reviewSubmissionAdoption: { operationId: "candidate:ios:adoption", remoteId: "orphan-1",
      candidateFingerprint: productionCandidateFingerprint(c) }
  });
  assert.equal(result.submissionId, "orphan-1");
  assert.deepEqual(calls.map(({ method, path }) => `${method} ${path}`), [
    "GET /v1/reviewSubmissions/orphan-1?include=appStoreVersionForReview,items",
    "POST /v1/reviewSubmissionItems", "PATCH /v1/reviewSubmissions/orphan-1"
  ]);
});

test("Apple refuses automatic versions, review states, and unrepresentable country widening before any write", async () => {
  const base = { bundleId: "com.ashatlas.game", appId: "app-1", firstLaunch: true,
    builds: [{ id: "ios-build-22", version: "22", processingState: "VALID", expired: false, audience: "APP_STORE_ELIGIBLE" }] };
  const automatic = { ...base, versions: [{ id: "version-2", versionString: "1.2.0", state: "READY_FOR_REVIEW", releaseType: "AFTER_APPROVAL", buildId: null, phasedReleaseId: null }], reviewSubmissions: [] };
  const c = candidate("ios", automatic, { countries: [], firstLaunch: true, rollout: { kind: "first-publish", mode: "manual" }, storeBuildId: "ios-build-22", build: 22 });
  let writes = 0;
  const api = async () => { writes += 1; return {}; };
  await assert.rejects(() => submitAppleProduction(api, automatic, c), /MANUAL/u);
  assert.equal(writes, 0);
  const pending = { ...automatic, versions: [{ ...automatic.versions[0], releaseType: "MANUAL", state: "READY_FOR_REVIEW" }] };
  await assert.rejects(() => releaseAppleProduction(api, pending, c), /PENDING_DEVELOPER_RELEASE/u);
  assert.equal(writes, 0);
  const widened = { ...automatic, versions: [{ ...automatic.versions[0], releaseType: "MANUAL" }] };
  const widenedCandidate = { ...c, countries: ["US"] };
  await assert.rejects(() => submitAppleProduction(api, widened, widenedCandidate), /country scope/u);
  assert.equal(writes, 0);
});

test("Apple configures and verifies an approved phased policy before releasing an update", async () => {
  const snapshot = { bundleId: "com.ashatlas.game", appId: "app-1", firstLaunch: false,
    versions: [{ id: "version-2", versionString: "1.2.0", state: "PENDING_DEVELOPER_RELEASE", releaseType: "MANUAL",
      buildId: "ios-build-2", phasedReleaseId: null }], reviewSubmissions: [] };
  const c = candidate("ios", snapshot, { countries: [], firstLaunch: false,
    rollout: { kind: "update", mode: "staged", fraction: 0.1 }, storeBuildId: "ios-build-2" });
  const calls = [];
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "POST" && path === "/v1/appStoreVersionPhasedReleases") return { data: {
      id: "phase-2", attributes: { phasedReleaseState: "INACTIVE" } } };
    if (method === "GET" && path === "/v1/appStoreVersionPhasedReleases/phase-2") return { data: {
      id: "phase-2", attributes: { phasedReleaseState: "INACTIVE" } } };
    if (method === "POST" && path === "/v1/appStoreVersionReleaseRequests") return {};
    throw new Error(`unexpected Apple release request ${method} ${path}`);
  };
  const result = await releaseAppleProduction(api, snapshot, c);
  assert.equal(result.phase, "released");
  assert.deepEqual(calls.map(({ method, path }) => `${method} ${path}`), [
    "POST /v1/appStoreVersionPhasedReleases",
    "GET /v1/appStoreVersionPhasedReleases/phase-2",
    "POST /v1/appStoreVersionReleaseRequests"
  ]);
  assert.equal(calls[0].body.data.attributes.phasedReleaseState, "INACTIVE");
});

test("Apple runner journals and recovers a lost phased-policy create before retrying release", async () => {
  const state = { phaseId: null, phaseState: null, calls: [], losePhaseCreate: true };
  const versionWire = () => ({ type: "appStoreVersions", id: "version-2", attributes: {
    versionString: "1.2.0", appVersionState: state.phaseState === "ACTIVE" ? "READY_FOR_DISTRIBUTION" : "PENDING_DEVELOPER_RELEASE",
    releaseType: "MANUAL"
  }, relationships: { build: { data: { type: "builds", id: "ios-build-22" } },
    ...(state.phaseId ? { appStoreVersionPhasedRelease: { data: { type: "appStoreVersionPhasedReleases", id: state.phaseId } } } : {})
  } });
  const api = async (method, path, body) => {
    state.calls.push({ method, path, body });
    if (method === "GET" && path.includes("/v1/apps?")) return { data: [{ id: "app-1", attributes: { bundleId: "com.ashatlas.game" } }] };
    if (method === "GET" && path.includes("/v1/builds?")) return { data: [{ type: "builds", id: "ios-build-22", attributes: {
      version: "22", processingState: "VALID", expired: false, buildAudienceType: "APP_STORE_ELIGIBLE"
    } }] };
    if (method === "GET" && path.includes("/v1/apps/app-1/appStoreVersions?")) return { data: [
      { type: "appStoreVersions", id: "version-1", attributes: {
        versionString: "1.1.0", appVersionState: "READY_FOR_DISTRIBUTION", releaseType: "MANUAL"
      }, relationships: { build: { data: { type: "builds", id: "ios-build-22" } } } }, versionWire()
    ] };
    if (method === "GET" && path.includes("/v1/apps/app-1/reviewSubmissions?")) return { data: [], included: [] };
    if (method === "GET" && path === "/v1/appStoreVersionPhasedReleases/phase-1") return { data: {
      id: "phase-1", attributes: { phasedReleaseState: state.phaseState ?? "INACTIVE" }
    } };
    if (method === "POST" && path === "/v1/appStoreVersionPhasedReleases") {
      state.phaseId = "phase-1";
      state.phaseState = "INACTIVE";
      if (state.losePhaseCreate) {
        state.losePhaseCreate = false;
        throw new Error("phased policy response lost");
      }
      return { data: { id: state.phaseId, attributes: { phasedReleaseState: state.phaseState } } };
    }
    if (method === "POST" && path === "/v1/appStoreVersionReleaseRequests") {
      state.phaseState = "ACTIVE";
      return { data: { id: "release-request-1" } };
    }
    throw new Error(`unexpected Apple phased-policy runner request ${method} ${path}`);
  };
  const initialSnapshot = await productionAppleSnapshot(api);
  const c = candidate("ios", initialSnapshot, { firstLaunch: false, countries: [], storeBuildId: "ios-build-22", build: 22,
    rollout: { kind: "update", mode: "staged", fraction: 0.1 } });
  const release = { ...verifiedRegistry(["ios"]).releases.find((entry) => entry.releaseId === c.releaseId && entry.platform === "ios"),
    storeBuildId: "ios-build-22" };
  let registry = prepareProductionCandidate(verifiedRegistry(["ios"]), { platform: "ios", release,
    operationId: c.operationId, toolingApproval: c.toolingApproval, metadataHash, countries: [], rollout: c.rollout,
    serverCompatibility: c.serverCompatibility, remoteBaseline: remoteBaselineFor("ios", initialSnapshot),
    publishedMasterSha, activationFenceFingerprint: null, preparedAt: c.preparedAt });
  const prepared = productionStatus(registry, "ios").candidate;
  const operationId = "candidate:ios:phased-policy-recovery";
  registry = beginProductionOperation(registry, { operationId, platform: "ios", action: "release", candidate: prepared,
    expectedBaselineFingerprint: null, expectedRemoteFingerprint: prepared.remoteBaselineFingerprint });
  const record = (step, current) => recordProductionSubstep(current, operationId, step);
  const lookup = (stepId, current) => productionStatus(current, "ios").operations[0].substeps.find((step) => step.stepId === stepId);
  const guard = (stepId, requestFingerprint, current) => {
    const step = lookup(stepId, current);
    if (!step) return;
    assert.equal(step?.requestFingerprint, requestFingerprint);
    assert.ok(!["sent", "uncertain"].includes(step?.status));
  };
  let firstError;
  try {
    await runProductionAction({ action: "release", platform: "ios", candidate: prepared, registry, operationId,
      clients: { apple: api }, snapshot: initialSnapshot, serverProof: prepared.serverCompatibility,
      releaseApproved: true, approvalFingerprint: productionCandidateFingerprint(prepared),
      expectedRemoteFingerprint: prepared.remoteBaselineFingerprint, substepRecorder: record,
      substepGuard: guard, substepLookup: lookup });
  } catch (error) {
    firstError = error;
  }
  assert.match(firstError?.message ?? "", /phased policy response lost/u);
  registry = firstError.productionRegistry;
  const uncertain = productionStatus(registry, "ios").operations[0];
  assert.equal(uncertain.substeps.find((step) => step.stepId === "apple.phased-policy.create")?.status, "uncertain");
  const reconciled = await reconcileProductionAction({ action: "release", platform: "ios", candidate: prepared,
    clients: { apple: api }, registry, operationId, expectedRemoteFingerprint: uncertain.expectedRemoteFingerprint });
  registry = reconciled.registry;
  const recovered = productionStatus(registry, "ios").operations[0].substeps.find((step) => step.stepId === "apple.phased-policy.create");
  assert.equal(recovered.status, "observed");
  assert.equal(recovered.remoteId, "phase-1");
  const retrySnapshot = await productionAppleSnapshot(api);
  const retryOperation = productionStatus(registry, "ios").operations[0];
  const retried = await runProductionAction({ action: "release", platform: "ios", candidate: prepared, registry, operationId,
    clients: { apple: api }, snapshot: retrySnapshot, serverProof: prepared.serverCompatibility,
    releaseApproved: true, approvalFingerprint: productionCandidateFingerprint(prepared),
    expectedRemoteFingerprint: retryOperation.expectedRemoteFingerprint, substepRecorder: record,
    substepGuard: guard, substepLookup: lookup });
  assert.equal(productionStatus(retried.registry, "ios").operations[0].status, "succeeded");
  assert.equal(state.calls.filter(({ method, path }) => method === "POST" && path === "/v1/appStoreVersionPhasedReleases").length, 1);
  assert.equal(state.calls.filter(({ method, path }) => method === "POST" && path === "/v1/appStoreVersionReleaseRequests").length, 1);
});

test("Apple review and phased states are not confused with release availability", () => {
  const base = { bundleId: "com.ashatlas.game", firstLaunch: false,
    versions: [{ id: "version-2", versionString: "1.2.0", releaseType: "MANUAL", buildId: "ios-build-22", phasedReleaseId: "phase-2" }] };
  const c = candidate("ios", base, { countries: [], firstLaunch: false,
    rollout: { kind: "update", mode: "staged", fraction: 0.1 }, storeBuildId: "ios-build-22" });
  const review = { ...base, versions: [{ ...base.versions[0], state: "READY_FOR_REVIEW", reviewSubmissionState: "READY_FOR_REVIEW", phasedReleaseState: "INACTIVE" }] };
  assert.equal(classifyObservedProductionAction("submit", "ios", c, review, sha256Json(remoteBaselineFor("ios", review))).matched, false);
  const queued = { ...review, versions: [{ ...review.versions[0], reviewSubmissionState: "WAITING_FOR_REVIEW" }] };
  const queuedObservation = classifyObservedProductionAction("submit", "ios", c, queued, sha256Json(remoteBaselineFor("ios", queued)));
  assert.equal(queuedObservation.matched, true);
  assert.equal(queuedObservation.published, false);
  const approved = { ...queued, versions: [{ ...queued.versions[0], state: "PENDING_DEVELOPER_RELEASE", reviewSubmissionState: "APPROVED" }] };
  assert.equal(classifyObservedProductionAction("release", "ios", c, approved, sha256Json(remoteBaselineFor("ios", approved))).matched, false);
  const active = { ...approved, versions: [{ ...approved.versions[0], state: "READY_FOR_SALE", phasedReleaseState: "ACTIVE" }] };
  const released = classifyObservedProductionAction("release", "ios", c, active, sha256Json(remoteBaselineFor("ios", active)));
  assert.equal(released.matched, true);
  assert.equal(released.available, true);
  const paused = { ...active, versions: [{ ...active.versions[0], phasedReleaseState: "PAUSED" }] };
  const pausedObservation = classifyObservedProductionAction("pause", "ios", c, paused, sha256Json(remoteBaselineFor("ios", paused)));
  assert.equal(pausedObservation.matched, true);
  assert.equal(pausedObservation.published, false);
  const currentWire = { ...queued, versions: [{ ...queued.versions[0], state: "READY_FOR_DISTRIBUTION",
    reviewSubmissionState: "COMPLETE", phasedReleaseState: "ACTIVE" }] };
  const currentWireSubmit = classifyObservedProductionAction("submit", "ios", c, currentWire,
    sha256Json(remoteBaselineFor("ios", currentWire)));
  assert.equal(currentWireSubmit.matched, true);
  const currentWireRelease = classifyObservedProductionAction("release", "ios", c, currentWire,
    sha256Json(remoteBaselineFor("ios", currentWire)));
  assert.equal(currentWireRelease.matched, true);
  assert.equal(currentWireRelease.available, true);
});

test("Apple phased pause and resume verify the actual phase state before each write", async () => {
  const snapshot = { bundleId: "com.ashatlas.game", firstLaunch: false,
    versions: [{ id: "version-2", versionString: "1.2.0", state: "READY_FOR_SALE", releaseType: "MANUAL",
      buildId: "ios-build-22", phasedReleaseId: "phase-2", phasedReleaseState: "ACTIVE" }] };
  const c = candidate("ios", snapshot, { countries: [], firstLaunch: false, storeBuildId: "ios-build-22",
    rollout: { kind: "update", mode: "staged", fraction: 0.1 } });
  let state = "ACTIVE";
  const calls = [];
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "GET") return { data: { id: "phase-2", attributes: { phasedReleaseState: state } } };
    state = body.data.attributes.phasedReleaseState;
    return { data: { id: "phase-2", attributes: { phasedReleaseState: state } } };
  };
  assert.equal((await pauseAppleProduction(api, snapshot, c)).phase, "paused");
  const pausedSnapshot = { ...snapshot, versions: [{ ...snapshot.versions[0], phasedReleaseState: "PAUSED" }] };
  assert.equal((await resumeAppleProduction(api, pausedSnapshot, c)).phase, "released");
  assert.deepEqual(calls.map(({ method, path }) => `${method} ${path}`), [
    "GET /v1/appStoreVersionPhasedReleases/phase-2",
    "PATCH /v1/appStoreVersionPhasedReleases/phase-2",
    "GET /v1/appStoreVersionPhasedReleases/phase-2",
    "PATCH /v1/appStoreVersionPhasedReleases/phase-2"
  ]);
});

test("Google first publication is full, drafts do not count as history, and live builds cannot downgrade", () => {
  const first = { packageName: "com.ashatlas.game", firstLaunch: true,
    productionTrack: { track: "production", releases: [{ name: "t1250 (72)", versionCodes: ["72"], status: "draft" }] },
    bundles: [{ versionCode: 72, sha256: artifactSha }] };
  const full = candidate("android", first, { countries: [], firstLaunch: true,
    rollout: { kind: "first-publish", mode: "full" }, build: 72, storeBuildId: "72" });
  assert.equal(buildGoogleProductionTrack(first, full, "release").releases[0].status, "completed");
  assert.throws(() => buildGoogleProductionTrack(first, { ...full, rollout: { kind: "first-publish", mode: "staged", fraction: 0.1 } }, "release"), /first publication/u);
  const live = { packageName: "com.ashatlas.game", firstLaunch: false,
    productionTrack: { track: "production", releases: [{ name: "live", versionCodes: ["80"], status: "completed" }] },
    bundles: [{ versionCode: 72, sha256: artifactSha }] };
  assert.throws(() => buildGoogleProductionTrack(live, { ...full, firstLaunch: false,
    rollout: { kind: "update", mode: "staged", fraction: 0.1 } }, "submit"), /downgrade/u);
  assert.throws(() => buildGoogleProductionTrack({ ...live,
    productionTrack: { track: "production", releases: [{ name: "draft", versionCodes: ["72"], status: "draft" }] },
    productionLifecycle: [{ name: "live", track: "production", versionCodes: ["80"],
      lifecycleState: "RELEASE_LIFECYCLE_STATE_PUBLISHED" }],
    firstLaunch: false }, { ...full, firstLaunch: false, build: 72, storeBuildId: "72",
    rollout: { kind: "update", mode: "staged", fraction: 0.1 } }, "submit"), /downgrade/u);
  const higher = { ...full, firstLaunch: false, build: 90, storeBuildId: "90", countries: ["US"],
    rollout: { kind: "update", mode: "full" } };
  assert.throws(() => buildGoogleProductionTrack({ ...live, bundles: [{ versionCode: 90, sha256: artifactSha }] }, higher, "release"), /country targeting/u);
});

test("Google resume is legal and a completed release can halt only with a published fallback", async () => {
  const snapshot = { packageName: "com.ashatlas.game", firstLaunch: false,
    productionTrack: { track: "production", releases: [{ name: "t1250 (72)", versionCodes: ["72"], status: "halted",
      userFraction: 0.1 }] }, bundles: [{ versionCode: 72, sha256: artifactSha }] };
  const c = candidate("android", snapshot, { countries: [], firstLaunch: false, build: 72, storeBuildId: "72",
    rollout: { kind: "update", mode: "staged", fraction: 0.1 } });
  const calls = [];
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "POST" && path.endsWith("/edits")) return { id: "edit-1" };
    if (method === "GET" && path.endsWith("/tracks")) return { tracks: [{ track: "production", releases: snapshot.productionTrack.releases }] };
    if (method === "PUT") return {};
    if (method === "POST" && path.split("?", 1)[0].endsWith(":commit")) return {};
    throw new Error(`unexpected Google resume request ${method} ${path}`);
  };
  const result = await resumeGoogleProduction(api, snapshot, c);
  assert.equal(result.track.releases[0].status, "inProgress");
  assert.throws(() => buildGoogleProductionTrack({ ...snapshot,
    productionTrack: { track: "production", releases: [{ name: "live", versionCodes: ["72"], status: "completed" }] } },
  { ...c, rollout: { kind: "update", mode: "full" } }, "pause"), /identity or transition/u);
  const eligible = { ...snapshot,
    productionTrack: { track: "production", releases: [
      { name: "t1249 (70)", versionCodes: ["70"], status: "completed" },
      { name: "t1250 (72)", versionCodes: ["72"], status: "completed" }
    ] },
    bundles: [{ versionCode: 70, sha256: "a".repeat(64) }, { versionCode: 72, sha256: artifactSha }],
    productionLifecycle: [
      { name: "t1249 (70)", track: "production", versionCodes: ["70"], lifecycleState: "RELEASE_LIFECYCLE_STATE_PUBLISHED" },
      { name: "t1250 (72)", track: "production", versionCodes: ["72"], lifecycleState: "RELEASE_LIFECYCLE_STATE_PUBLISHED" }
    ] };
  const halted = buildGoogleProductionTrack(eligible, { ...c, rollout: { kind: "update", mode: "full" } }, "pause");
  const haltedRelease = halted.releases.find((release) => release.versionCodes.includes("72"));
  assert.equal(haltedRelease.status, "halted");
  assert.equal("userFraction" in haltedRelease, false);
  assert.equal(calls.filter(({ method }) => method === "PUT").length, 1);
});

test("Google can halt an eligible prior staged release while the approved next transition is full", () => {
  const snapshot = { packageName: "com.ashatlas.game", firstLaunch: false,
    productionTrack: { track: "production", releases: [{ name: "t1250 (72)", versionCodes: ["72"],
      status: "inProgress", userFraction: 0.1 }] }, bundles: [{ versionCode: 72, sha256: artifactSha }] };
  const c = candidate("android", snapshot, { firstLaunch: false, build: 72, storeBuildId: "72", countries: [],
    rollout: { kind: "update", mode: "full" } });
  const paused = buildGoogleProductionTrack(snapshot, c, "pause");
  assert.equal(paused.releases[0].status, "halted");
  assert.equal(paused.releases[0].userFraction, 0.1);
  assert.equal("countryTargeting" in paused.releases[0], false);
});

test("Google removes stale country targeting when a release leaves inProgress", () => {
  const snapshot = { packageName: "com.ashatlas.game", firstLaunch: false,
    productionTrack: { track: "production", releases: [{ name: "t1250 (72)", versionCodes: ["72"],
      status: "inProgress", userFraction: 0.1, countryTargeting: { countries: ["US"], includeRestOfWorld: false } }] },
    bundles: [{ versionCode: 72, sha256: artifactSha }], productionLifecycle: [] };
  const c = candidate("android", snapshot, { firstLaunch: false, build: 72, storeBuildId: "72", countries: ["US"],
    rollout: { kind: "update", mode: "full" } });
  const track = buildGoogleProductionTrack(snapshot, c, "pause");
  assert.equal(track.releases[0].status, "halted");
  assert.equal("countryTargeting" in track.releases[0], false);
});

test("Google rollout PUTs keep status-inappropriate fields out of 10-to-50-to-full transitions", () => {
  const snapshot = { packageName: "com.ashatlas.game", firstLaunch: false,
    productionTrack: { track: "production", releases: [{ name: "t1250 (72)", versionCodes: ["72"],
      status: "inProgress", userFraction: 0.1 }] }, bundles: [{ versionCode: 72, sha256: artifactSha }] };
  const staged = candidate("android", snapshot, { firstLaunch: false, countries: [], build: 72, storeBuildId: "72",
    rollout: { kind: "update", mode: "staged", fraction: 0.1 } });
  const atFifty = buildGoogleProductionTrack(snapshot, { ...staged,
    rollout: { kind: "update", mode: "staged", fraction: 0.5 } }, "advance");
  assert.equal(atFifty.releases[0].userFraction, 0.5);
  assert.equal("countryTargeting" in atFifty.releases[0], false);
  const full = buildGoogleProductionTrack({ ...snapshot, productionTrack: atFifty },
    { ...staged, rollout: { kind: "update", mode: "full" } }, "advance");
  assert.equal(full.releases[0].status, "completed");
  assert.equal("userFraction" in full.releases[0], false);
  assert.equal("countryTargeting" in full.releases[0], false);
});

test("Google resume recovers approved countries when halted wire state omits countryTargeting", () => {
  const snapshot = { packageName: "com.ashatlas.game", firstLaunch: false,
    productionTrack: { track: "production", releases: [{ name: "t1250 (72)", versionCodes: ["72"], status: "halted",
      userFraction: 0.1 }] }, bundles: [{ versionCode: 72, sha256: artifactSha }] };
  const c = candidate("android", snapshot, { firstLaunch: false, countries: ["US"], build: 72, storeBuildId: "72",
    rollout: { kind: "update", mode: "staged", fraction: 0.1 } });
  const resumed = buildGoogleProductionTrack(snapshot, c, "resume");
  assert.equal(resumed.releases[0].status, "inProgress");
  assert.deepEqual(resumed.releases[0].countryTargeting, { countries: ["US"], includeRestOfWorld: false });
  const retainedScope = { ...snapshot, productionTrack: { track: "production", releases: [{
    name: "t1250 (72)", versionCodes: ["72"], status: "halted", userFraction: 0.1,
    countryTargeting: { countries: ["US"], includeRestOfWorld: false }
  }] } };
  assert.throws(() => buildGoogleProductionTrack(retainedScope, { ...c, countries: ["CA"] }, "resume"), /country scope/u);
});

test("Google full release halts an eligible prior staged build before adding the next one", () => {
  const snapshot = { packageName: "com.ashatlas.game", firstLaunch: false,
    productionTrack: { track: "production", releases: [
      { name: "t1249 (70)", versionCodes: ["70"], status: "inProgress", userFraction: 0.5,
        countryTargeting: { countries: ["US"], includeRestOfWorld: false } }
    ] }, bundles: [{ versionCode: 70, sha256: "a".repeat(64) }, { versionCode: 72, sha256: artifactSha }],
    productionLifecycle: [{ name: "t1249 (70)", track: "production", versionCodes: ["70"],
      lifecycleState: "RELEASE_LIFECYCLE_STATE_PUBLISHED" }] };
  const c = candidate("android", snapshot, { firstLaunch: false, build: 72, storeBuildId: "72", countries: [],
    rollout: { kind: "update", mode: "full" } });
  const track = buildGoogleProductionTrack(snapshot, c, "release");
  const prior = track.releases.find((release) => release.versionCodes.includes("70"));
  const next = track.releases.find((release) => release.versionCodes.includes("72"));
  assert.equal(prior.status, "halted");
  assert.equal("countryTargeting" in prior, false);
  assert.equal(next.status, "completed");
});

test("metadata actions consume the exact approved packet bytes", () => {
  const directory = mkdtempSync(join(tmpdir(), "ash-atlas-production-metadata-"));
  const packet = join(directory, "approved.json");
  try {
    const bytes = Buffer.from('{"version":"1.2.0","countries":["US"]}\n', "utf8");
    writeFileSync(packet, bytes);
    const hash = createHash("sha256").update(bytes).digest("hex");
    assert.equal(approvedMetadataPacketHash("ios", { IOS_PRODUCTION_METADATA_PACKET_PATH: packet }), hash);
    assert.throws(() => approvedMetadataPacketHash("android", {}), /packet path is required/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("metadata packets are parsed, schema-bound, and reject unrelated files", () => {
  const directory = mkdtempSync(join(tmpdir(), "ash-atlas-production-metadata-schema-"));
  const packetPath = join(directory, "approved.json");
  const invalidPath = join(directory, ".nvmrc");
  try {
    const packet = { schemaVersion: 1, platform: "ios", bundleId: "com.ashatlas.game", marketingVersion: "1.2.0",
      localizations: [{ locale: "en-US", name: "Ash Atlas", subtitle: "Explore a living fantasy atlas." }],
      policy: { countries: [], rollout: { kind: "update", mode: "staged", fraction: 0.1 } } };
    writeFileSync(packetPath, `${JSON.stringify(packet)}\n`);
    writeFileSync(invalidPath, "24\n");
    const parsed = readApprovedMetadataPacket("ios", { IOS_PRODUCTION_METADATA_PACKET_PATH: packetPath });
    const snapshot = { bundleId: "com.ashatlas.game", firstLaunch: false, versions: [] };
    const c = candidate("ios", snapshot, { firstLaunch: false, countries: [], rollout: packet.policy.rollout });
    assert.doesNotThrow(() => assertProductionMetadataBinding(parsed.packet, "ios", c, c.rollout, c.countries));
    assert.throws(() => readApprovedMetadataPacket("ios", { IOS_PRODUCTION_METADATA_PACKET_PATH: invalidPath }), /schemaVersion|JSON/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("production metadata drift is rejected before an Apple submission write", async () => {
  const snapshot = { bundleId: "com.ashatlas.game", appId: "app-1", firstLaunch: false,
    builds: [{ id: "ios-22", version: "22", processingState: "VALID", expired: false, audience: "APP_STORE_ELIGIBLE" }],
    versions: [{ id: "version-2", versionString: "1.2.0", state: "READY_FOR_REVIEW", releaseType: "MANUAL",
      buildId: "ios-22", phasedReleaseId: null }], reviewSubmissions: [] };
  const c = candidate("ios", snapshot, { firstLaunch: false, countries: [], storeBuildId: "ios-22",
    rollout: { kind: "update", mode: "staged", fraction: 0.1 } });
  const packet = { schemaVersion: 1, platform: "ios", bundleId: "com.ashatlas.game", marketingVersion: "1.2.0",
    localizations: [{ locale: "en-US", name: "Ash Atlas", subtitle: "Explore." }],
    policy: { countries: [], rollout: c.rollout }, build: 22, storeBuildId: "ios-22" };
  let writes = 0;
  const api = async (method, path) => {
    if (method === "GET" && path.includes("appStoreVersionLocalizations")) {
      return { data: [{ attributes: { locale: "en-US", name: "Tampered Atlas", subtitle: "Explore." } }] };
    }
    writes += 1;
    return {};
  };
  await assert.rejects(() => submitAppleProduction(api, snapshot, c, packet), /metadata field name changed/u);
  assert.equal(writes, 0);
});

test("production baseline cannot advance from a review or pending availability receipt", () => {
  const snapshot = { packageName: "com.ashatlas.game", firstLaunch: false,
    productionTrack: { track: "production", releases: [{ name: "draft", versionCodes: ["50"], status: "draft" }] },
    bundles: [{ versionCode: 72, sha256: artifactSha }] };
  let registry = verifiedRegistry();
  const release = registry.releases.find((entry) => entry.releaseId === "production-fixture" && entry.platform === "android");
  const c = candidate("android", snapshot, { countries: [], firstLaunch: false, build: 72, storeBuildId: "72",
    rollout: { kind: "update", mode: "staged", fraction: 0.1 } });
  registry = prepareProductionCandidate(registry, { platform: "android", release, operationId: c.operationId,
    toolingApproval: c.toolingApproval, metadataHash, countries: c.countries, rollout: c.rollout,
    serverCompatibility: c.serverCompatibility, remoteBaseline: remoteBaselineFor("android", snapshot),
    publishedMasterSha, activationFenceFingerprint: null, preparedAt: c.preparedAt });
  const prepared = productionStatus(registry, "android").candidate;
  const operationId = "candidate:android:release-pending";
  const expected = sha256Json(remoteBaselineFor("android", snapshot));
  registry = beginProductionOperation(registry, { operationId, platform: "android", action: "release",
    candidate: prepared, expectedBaselineFingerprint: null, expectedRemoteFingerprint: expected });
  assert.throws(() => finishProductionOperation(registry, operationId, { status: "succeeded", receipt: { schemaVersion: 1 },
    remote: { ...publishedObservation(prepared, expected), available: false, published: false } }), /availability evidence/u);
  assert.equal(productionStatus(registry, "android").baseline, null);
});

function assertPreparedCandidateForTest(value, release, overrides = {}) {
  return assertPreparedCandidate(value, { ...release, ...overrides }, {
    toolSha: overrides.toolSha ?? toolSha,
    metadataHash,
    countries: ["US"],
    rollout: value.rollout,
    sourceSha,
    generation: release.generation,
    releaseId: release.releaseId
  });
}

function cliError(run) {
  try {
    run();
  } catch (error) {
    return `${error.message}\n${error.stderr?.toString() ?? ""}`;
  }
  throw new Error("expected CLI invocation to fail");
}

function withEnv(values, run) {
  const prior = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return run();
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function publishedObservation(candidateValue, expectedRemoteFingerprint, overrides = {}) {
  return { candidateFingerprint: productionCandidateFingerprint(candidateValue), expectedRemoteFingerprint,
    matched: true, terminal: true, mutation: true, available: true, published: true, authoritative: true,
    storeBuildId: candidateValue.storeBuildId, ...overrides };
}

function noMutationObservation(candidateValue, expectedRemoteFingerprint) {
  return { candidateFingerprint: productionCandidateFingerprint(candidateValue), expectedRemoteFingerprint,
    matched: false, published: false, noMutation: true, authoritative: true };
}
