import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { allowedRequest, appleList, appleSnapshot as readAppleSnapshot, createClients, googleSnapshot, selectExternalGroup, number, googlePath as GP } from "./store-api.mjs";
import { assertIdentity, assertLiveServerCompatibility, googlePublished, promoteGoogle, promoteApple } from "./open-beta.mjs";
import { reserveBuilds, releaseUnusedReservation, transitionRelease } from "./registry.mjs";
import { promotionEvidence } from "./test-evidence.mjs";

const seed = () => JSON.parse(readFileSync(new URL("../../config/mobile-release-registry.seed.json", import.meta.url)));
const request = { releaseId: "beta-test", platforms: ["ios", "android"], marketingVersions: { ios: "1.1.0", android: "1.1.0" },
  generation: "t1210", sourceSha: "a".repeat(40), protocolMin: 3, protocolMax: 3, now: "2026-09-19T00:00:00Z",
  releaseMode: "open-beta", remoteMaximum: { ios: 20, android: 70 } };
const internal = (platform = "android") => {
  const release = { ...reserveBuilds(seed(), request).reservations[platform],
  uploadAttempted: true, uploaded: true, processed: true, internal: true,
  artifactSha256: "b".repeat(64), storeBuildId: platform === "ios" ? "apple-build" : "71" };
  return { ...release, ...promotionEvidence(release) };
};
const group = { id: "external-group", attributes: { name: "Ash Atlas Public", isInternalGroup: false,
  publicLinkEnabled: true, publicLink: "https://testflight.apple.com/join/Example" } };
const internalGroup = { id: "internal-group", attributes: { name: "Ash Atlas Internal", isInternalGroup: true,
  publicLinkEnabled: null, publicLink: null } };

test("remote history raises independent permanent floors; releasing unused cannot reclaim historical numbers", () => {
  const result = reserveBuilds(seed(), request);
  assert.deepEqual(result.allocations, { ios: 21, android: 71 });
  const released = releaseUnusedReservation(result.registry, "beta-test:android");
  assert.equal(released.nextBuild.android, 71);
  assert.equal(released.buildFloor.android, 71);
  assert.deepEqual(reserveBuilds(result.registry, request).allocations, result.allocations);
  assert.throws(() => reserveBuilds(result.registry, { ...request, releaseMode: "internal" }), /cannot be reused/);
  assert.throws(() => reserveBuilds(seed(), { ...request, remoteMaximum: undefined }), /remote history/);
  assert.throws(() => number("1.2"), /integer/);
});

test("new milestones are monotone, platform scoped, and require verified receipts", () => {
  let { registry } = reserveBuilds(seed(), request);
  assert.throws(() => transitionRelease(registry, "beta-test:android", { milestones: { google_open_submitted: true } }), /smoke evidence/);
  registry = transitionRelease(registry, "beta-test:android", { uploadAttempted: true, uploaded: true, processed: true,
    internal: true, artifactSha256: "b".repeat(64), storeBuildId: "71", receiptUrl: "https://example.test/receipt" });
  registry = transitionRelease(registry, "beta-test:android", promotionEvidence(registry.releases.at(-1)));
  registry = transitionRelease(registry, "beta-test:android", { milestones: { google_open_submitted: true } });
  assert.throws(() => transitionRelease(registry, "beta-test:android", { milestones: { google_open_submitted: false } }), /invalid milestone/);
  assert.throws(() => transitionRelease(registry, "beta-test:android", { milestones: { ios_beta_review_submitted: true } }), /iOS/);
  assert.throws(() => transitionRelease(registry, "beta-test:android", { milestones: { open_beta_complete: true } }), /verification/);
  registry = transitionRelease(registry, "beta-test:android", { open: true, milestones: { google_open_verified: true, open_beta_complete: true } });
  assert.equal(registry.releases.at(-1).milestones.google_open_submitted, true);
});

