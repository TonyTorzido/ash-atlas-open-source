import assert from "node:assert/strict";
import test from "node:test";

import {
  DAILY_TESTER_MODE,
  GOOGLE_INTERNAL_TEST_TRACK,
  readTesterDeliveryMode,
  normalizeTesterDestination,
  validateTesterObservation
} from "./coordinated-mobile-testers.mjs";
import { googlePath as GP, allowedRequest, verifyGoogleTesterStore, verifyTestFlightTesterStore } from "./store-api.mjs";
import { buildCoordinatedChildReceipt } from "./coordinated-receipts.mjs";
import { coordinatedGate } from "./coordinated-mobile.mjs";

const candidate = {
  operation_id: "coord-daily:android", platform: "android", release_id: "release-daily",
  source_sha: "a".repeat(40), generation: "t1251", marketing_version: "1.2.0", build: 72,
  store_build_id: "72", artifact_sha256: "b".repeat(64), tooling_sha: "c".repeat(40),
  metadata_sha256: "d".repeat(64), countries: ["US"],
  rollout: { kind: "update", mode: "staged", fraction: 0.1 },
  tester_destination: { kind: "google-play-internal", track: "internal" }
};

test("daily tester destinations require explicit TestFlight type and Google internal", () => {
  assert.equal(DAILY_TESTER_MODE, "daily-testers");
  assert.equal(readTesterDeliveryMode({}), null);
  assert.equal(readTesterDeliveryMode({ delivery_mode: DAILY_TESTER_MODE, deliveryMode: DAILY_TESTER_MODE }),
    DAILY_TESTER_MODE);
  assert.throws(() => readTesterDeliveryMode({ delivery_mode: DAILY_TESTER_MODE, deliveryMode: "production" }),
    /delivery mode aliases disagree/u);
  assert.deepEqual(normalizeTesterDestination("android", { kind: "google-play-internal", track: "internal" }),
    { kind: "google-play-internal", track: GOOGLE_INTERNAL_TEST_TRACK });
  assert.deepEqual(normalizeTesterDestination("ios", {
    kind: "testflight", group_type: "external", group_id: "public-1",
    public_link: "https://testflight.apple.com/join/Example"
  }), { kind: "testflight", group_type: "external", group_id: "public-1",
    public_link: "https://testflight.apple.com/join/Example" });
  assert.throws(() => normalizeTesterDestination("ios", { kind: "testflight", group_id: "public-1" }),
    /group type/u);
  assert.throws(() => normalizeTesterDestination("android", { kind: "google-play-internal", track: "qa" }),
    /internal/u);
});

test("daily receipt is candidate-bound to the tester destination and store observation", () => {
  const observation = { platform: "android", marketing_version: candidate.marketing_version,
    build: candidate.build, store_build_id: candidate.store_build_id,
    artifact_sha256: candidate.artifact_sha256, track: "internal", status: "completed",
    lifecycle_status: "RELEASE_LIFECYCLE_STATE_PUBLISHED", active_artifact_version_code: candidate.build,
    available: true };
  assert.doesNotThrow(() => validateTesterObservation({ platform: "android", candidate,
    destination: candidate.tester_destination, observation }));
  assert.doesNotThrow(() => validateTesterObservation({ platform: "android", candidate: {
    marketingVersion: candidate.marketing_version, build: candidate.build,
    storeBuildId: candidate.store_build_id, artifactSha256: candidate.artifact_sha256
  }, destination: candidate.tester_destination, observation }));
  const receipt = buildCoordinatedChildReceipt({ coordinatedOperationId: "coord-daily",
    candidate, production: { operations: [] }, snapshot: { tester: observation },
    observedAt: "2026-09-22T12:00:00.000Z" });
  assert.equal(receipt.tester_available, true);
  assert.equal(receipt.candidate.tester_destination.track, "internal");
  const gate = coordinatedGate([receipt, { ...receipt, platform: "ios", operation_id: "coord-daily:ios",
    candidate: { ...candidate, platform: "ios", operation_id: "coord-daily:ios",
      store_build_id: "ios-22", tester_destination: { kind: "testflight", group_type: "internal", group_id: "internal-1" } },
    tester_destination: { kind: "testflight", group_type: "internal", group_id: "internal-1" },
    store_status: "IN_BETA_TESTING", tester_status: "IN_BETA_TESTING", tester_available: true,
    receipt_sha256: "e".repeat(64) }]);
  assert.equal(gate.ready, true);
  assert.equal(gate.allowedServerPublication, true);
});

