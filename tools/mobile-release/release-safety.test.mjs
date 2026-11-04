import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createClients, inspectStores, verifyInternalStore } from "./store-api.mjs";
import { reserveBuilds, transitionRelease, validateRegistry, validateInternalSmokeEvidence } from "./registry.mjs";
import { smokeEvidence, promotionEvidence, artifactEvidence } from "./test-evidence.mjs";
import { cleanupJob } from "./job-temp.mjs";
import { ANDROID_ALLOWED_PERMISSIONS, validateAndroidPermissions, validateBundledBuild, validateCapacitor, validateFirebaseResource, validateIos } from "./verify-artifact.mjs";

const seed = () => JSON.parse(readFileSync(new URL("../../config/mobile-release-registry.seed.json", import.meta.url)));
const request = { releaseId: "safety-test", platforms: ["ios", "android"], marketingVersions: { ios: "1.1.0", android: "1.1.0" },
  generation: "t1222", sourceSha: "a".repeat(40), protocolMin: 3, protocolMax: 3, now: "2026-09-19T00:00:00Z",
  releaseMode: "open-beta", remoteMaximum: { ios: 20, android: 70 } };
function internal(platform) {
  let { registry, reservations } = reserveBuilds(seed(), request);
  registry = transitionRelease(registry, reservations[platform].reservationId, { uploadAttempted: true, uploaded: true,
    processed: true, internal: true, artifactSha256: "b".repeat(64), storeBuildId: platform === "ios" ? "apple-build" : "71",
    receiptUrl: "https://example.test/receipt" });
  return { registry, release: registry.releases.find((r) => r.reservationId === reservations[platform].reservationId) };
}

test("historical schema v1 loads but cannot promote without device proof; identity and applicability are exact", () => {
  validateRegistry(seed());
  const { registry, release } = internal("android");
  assert.throws(() => transitionRelease(registry, release.reservationId, { open: true }), /smoke evidence/);
  for (const pushMode of ["enabled", "disabled"]) {
    const proof = smokeEvidence(release, pushMode);
    const artifactValidation = artifactEvidence(release, pushMode);
    validateInternalSmokeEvidence({ ...release, artifactValidation, internalSmokeEvidence: proof });
    assert.throws(() => validateInternalSmokeEvidence({ ...release, artifactValidation, internalSmokeEvidence: smokeEvidence(release, pushMode === "enabled" ? "disabled" : "enabled") }), /push mode must match/);
    for (const field of ["platform", "sourceSha", "artifactSha256", "storeBuildId", "marketingVersion", "build", "result", "schemaVersion", "checklistVersion", "pushMode"]) {
      assert.throws(() => validateInternalSmokeEvidence({ ...release, artifactValidation, internalSmokeEvidence: { ...proof, [field]: "wrong" } }));
    }
    for (const key of Object.keys(proof.checks)) {
      assert.throws(() => validateInternalSmokeEvidence({ ...release, artifactValidation, internalSmokeEvidence: { ...proof, checks: { ...proof.checks, [key]: "skipped" } } }), /checklist/);
    }
  }
  const evidenced = transitionRelease(registry, release.reservationId, promotionEvidence(release));
  assert.equal(evidenced.releases.at(-1).downloadTested, false);
  assert.throws(() => transitionRelease(evidenced, release.reservationId, { internalSmokeEvidence: smokeEvidence(release, "enabled") }), /immutable/);
  const original = evidenced.releases.at(-1);
  const resumed = transitionRelease(evidenced, release.reservationId, { promotionExecutions: [...original.promotionExecutions,
    { ...original.promotionExecutions[0], toolSha: "e".repeat(40), receiptUrl: "https://github.com/test/repo/actions/runs/124" }] });
  assert.equal(resumed.releases.at(-1).promotionApproval.toolSha, "d".repeat(40));
  assert.throws(() => transitionRelease(resumed, release.reservationId, { promotionExecutions: original.promotionExecutions }), /append-only/);
});