test("both internal receipts and exact source/version are mandatory", () => {
  const env = { RELEASE_ID: "beta-test", GENERATION: "t1210", SOURCE_SHA: "a".repeat(40), IOS_MARKETING_VERSION: "1.1.0", ANDROID_MARKETING_VERSION: "1.1.0" };
  assertIdentity({ ios: internal("ios"), android: internal() }, env);
  assert.throws(() => assertIdentity({ ios: internal("ios"), android: { ...internal(), internal: false } }, env), /verified internal/);
  assert.throws(() => assertIdentity({ ios: internal("ios"), android: internal() }, { ...env, GENERATION: "t1209" }), /mismatch/);
});

test("promotion rechecks each exact candidate against the live server before store writes", async () => {
  const reservations = { ios: internal("ios"), android: internal() };
  const calls = [];
  const fetcher = async (url) => {
    calls.push(String(url));
    const query = new URL(url).searchParams;
    return { ok: true, status: 200, json: async () => ({
      contractVersion: 1,
      platform: query.get("platform"),
      version: query.get("version"),
      build: query.get("build"),
      hardMinimum: { version: "0.0.0", build: 0 },
      wsMin: 3,
      wsMax: 3,
      serverSha: "e".repeat(40),
      status: "supported"
    }) };
  };
  await assertLiveServerCompatibility(reservations, { MOBILE_COMPATIBILITY_SERVER_URL: "https://playashatlas.com" }, fetcher);
  assert.equal(calls.length, 2);
  await assert.rejects(assertLiveServerCompatibility(reservations, {}, async (url) => ({
    ok: true,
    json: async () => ({
      contractVersion: 1,
      platform: new URL(url).searchParams.get("platform"),
      version: new URL(url).searchParams.get("version"),
      build: new URL(url).searchParams.get("build"),
      hardMinimum: { version: "0.0.0", build: 0 },
      wsMin: 4,
      wsMax: 4,
      serverSha: "e".repeat(40),
      status: "required"
    })
  })), /protocol|requires/u);
});

test("promotion accepts a newer compatible server while retaining the recorded upload proof", async () => {
  const proof = { serverSha: "e".repeat(40), serverProtocol: { min: 3, max: 3 }, hardMinimum: { version: "0.0.0", build: 0 } };
  const reservations = { ios: { ...internal("ios"), serverCompatibility: proof },
    android: { ...internal(), serverCompatibility: proof } };
  const fetcher = async (url) => {
    const query = new URL(url).searchParams;
    return { ok: true, status: 200, json: async () => ({
      contractVersion: 1, platform: query.get("platform"), version: query.get("version"), build: query.get("build"),
      hardMinimum: proof.hardMinimum, wsMin: 3, wsMax: 3, serverSha: "f".repeat(40), status: "supported"
    }) };
  };
  await assertLiveServerCompatibility(reservations, {}, fetcher);
  assert.deepEqual(reservations.ios.serverCompatibility, proof);
  assert.deepEqual(reservations.android.serverCompatibility, proof);
});

test("endpoint allowlist makes Production, App Store submissions, metadata and cross-app writes impossible", () => {
  for (const mutable of [true, false]) {
    for (const track of ["production", "alpha", "beta/../production", "beta%2f..%2fproduction"]) {
      assert.equal(allowedRequest("google", "PUT", `${GP}/edits/123/tracks/${track}`, mutable), false);
    }
    for (const path of ["/v1/appStoreVersionSubmissions", "/v1/reviewSubmissions", "/v1/apps/app", "/v1/betaGroups/group", "/v1/betaAppLocalizations/id"]) {
      assert.equal(allowedRequest("apple", "POST", path, mutable), false);
      assert.equal(allowedRequest("apple", "PATCH", path, mutable), false);
    }
    assert.equal(allowedRequest("google", "PUT", `${GP.replace("com.ashatlas.game", "com.other")}/edits/123/tracks/beta`, mutable), false);
  }
  assert.equal(allowedRequest("google", "PUT", `${GP}/edits/123/tracks/internal`, true), true);
  assert.equal(allowedRequest("google", "PUT", `${GP}/edits/123/tracks/internal`, false), false);
  assert.equal(allowedRequest("google", "PUT", `${GP}/edits/123/tracks/beta`, true), true);
  assert.equal(allowedRequest("google", "POST", `${GP}/edits/123:commit`, false), false);
  assert.equal(allowedRequest("apple", "POST", "/v1/betaAppReviewSubmissions", false), false);
});