test("Google tester verification assigns only the exact internal candidate", async () => {
  let internal = { track: "internal", releases: [
    { name: "t1251 (72)", status: "draft", versionCodes: ["72"] },
    { name: "t1250 (71)", status: "completed", versionCodes: ["71"] }] };
  let internalLifecycle = [{ track: "internal", releaseLifecycleState: "RELEASE_LIFECYCLE_STATE_DRAFT",
    activeArtifacts: [{ versionCode: "72" }] }, { track: "internal", releaseLifecycleState: "RELEASE_LIFECYCLE_STATE_PUBLISHED",
    activeArtifacts: [{ versionCode: "71" }] }];
  const calls = [];
  const clients = { mutable: true, google: async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "POST" && path === `${GP}/edits`) return { id: "edit-1" };
    if (method === "GET" && path.endsWith("/tracks")) return { tracks: [internal] };
    if (method === "GET" && path.endsWith("/bundles")) return { bundles: [{ versionCode: 72, sha256: "b".repeat(64) }] };
    if (method === "GET" && path.endsWith("/apks")) return { apks: [] };
    if (method === "GET" && path.endsWith("/internal/releases")) return { releases: internalLifecycle };
    if (method === "PUT" && path.endsWith("/tracks/internal")) {
      internal = body;
      internalLifecycle = [{ track: "internal", releaseLifecycleState: "RELEASE_LIFECYCLE_STATE_PUBLISHED",
        activeArtifacts: [{ versionCode: body.releases[0].versionCodes[0] }] }];
      return body;
    }
    if (method === "POST" && path.endsWith(":commit")) return {};
    if (method === "DELETE") return {};
    throw new Error(`unexpected ${method} ${path}`);
  } };
  const result = await verifyGoogleTesterStore(clients, {
    uploadAttempted: true, artifactSha256: candidate.artifact_sha256, build: candidate.build,
    marketingVersion: candidate.marketing_version, storeBuildId: candidate.store_build_id,
    generation: candidate.generation
  }, candidate.tester_destination);
  assert.equal(result.observation.track, "internal");
  assert.equal(result.observation.available, true);
  assert.equal(calls.filter((entry) => entry.method === "PUT").length, 1);
  assert.equal(calls.find((entry) => entry.method === "PUT").body.track, "internal");
  assert.equal(allowedRequest("google", "PUT", `${GP}/edits/edit-1/tracks/internal`, true), true);
  assert.equal(allowedRequest("google", "PUT", `${GP}/edits/edit-1/tracks/qa`, true), false);
});

test("internal TestFlight verification binds the existing group and processed build", async () => {
  let attached = false;
  const release = { platform: "ios", uploadAttempted: true, artifactSha256: "b".repeat(64),
    marketingVersion: "1.2.0", build: 22, storeBuildId: "ios-22" };
  const calls = [];
  const apple = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "GET" && path.startsWith("/v1/apps?")) return { data: [{ id: "app-1", attributes: { bundleId: "com.ashatlas.game" } }] };
    if (method === "GET" && path === "/v1/builds/ios-22") return { data: { id: "ios-22",
      attributes: { version: "22", processingState: "VALID", expired: false } } };
    if (method === "GET" && path === "/v1/builds/ios-22/app") return { data: { id: "app-1" } };
    if (method === "GET" && path === "/v1/builds/ios-22/preReleaseVersion") return { data: {
      attributes: { platform: "IOS", version: "1.2.0" } } };
    if (method === "GET" && path === "/v1/builds/ios-22/buildBetaDetail") return { data: {
      attributes: { internalBuildState: attached ? "IN_BETA_TESTING" : "READY_FOR_BETA_TESTING" } } };
    if (method === "GET" && path.startsWith("/v1/apps/app-1/betaGroups?")) return { data: [{ id: "internal-1",
      attributes: { isInternalGroup: true, name: "Ash Internal" } }] };
    if (method === "GET" && path.startsWith("/v1/betaGroups/internal-1/builds?")) return {
      data: attached ? [{ id: "ios-22" }] : [] };
    if (method === "POST" && path === "/v1/betaGroups/internal-1/relationships/builds") { attached = true; return {}; }
    throw new Error(`unexpected Apple request ${method} ${path}`);
  };
  const prepared = await verifyTestFlightTesterStore({ apple }, release,
    { kind: "testflight", group_type: "internal", group_id: "internal-1" },
    { allowMutations: false, activate: false });
  assert.equal(prepared.observation.available, false);
  assert.equal(prepared.observation.prepared, true);
  assert.equal(calls.filter((entry) => entry.method === "POST").length, 0);
  const result = await verifyTestFlightTesterStore({ apple }, release,
    { kind: "testflight", group_type: "internal", group_id: "internal-1" }, { allowMutations: true });
  assert.equal(result.observation.available, true);
  assert.equal(result.observation.group_type, "internal");
  assert.equal(calls.filter((entry) => entry.method === "POST").length, 1);
});