test("iOS prerelease marketing versions fail before number reservation while Android versions remain independent", () => {
  const registry = seed();
  assert.throws(() => reserveBuilds(registry, { ...request, marketingVersions: { ...request.marketingVersions, ios: "1.1.0-beta.1" } }), /numeric/);
  assert.deepEqual(registry, seed());
  assert.equal(reserveBuilds(registry, { ...request, marketingVersions: { ...request.marketingVersions, android: "1.1.0-beta.1" } }).reservations.android.marketingVersion, "1.1.0-beta.1");
});

test("selected-platform clients ignore other credentials; internal Apple inspection needs no external metadata", async () => {
  const clients = await createClients({ platforms: ["ios"], env: { GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64: "not-a-key" }, fetcher: () => { throw Error("No token request allowed"); } });
  assert.ok(clients.apple);
  const calls = [];
  const snapshot = await inspectStores({ google: () => { throw Error("No Android access allowed"); }, apple: async (_, path) => {
    calls.push(path);
    if (path.startsWith("/v1/apps?")) return { data: [{ id: "app", attributes: { bundleId: "com.ashatlas.game" } }] };
    if (path.startsWith("/v1/builds?")) return { data: [{ id: "build", attributes: { version: "21" } }] };
    throw Error("Unexpected external metadata access");
  } }, undefined, { platforms: ["ios"], includeBeta: false });
  assert.equal(snapshot.apple.maximum, 21);
  assert.equal(snapshot.google, undefined);
  assert.equal(calls.length, 2);
});

test("internal Android reconciliation proves the exact bundle hash and never reads external lifecycle", async () => {
  const { release } = internal("android");
  let hash = release.artifactSha256;
  const calls = [];
  const google = async (method, path) => {
    calls.push({ method, path });
    if (method === "POST") return { id: "snapshot" };
    if (method === "DELETE") return {};
    if (path.endsWith("/tracks")) return { tracks: [{ track: "internal", releases: [{ status: "completed", versionCodes: ["71"] }] }] };
    if (path.endsWith("/bundles")) return { bundles: [{ versionCode: 71, sha256: hash }] };
    if (path.endsWith("/apks")) return { apks: [] };
    throw Error("Unexpected external read");
  };
  assert.equal(await verifyInternalStore({ google }, release), "71");
  hash = "c".repeat(64);
  await assert.rejects(verifyInternalStore({ google }, release), /fingerprint/);
  assert.ok(!calls.some((c) => c.method === "PUT" || c.path.endsWith(":commit")));
});

test("internal Apple reconciliation rejects app, platform, marketing version and store ID substitution", async () => {
  const { release } = internal("ios");
  for (const mismatch of [null, "app", "platform", "version", "id", "attachment"]) {
    const build = { id: mismatch === "id" ? "other-build" : release.storeBuildId,
      attributes: { version: String(release.build), processingState: "VALID", expired: false } };
    const apple = async (method, path) => {
      assert.equal(method, "GET");
      if (path.startsWith("/v1/apps?")) return { data: [{ id: "app", attributes: { bundleId: "com.ashatlas.game" } }] };
      if (path.startsWith("/v1/builds?")) return { data: [build] };
      if (path.endsWith("/app")) return { data: { id: mismatch === "app" ? "other" : "app" } };
      if (path.endsWith("/preReleaseVersion")) return { data: { attributes: {
        version: mismatch === "version" ? "1.2.0" : release.marketingVersion, platform: mismatch === "platform" ? "MAC_OS" : "IOS" } } };
      if (path.includes("/betaGroups?")) return { data: [{ id: "internal", attributes: { name: "Internal", isInternalGroup: true } }] };
      if (path.includes("/betaGroups/internal/builds")) return { data: mismatch === "attachment" ? [] : [build] };
      throw Error(`Unexpected path ${path}`);
    };
    if (!mismatch) assert.equal(await verifyInternalStore({ apple }, release, "Internal"), release.storeBuildId);
    else await assert.rejects(verifyInternalStore({ apple }, release, "Internal"), /identity|ID mismatch|attached/);
  }
});