test("Apple pagination follows all builds and rejects redirects/loops", async () => {
  const values = await appleList(async (_, path) => path.includes("page=2") ? { data: [{ id: "old-high" }] } :
    { data: [{ id: "new-low" }], links: { next: "https://api.appstoreconnect.apple.com/v1/builds?page=2" } }, "/v1/builds");
  assert.equal(values.length, 2);
  await assert.rejects(appleList(async () => ({ data: [], links: { next: "https://evil.test/v1/builds" } }), "/v1/builds"), /origin/);
  await assert.rejects(appleList(async () => ({ data: [], links: { next: "/v1/builds" } }), "/v1/builds"), /pagination/);
});

test("existing public link is preserved; multiple/disabled/internal groups fail closed", () => {
  assert.equal(selectExternalGroup([group]).id, group.id);
  const another = { ...group, id: "other" };
  assert.throws(() => selectExternalGroup([group, another]), /exactly one/);
  assert.equal(selectExternalGroup([group, another], group.id).attributes.publicLink, group.attributes.publicLink);
  assert.throws(() => selectExternalGroup([{ ...group, attributes: { ...group.attributes, publicLinkEnabled: false } }]), /exactly one/);
});

function googleMock({ assigned = false, published = false, maximum = 71, fingerprint = "b".repeat(64), failure,
  lifecycleDenied = false } = {}) {
  const calls = [];
  let beta = { track: "beta", releases: [{ status: "completed", versionCodes: [assigned ? "71" : "1"] }] };
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (failure && path.endsWith(failure)) throw new Error("simulated interruption");
    if (method === "POST" && path === `${GP}/edits`) return { id: "123" };
    if (method === "DELETE" || path.endsWith(":commit")) return {};
    if (method === "PUT") { beta = body; return body; }
    if (path.endsWith("/bundles")) return { bundles: [{ versionCode: maximum, sha256: fingerprint }] };
    if (path.endsWith("/apks")) return { apks: [] };
    if (path.endsWith("/tracks")) return { tracks: [beta, { track: "internal", releases: [{ status: "completed", versionCodes: ["71"] }] }, { track: "production", releases: [{ status: "completed", versionCodes: ["1"] }] }] };
    if (path.endsWith("/beta/releases") && lifecycleDenied) {
      throw new Error(`google GET ${GP}/tracks/beta/releases failed: HTTP 403; reconcile before retrying`);
    }
    if (path.endsWith("/beta/releases")) return { releases: [{ track: "beta", activeArtifacts: [{ versionCode: Number(beta.releases[0].versionCodes[0]) }],
      releaseLifecycleState: published ? "RELEASE_LIFECYCLE_STATE_PUBLISHED" : "RELEASE_LIFECYCLE_STATE_IN_REVIEW" }] };
    if (path.endsWith("/releases")) return { releases: [] };
    throw new Error(`Unexpected mock request: ${method} ${path}`);
  };
  return { api, calls };
}

test("Google inspection deletes its edit even on failure and includes remote APK history", async () => {
  const mock = googleMock({ failure: "/bundles" });
  await assert.rejects(googleSnapshot(mock.api), /interruption/);
  assert.equal(mock.calls.at(-1).method, "DELETE");
  assert.ok(!mock.calls.some((c) => c.path.endsWith(":commit")));
  const good = googleMock();
  const snapshot = await googleSnapshot((method, path, body) => path.endsWith("/apks") ? { apks: [{ versionCode: 88 }] } : good.api(method, path, body));
  assert.equal(snapshot.maximum, 88);
  assert.ok(good.calls.some((c) => c.path.endsWith("/tracks/beta/releases")));
  assert.ok(!good.calls.some((c) => c.path.endsWith("/tracks/production/releases")));
});

test("Google assigned/in-review is pending, never falsely serving", async () => {
  const mock = googleMock({ assigned: true });
  const patches = [];
  assert.equal((await promoteGoogle(mock.api, internal(), async (_, p) => patches.push(p))).pending, true);
  assert.equal(patches.length, 0);
  assert.ok(!mock.calls.some((c) => c.method === "PUT"));
});