test("internal TestFlight availability rejects unresolved export compliance even with exact group identity", async () => {
  const release = { platform: "ios", uploadAttempted: true, artifactSha256: "b".repeat(64),
    marketingVersion: "1.2.0", build: 22, storeBuildId: "ios-22" };
  const calls = [];
  const apple = async (method, path) => {
    calls.push({ method, path });
    if (method === "GET" && path.startsWith("/v1/apps?")) return { data: [{ id: "app-1", attributes: { bundleId: "com.ashatlas.game" } }] };
    if (method === "GET" && path === "/v1/builds/ios-22") return { data: { id: "ios-22",
      attributes: { version: "22", processingState: "VALID", expired: false } } };
    if (method === "GET" && path === "/v1/builds/ios-22/app") return { data: { id: "app-1" } };
    if (method === "GET" && path === "/v1/builds/ios-22/preReleaseVersion") return { data: {
      attributes: { platform: "IOS", version: "1.2.0" } } };
    if (method === "GET" && path.startsWith("/v1/apps/app-1/betaGroups?")) return { data: [{ id: "internal-1",
      attributes: { isInternalGroup: true, name: "Ash Internal" } }] };
    if (method === "GET" && path.startsWith("/v1/betaGroups/internal-1/builds?")) return { data: [] };
    if (method === "GET" && path === "/v1/builds/ios-22/buildBetaDetail") return { data: {
      attributes: { internalBuildState: "MISSING_EXPORT_COMPLIANCE" } } };
    throw new Error(`unexpected Apple request ${method} ${path}`);
  };
  await assert.rejects(verifyTestFlightTesterStore({ apple }, release,
    { kind: "testflight", group_type: "internal", group_id: "internal-1" },
    { allowMutations: true, activate: true }), /export compliance/u);
  assert.equal(calls.some((entry) => entry.method === "POST"), false);
});

test("external TestFlight preparation submits review without attaching the public group", async () => {
  let reviewState = null;
  let externalBuildState = "READY_FOR_BETA_SUBMISSION";
  const calls = [];
  const release = { platform: "ios", uploadAttempted: true, artifactSha256: "b".repeat(64),
    marketingVersion: "1.2.0", build: 22, storeBuildId: "ios-22" };
  const apple = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "GET" && path.startsWith("/v1/apps?")) return { data: [{ id: "app-1" }] };
    if (method === "GET" && path === "/v1/builds/ios-22") return { data: { id: "ios-22",
      attributes: { version: "22", processingState: "VALID", expired: false } } };
    if (method === "GET" && path === "/v1/builds/ios-22/app") return { data: { id: "app-1" } };
    if (method === "GET" && path === "/v1/builds/ios-22/preReleaseVersion") return { data: {
      attributes: { platform: "IOS", version: "1.2.0" } } };
    if (method === "GET" && path.startsWith("/v1/apps/app-1/betaGroups?")) return { data: [{ id: "public-1",
      attributes: { isInternalGroup: false, publicLinkEnabled: true,
        publicLink: "https://testflight.apple.com/join/Example" } }] };
    if (method === "GET" && path.startsWith("/v1/betaGroups/public-1/builds?")) return { data: [] };
    if (method === "GET" && path === "/v1/builds/ios-22/buildBetaDetail") return { data: {
      attributes: { externalBuildState } } };
    if (method === "GET" && path.startsWith("/v1/betaAppReviewSubmissions?")) {
      return { data: reviewState ? [{ id: "review-22", attributes: { betaReviewState: reviewState } }] : [] };
    }
    if (method === "POST" && path === "/v1/betaAppReviewSubmissions") {
      reviewState = "WAITING_FOR_REVIEW";
      return { data: [{ id: "review-22" }] };
    }
    throw new Error(`unexpected Apple request ${method} ${path}`);
  };
  const destination = { kind: "testflight", group_type: "external", group_id: "public-1",
    public_link: "https://testflight.apple.com/join/Example" };
  const prepared = await verifyTestFlightTesterStore({ apple }, release, destination,
    { allowMutations: true, activate: false, allowReviewSubmission: true });
  assert.equal(prepared.pending, true);
  assert.equal(prepared.observation.prepared, true);
  assert.equal(prepared.observation.available, false);
  assert.equal(calls.filter((entry) => entry.method === "POST" && entry.path.includes("betaAppReview")).length, 1);
  assert.equal(calls.filter((entry) => entry.method === "POST" && entry.path.includes("betaGroups")).length, 0);

  reviewState = "APPROVED";
  externalBuildState = "BETA_APPROVED";
  const approved = await verifyTestFlightTesterStore({ apple }, release, destination,
    { allowMutations: true, activate: false, allowReviewSubmission: true });
  assert.equal(approved.pending, false);
  assert.equal(approved.observation.prepared, true);
  assert.equal(approved.observation.available, false);
  assert.equal(calls.filter((entry) => entry.method === "POST" && entry.path.includes("betaGroups")).length, 0);
});