test("final IPA validation binds exported identity, signing profile and optional APNs capability", () => {
  const env = { VITE_NATIVE_APP_VERSION: "1.1.0", VITE_NATIVE_APP_BUILD: "21", APPLE_TEAM_ID: "TEAM" };
  const info = { CFBundleIdentifier: "com.ashatlas.game", CFBundleShortVersionString: "1.1.0", CFBundleVersion: "21",
    CFBundleURLTypes: [{ CFBundleURLSchemes: ["com.ashatlas.game"] }] };
  const entitlements = { "application-identifier": "TEAM.com.ashatlas.game", "com.apple.developer.team-identifier": "TEAM", "get-task-allow": false,
    "aps-environment": "production", "com.apple.developer.devicecheck.appattest-environment": "production",
    "com.apple.developer.associated-domains": ["applinks:playashatlas.com"],
    "com.apple.developer.applesignin": ["Default"] };
  const profile = { TeamIdentifier: ["TEAM"], Entitlements: entitlements, ExpirationDate: "2099-01-01T00:00:00Z" };
  validateIos(info, entitlements, profile, env);
  assert.throws(() => validateIos(info, { ...entitlements, "com.apple.developer.devicecheck.appattest-environment": "development" }, profile, env), /App Attest/);
  assert.throws(() => validateIos(info, { ...entitlements, "com.apple.developer.associated-domains": [] }, profile, env), /associated domains/);
  assert.throws(() => validateIos(info, { ...entitlements, "aps-environment": "development" }, profile, env), /APNs/);
  assert.throws(() => validateIos({ ...info, CFBundleVersion: "20" }, entitlements, profile, env), /identity/);
  assert.throws(() => validateIos(info, { ...entitlements, "get-task-allow": true }, profile, env), /entitlements/);
  assert.throws(() => validateIos(info, entitlements, { ...profile, ProvisionedDevices: ["device"] }, env), /distribution/);
  assert.throws(() => validateIos(info, entitlements, { ...profile, Entitlements: { ...entitlements, "aps-environment": undefined } },
    { ...env, VITE_NATIVE_PUSH_ENABLED: "true" }), /APNs/);
  validateIos(info, { ...entitlements, "aps-environment": "production" }, { ...profile, Entitlements: { ...entitlements, "aps-environment": "production" } }, { ...env, VITE_NATIVE_PUSH_ENABLED: "true" });
  assert.throws(() => validateCapacitor({ appId: "com.ashatlas.game", server: { url: "http://localhost:5173" } }), /configuration/);
  const marker = { schemaVersion: 1, platform: "ios", version: "1.1.0", build: 21, pushMode: "disabled" };
  validateBundledBuild(marker, "ios", env);
  assert.throws(() => validateBundledBuild({ ...marker, pushMode: "enabled" }, "ios", env), /marker/);
});

test("final AAB permissions are an exact allowlist that always includes game location", () => {
  validateAndroidPermissions([...ANDROID_ALLOWED_PERMISSIONS]);
  validateAndroidPermissions(["android.permission.INTERNET", "android.permission.ACCESS_COARSE_LOCATION", "android.permission.ACCESS_FINE_LOCATION"]);
  assert.throws(() => validateAndroidPermissions([...ANDROID_ALLOWED_PERMISSIONS, "android.permission.QUERY_ALL_PACKAGES"]), /QUERY_ALL_PACKAGES/);
  assert.throws(() => validateAndroidPermissions(["android.permission.INTERNET", "android.permission.ACCESS_FINE_LOCATION"]), /COARSE/);
});

test("final Firebase validation requires the exact named default resource, not a substring elsewhere", () => {
  const dump = 'Package \'com.ashatlas.game\':\n0x7f010001 - string/google_app_id\n\t(default) - [STR] "1:123:android:abc"\n';
  validateFirebaseResource(dump, "google_app_id", "1:123:android:abc");
  assert.throws(() => validateFirebaseResource(dump, "google_app_id", "123"), /differs/);
  assert.throws(() => validateFirebaseResource(dump.replace("google_app_id", "other"), "google_app_id", "1:123:android:abc"), /differs/);
  assert.throws(() => validateFirebaseResource(dump + '\t(fr) - [STR] "another-project"\n', "google_app_id", "1:123:android:abc"), /differs/);
});