test("Google lifecycle denial forbids promotion writes and journals no submission", async () => {
  const mock = googleMock({ lifecycleDenied: true });
  const patches = [];
  await assert.rejects(promoteGoogle(mock.api, internal(), async (_, patch) => patches.push(patch)), /unreadable/);
  assert.equal(patches.length, 0);
  assert.ok(!mock.calls.some((c) => c.method === "PUT" || c.path.endsWith(":commit")));
});

test("Google unknown, partial, superseded and missing lifecycle evidence cannot mutate beta", async () => {
  for (const response of [{}, { releases: [], nextPageToken: "more" }, { releases: [] },
    { releases: [{ track: "beta", releaseLifecycleState: "UNKNOWN", activeArtifacts: [{ versionCode: 1 }] }] },
    { releases: [{ track: "beta", releaseLifecycleState: "RELEASE_LIFECYCLE_STATE_PUBLISHED", activeArtifacts: [{ versionCode: 9 }] }] },
    { releases: [{ track: "beta", releaseLifecycleState: "RELEASE_LIFECYCLE_STATE_PUBLISHED", activeArtifacts: [] }] }]) {
    const mock = googleMock({ published: true });
    const patches = [];
    await assert.rejects(promoteGoogle((method, path, body) => path.endsWith("/beta/releases") ? response : mock.api(method, path, body),
      internal(), async (_, patch) => patches.push(patch)), /lifecycle|artifact evidence/);
    assert.equal(patches.length, 0);
    assert.ok(!mock.calls.some((c) => c.method === "PUT" || c.path.endsWith(":commit")));
  }
});

test("Google exact PUBLISHED build reconciles without another promotion", async () => {
  const mock = googleMock({ assigned: true, published: true });
  const patches = [];
  assert.equal((await promoteGoogle(mock.api, internal(), async (_, p) => patches.push(p))).pending, false);
  assert.equal(patches.at(-1).milestones.google_open_verified, true);
  assert.ok(!mock.calls.some((c) => c.method === "PUT"));
});

test("Google promotes only beta, journals intent first, commits and verifies", async () => {
  const mock = googleMock({ published: true });
  const patches = [];
  const result = await promoteGoogle(mock.api, internal(), async (_, p) => {
    if (p.milestones.google_open_submitted) assert.ok(!mock.calls.some((c) => c.method === "PUT") || p.open);
    patches.push(p);
  });
  assert.equal(result.pending, false);
  assert.equal(mock.calls.filter((c) => c.method === "PUT").length, 1);
  assert.ok(mock.calls.filter((c) => c.method === "PUT").every((c) => c.path.endsWith("/tracks/beta") && c.body.track === "beta"));
  assert.equal(patches.at(-1).open, true);
});

test("Google refuses hash mismatch, overtaken build, and superseding production fallback", async () => {
  await assert.rejects(promoteGoogle(googleMock({ fingerprint: "c".repeat(64) }).api, internal(), async () => {}), /fingerprint/);
  const s = await googleSnapshot(googleMock({ assigned: true, published: true }).api);
  s.tracks.find((t) => t.track === "production").releases[0].versionCodes = ["72"];
  assert.throws(() => googlePublished(s, internal()), /supersede/);
  const mock = googleMock({ published: true });
  await assert.rejects(promoteGoogle((method, path, body) => path.endsWith("/apks") ? { apks: [{ versionCode: 99 }] } : mock.api(method, path, body), internal(), async () => {}), /higher Google build/);
  assert.ok(!mock.calls.some((c) => c.method === "PUT"));
});