test("external TestFlight review response loss resumes from the candidate review state", async () => {
  let reviewState = null;
  let responseLost = false;
  const calls = [];
  const release = { platform: "ios", uploadAttempted: true, artifactSha256: "b".repeat(64),
    marketingVersion: "1.2.0", build: 22, storeBuildId: "ios-22" };
  const apple = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "GET" && path.startsWith("/v1/apps?")) return { data: [{ id: "app-1" }] };
    if (method === "GET" && path === "/v1/builds/ios-22") return { data: { id: "ios-22",
      attributes: { version: "22", processingState: "VALID", expired: false } } };
    if (method === "GET" && path === "/v1/builds/ios-22/app") return { data: { id: "app-1" } };
    if (method === "GET" && path === "/v1/builds/ios-22/preReleaseVersion") return { data: {
      attributes: { platform: "IOS", version: "1.2.0" } } };
    if (method === "GET" && path.startsWith("/v1/apps/app-1/betaGroups?")) return { data: [{ id: "public-1",
      attributes: { isInternalGroup: false, publicLinkEnabled: true,
        publicLink: "https://testflight.apple.com/join/Example" } }] };
    if (method === "GET" && path.startsWith("/v1/betaGroups/public-1/builds?")) return { data: [] };
    if (method === "GET" && path === "/v1/builds/ios-22/buildBetaDetail") return { data: {
      attributes: { externalBuildState: "READY_FOR_BETA_SUBMISSION" } } };
    if (method === "GET" && path.startsWith("/v1/betaAppReviewSubmissions?")) {
      return { data: reviewState ? [{ id: "review-22", attributes: { betaReviewState: reviewState } }] : [] };
    }
    if (method === "POST" && path === "/v1/betaAppReviewSubmissions") {
      reviewState = "WAITING_FOR_REVIEW";
      if (!responseLost) {
        responseLost = true;
        throw new Error("simulated response loss after review submission");
      }
      return { data: [{ id: "review-22" }] };
    }
    throw new Error(`unexpected Apple request ${method} ${path}`);
  };
  const destination = { kind: "testflight", group_type: "external", group_id: "public-1",
    public_link: "https://testflight.apple.com/join/Example" };
  await assert.rejects(verifyTestFlightTesterStore({ apple }, release, destination,
    { allowMutations: true, activate: false, allowReviewSubmission: true }), /response loss/u);
  const resumed = await verifyTestFlightTesterStore({ apple }, release, destination,
    { allowMutations: true, activate: false, allowReviewSubmission: true });
  assert.equal(resumed.pending, true);
  assert.equal(resumed.observation.status, "WAITING_FOR_REVIEW");
  assert.equal(calls.filter((entry) => entry.method === "POST" && entry.path === "/v1/betaAppReviewSubmissions").length, 1);
});