test("dry-run, internal upload and reconciliation intents cannot enter the promotion CLI", () => {
  for (const [intent, dry, approved] of [["promote-existing", "true", "true"], ["new-upload", "false", "true"],
    ["reconcile-only", "false", "true"], ["promote-existing", "false", "false"]]) {
    assert.throws(() => execFileSync(process.execPath, [fileURLToPath(new URL("./open-beta.mjs", import.meta.url)), "promote"], {
      env: { ...process.env, RELEASE_MODE: "open-beta", GITHUB_REF: "refs/heads/integration/test",
        PROMOTION_INTENT: intent, DRY_RUN: dry, PROMOTION_APPROVED: approved, APP_STORE_CONNECT_KEY_P8_BASE64: "invalid-not-accessed" },
      stdio: ["ignore", "pipe", "pipe"]
    }), (error) => /Explicit approved second-stage promotion/u.test(error.stderr.toString()));
  }
});

test("signing validation cleanup removes copied and original Gradle bundles and preserves unrelated files", () => {
  const parent = mkdtempSync(join(tmpdir(), "mobile-cleanup-artifacts-"));
  const directory = mkdtempSync(join(parent, "ash-atlas-mobile-"));
  const marker = join(parent, "quarantine.json");
  try {
    writeFileSync(join(directory, "owner.json"), JSON.stringify({ run: "1", job: "android" }));
    for (const path of ["artifacts/android", "android/app/build/outputs/bundle/release"]) {
      mkdirSync(join(parent, path), { recursive: true });
      writeFileSync(join(parent, path, "app-release.aab"), "signed fixture");
    }
    writeFileSync(join(parent, "preserved.txt"), "unrelated");
    cleanupJob({ ASH_ATLAS_JOB_TEMP: directory, RUNNER_TEMP: parent, GITHUB_WORKSPACE: parent,
      GITHUB_RUN_ID: "1", GITHUB_JOB: "android", SIGNING_VALIDATION: "true" }, () => { throw Error("No keychain access allowed"); }, marker);
    assert.ok(!existsSync(join(parent, "artifacts/android")));
    assert.ok(!existsSync(join(parent, "android/app/build/outputs/bundle/release")));
    assert.ok(existsSync(join(parent, "preserved.txt")));
  } finally { rmSync(parent, { recursive: true }); }
});

test("cleanup restores host configuration, attempts every recovery step, and leaves a blocking receipt on failure", () => {
  const parent = mkdtempSync(join(tmpdir(), "mobile-cleanup-test-"));
  try {
    for (const fail of [false, true]) {
      const directory = mkdtempSync(join(parent, "ash-atlas-mobile-"));
      const marker = join(parent, "quarantine.json");
      writeFileSync(join(directory, "owner.json"), JSON.stringify({ run: "1", job: "ios" }));
      writeFileSync(join(directory, "original-keychains.txt"), '    "/original/login.keychain-db"\n');
      writeFileSync(join(directory, "original-default-keychain.txt"), '"/original/login.keychain-db"\n');
      writeFileSync(join(directory, "signing.keychain-db"), "fake temporary signing keychain");
      writeFileSync(marker, JSON.stringify({ directory }));
      const calls = [];
      const run = (args) => {
        calls.push(args);
        if (args[0] === "delete-keychain") { rmSync(join(directory, "signing.keychain-db")); return ""; }
        if (fail && args.includes("-s")) throw Error("simulated security failure");
        return '"/original/login.keychain-db"\n';
      };
      const env = { ASH_ATLAS_JOB_TEMP: directory, RUNNER_TEMP: parent, GITHUB_RUN_ID: "1", GITHUB_JOB: "ios" };
      if (fail) {
        assert.throws(() => cleanupJob(env, run, marker), /restore keychain search list, restore default keychain/);
        assert.ok(existsSync(directory) && existsSync(marker));
        assert.equal(JSON.parse(readFileSync(marker)).failures.length, 2);
      } else { cleanupJob(env, run, marker); assert.ok(!existsSync(directory) && !existsSync(marker)); }
      assert.ok(calls.some((args) => args[0] === "delete-keychain"));
      assert.ok(calls.some((args) => args[0] === "default-keychain"));
    }
  } finally { rmSync(parent, { recursive: true }); }
});