function appleMock({ review, state = "READY_FOR_BETA_SUBMISSION", audience = "APP_STORE_ELIGIBLE", attached = false } = {}) {
  const calls = [];
  const build = { id: "apple-build", attributes: { version: "21", processingState: "VALID", expired: false,
    buildAudienceType: audience, usesNonExemptEncryption: false } };
  const api = async (method, path) => {
    calls.push({ method, path });
    if (method === "POST") { if (path.endsWith("/relationships/builds")) { attached = true; state = "IN_BETA_TESTING"; } return {}; }
    if (path.startsWith("/v1/apps/app/betaGroups")) return { data: [group, internalGroup] };
    if (path === "/v1/builds/apple-build") return { data: build };
    if (path.endsWith("/app")) return { data: { id: "app" } };
    if (path.endsWith("/preReleaseVersion")) return { data: { attributes: { version: "1.1.0", platform: "IOS" } } };
    if (path.startsWith("/v1/betaGroups/internal-group/builds")) return { data: [build] };
    if (path.includes("betaBuildLocalizations")) return { data: [{ attributes: { whatsNew: "Test this build" } }] };
    if (path.endsWith("/buildBetaDetail")) return { data: { attributes: { externalBuildState: state } } };
    if (path.startsWith("/v1/betaAppReviewSubmissions")) return { data: review ? [{ id: "review", attributes: { betaReviewState: review } }] : [] };
    if (path === "/v1/betaGroups/external-group") return { data: group };
    if (path.startsWith("/v1/betaGroups/external-group/builds")) return { data: attached ? [build] : [] };
    throw new Error(`Unexpected mock request: ${method} ${path}`);
  };
  return { api, calls };
}
const appleSnapshot = { metadataReady: true, appId: "app", externalGroup: { id: group.id, publicLink: group.attributes.publicLink } };
process.env.ASH_ATLAS_TESTFLIGHT_INTERNAL_GROUP = "Ash Atlas Internal";

test("Apple internal-only builds fail before any write", async () => {
  const mock = appleMock({ audience: "INTERNAL_ONLY" });
  await assert.rejects(promoteApple(mock.api, internal("ios"), appleSnapshot, async () => {}), /Internal Only/);
  assert.ok(mock.calls.every((c) => c.method === "GET"));
});

test("Apple review pending reconciles without duplicate submission or attachment", async () => {
  for (const review of ["WAITING_FOR_REVIEW", "IN_REVIEW"]) {
    const mock = appleMock({ review, state: "IN_BETA_REVIEW" });
    const patches = [];
    assert.equal((await promoteApple(mock.api, internal("ios"), appleSnapshot, async (_, p) => patches.push(p))).pending, true);
    assert.equal(patches.at(-1).milestones.ios_beta_review_pending, true);
    assert.ok(mock.calls.every((c) => c.method === "GET"));
  }
});

test("Apple rejection and unknown compliance fail closed", async () => {
  await assert.rejects(promoteApple(appleMock({ review: "REJECTED" }).api, internal("ios"), appleSnapshot, async () => {}), /rejected/);
  await assert.rejects(promoteApple(appleMock({ state: "MISSING_EXPORT_COMPLIANCE" }).api, internal("ios"), appleSnapshot, async () => {}), /compliance/);
  await assert.rejects(promoteApple(appleMock().api, internal("ios"), { ...appleSnapshot, metadataReady: false }, async () => {}), /incomplete/);
});

test("Apple submits review once and never attaches an unapproved build", async () => {
  const mock = appleMock();
  const patches = [];
  assert.equal((await promoteApple(mock.api, internal("ios"), appleSnapshot, async (_, p) => patches.push(p))).pending, true);
  assert.deepEqual(mock.calls.filter((c) => c.method === "POST").map((c) => c.path), ["/v1/betaAppReviewSubmissions"]);
  assert.equal(patches.at(-1).milestones.ios_beta_review_pending, true);
});

test("Apple ambiguous interrupted submission refuses resubmission", async () => {
  const mock = appleMock();
  await assert.rejects(promoteApple(mock.api, { ...internal("ios"), milestones: { ios_beta_review_submitted: true } }, appleSnapshot, async () => {}), /ambiguous submission/);
  assert.ok(mock.calls.every((c) => c.method === "GET"));
});