test("Google pre-health verification observes the exact bundle without assigning internal", async () => {
  let internal = { track: "internal", releases: [
    { name: "t1251 (72)", status: "draft", versionCodes: ["72"] },
    { name: "t1250 (71)", status: "completed", versionCodes: ["71"] }] };
  let internalLifecycle = [{ track: "internal", releaseLifecycleState: "RELEASE_LIFECYCLE_STATE_DRAFT",
    activeArtifacts: [{ versionCode: "72" }] }, { track: "internal", releaseLifecycleState: "RELEASE_LIFECYCLE_STATE_PUBLISHED",
    activeArtifacts: [{ versionCode: "71" }] }];
  const calls = [];
  const clients = { mutable: false, google: async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "POST" && path === `${GP}/edits`) return { id: "edit-prepared" };
    if (method === "GET" && path.endsWith("/tracks")) return { tracks: [internal] };
    if (method === "GET" && path.endsWith("/bundles")) return { bundles: [{ versionCode: 72, sha256: "b".repeat(64) }] };
    if (method === "GET" && path.endsWith("/apks")) return { apks: [] };
    if (method === "GET" && path.endsWith("/internal/releases")) return { releases: internalLifecycle };
    if (method === "DELETE") return {};
    throw new Error(`unexpected ${method} ${path}`);
  } };
  const result = await verifyGoogleTesterStore(clients, {
    uploadAttempted: true, artifactSha256: candidate.artifact_sha256, build: candidate.build,
    marketingVersion: candidate.marketing_version, storeBuildId: candidate.store_build_id,
    generation: candidate.generation
  }, candidate.tester_destination, { activate: false });
  assert.equal(result.observation.prepared, true);
  assert.equal(result.observation.available, false);
  assert.equal(calls.some((entry) => entry.method === "PUT"), false);
});

test("first Google internal assignment creates the tester track and waits on its published lifecycle", async () => {
  let internal = null;
  let lifecycle = [];
  const calls = [];
  const clients = { mutable: true, google: async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "POST" && path === `${GP}/edits`) return { id: `edit-${calls.length}` };
    if (method === "GET" && path.endsWith("/tracks")) return { tracks: [...(internal ? [internal] : [])] };
    if (method === "GET" && path.endsWith("/bundles")) return { bundles: [{ versionCode: 72, sha256: "b".repeat(64) }] };
    if (method === "GET" && path.endsWith("/apks")) return { apks: [] };
    if (method === "GET" && path.endsWith("/internal/releases")) return { releases: lifecycle };
    if (method === "PUT" && path.endsWith("/tracks/internal")) {
      internal = body;
      lifecycle = [{ track: "internal", releaseLifecycleState: "RELEASE_LIFECYCLE_STATE_PUBLISHED",
        activeArtifacts: [{ versionCode: "72" }] }];
      return body;
    }
    if (method === "POST" && path.endsWith(":commit")) return {};
    if (method === "DELETE") return {};
    throw new Error(`unexpected ${method} ${path}`);
  } };
  const result = await verifyGoogleTesterStore(clients, {
    uploadAttempted: true, artifactSha256: candidate.artifact_sha256, build: candidate.build,
    marketingVersion: candidate.marketing_version, storeBuildId: candidate.store_build_id,
    generation: candidate.generation
  }, candidate.tester_destination);
  assert.equal(result.observation.available, true);
  assert.equal(internal.releases[0].versionCodes[0], "72");
  assert.equal(calls.filter((entry) => entry.method === "PUT").length, 1);
});

test("Google internal rejects an unrelated concurrent release assignment", async () => {
  const calls = [];
  const clients = { mutable: true, google: async (method, path) => {
    calls.push({ method, path });
    if (method === "POST" && path === `${GP}/edits`) return { id: "edit-ambiguous" };
    if (method === "GET" && path.endsWith("/tracks")) return { tracks: [{ track: "internal", releases: [
      { name: "old", status: "completed", versionCodes: ["71"] },
      { name: "candidate", status: "completed", versionCodes: ["72"] }
    ] }] };
    if (method === "GET" && path.endsWith("/bundles")) return { bundles: [{ versionCode: 72, sha256: "b".repeat(64) }] };
    if (method === "GET" && path.endsWith("/apks")) return { apks: [] };
    if (method === "GET" && path.endsWith("/internal/releases")) return { releases: [] };
    if (method === "DELETE") return {};
    throw new Error(`unexpected Google request ${method} ${path}`);
  } };
  await assert.rejects(verifyGoogleTesterStore(clients, {
    uploadAttempted: true, artifactSha256: candidate.artifact_sha256, build: candidate.build,
    marketingVersion: candidate.marketing_version, storeBuildId: candidate.store_build_id,
    generation: candidate.generation
  }, candidate.tester_destination), /multiple active release assignments/u);
  assert.equal(calls.some((entry) => entry.method === "PUT"), false);
});