test("Apple approved exact build attaches existing group and verifies preserved public link", async () => {
  const mock = appleMock({ review: "APPROVED", state: "BETA_APPROVED" });
  const patches = [];
  const result = await promoteApple(mock.api, internal("ios"), appleSnapshot, async (_, p) => patches.push(p));
  assert.equal(result.pending, false);
  assert.equal(result.publicLink, group.attributes.publicLink);
  assert.deepEqual(mock.calls.filter((c) => c.method === "POST").map((c) => c.path), ["/v1/betaGroups/external-group/relationships/builds"]);
  assert.equal(patches.at(-1).externalApproved, true);
});

test("Apple already distributed build reconciles without any mutation", async () => {
  const mock = appleMock({ review: "APPROVED", state: "IN_BETA_TESTING", attached: true });
  assert.equal((await promoteApple(mock.api, internal("ios"), appleSnapshot, async () => {})).pending, false);
  assert.ok(mock.calls.every((c) => c.method === "GET"));
});

test("real HTTP wrapper denies production body, unowned edit commit, and inspection mutations before transport", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const env = { GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64: Buffer.from(JSON.stringify({ client_email: "test@example.test",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }) })).toString("base64") };
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => url.includes("oauth2") ? { access_token: "mock-token" } : { id: "123" } };
  };
  const inspect = await createClients({ env, fetcher });
  await inspect.google("POST", `${GP}/edits`, {});
  await assert.rejects(inspect.google("POST", `${GP}/edits/123:commit`, {}), /denied/);
  const client = await createClients({ mutable: true, env, fetcher });
  await assert.rejects(client.google("POST", `${GP}/edits/123:commit`, {}), /without this process/);
  await client.google("POST", `${GP}/edits`, {});
  await assert.rejects(client.google("PUT", `${GP}/edits/123/tracks/beta`, { track: "production", releases: [] }), /testing-track artifact/);
  assert.ok(!calls.some((c) => c.options.method === "PUT" || c.url.endsWith(":commit")));
});

test("store failures identify only the allowlisted route and never emit protected response bodies", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const secret = "never-emit-this-google-response";
  const env = { GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64: Buffer.from(JSON.stringify({ client_email: "test@example.test",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }) })).toString("base64") };
  const fetcher = async (url) => url.includes("oauth2")
    ? { ok: true, status: 200, json: async () => ({ access_token: "mock-token" }) }
    : { ok: false, status: 403, json: async () => ({ error: { message: secret } }) };
  const clients = await createClients({ env, fetcher });
  await assert.rejects(clients.google("POST", `${GP}/edits`, {}), (error) => {
    assert.match(error.message, new RegExp(`${GP}/edits failed: HTTP 403`, "u"));
    assert.doesNotMatch(error.message, new RegExp(secret, "u"));
    return true;
  });
});

test("Apple remote snapshot finds highest build across versions and redacts review credentials", async () => {
  const reviewSecret = "do-not-emit-review-secret";
  const snapshot = await readAppleSnapshot(async (_, path) => {
    if (path.startsWith("/v1/apps?")) return { data: [{ id: "app", attributes: { bundleId: "com.ashatlas.game" } }] };
    if (path.startsWith("/v1/builds?")) return { data: [{ id: "older-high", attributes: { version: "100" } }, { id: "newer-low", attributes: { version: "3" } }] };
    if (path.includes("betaGroups?")) return { data: [group] };
    if (path.includes("betaAppLocalizations?")) return { data: [{ attributes: { description: "Test Ash Atlas", feedbackEmail: "test@example.test" } }] };
    if (path.endsWith("betaAppReviewDetail")) return { data: { attributes: {
      contactFirstName: "Test", contactLastName: "Test", contactPhone: "test", contactEmail: "test@example.test",
      demoAccountRequired: true, demoAccountName: "review", demoAccountPassword: reviewSecret
    } } };
    if (path.endsWith("betaLicenseAgreement")) return { data: { id: "license" } };
    if (path.includes("/betaGroups/external-group/builds")) return { data: [{ id: "older-high" }] };
    throw new Error("unexpected mock request");
  });
  assert.equal(snapshot.maximum, 100);
  assert.equal(snapshot.metadataReady, true);
  assert.equal(snapshot.externalGroup.publicLink, group.attributes.publicLink);
  assert.ok(!JSON.stringify(snapshot).includes(reviewSecret));
});
