import { createHash, sign } from "node:crypto";

import { productionCandidateFingerprint, sha256Json } from "./production-registry.mjs";
import { appleList, number, PACKAGE, requireState } from "./store-api.mjs";

const APPLE_PUBLISHED_STATES = new Set(["READY_FOR_SALE", "READY_FOR_DISTRIBUTION"]);
const APPLE_APPROVED_REVIEW_STATES = new Set(["APPROVED", "COMPLETE"]);
const GOOGLE_RELEASE_LIST_MAX = 20;
const GOOGLE_MANAGED_PUBLISHING_ATTESTATION_MAX_AGE_MS = 15 * 60 * 1000;
const GOOGLE_CONSOLE_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,255}$/u;

export const GOOGLE_MANAGED_PUBLISHING_ATTESTATION_KIND =
  "ash-atlas-google-managed-publishing-attestation";

export const APPLE_PRODUCTION_BASE = "https://api.appstoreconnect.apple.com";
export const GOOGLE_PRODUCTION_BASE = "https://androidpublisher.googleapis.com";
export const PRODUCTION_GOOGLE_PATH = `/androidpublisher/v3/applications/${PACKAGE}`;

// This adapter has a distinct credential namespace and endpoint allowlist. The beta
// adapter intentionally cannot call any of these routes, even when mutable=true.
export function allowedProductionRequest(store, method, path, mutable) {
  if (store === "apple") {
    if (method === "GET") return /^\/v1\/(?:apps|builds|appStoreVersions|appStoreVersionLocalizations|appStoreVersionPhasedReleases|reviewSubmissions)(?:\/|\?|$)/u.test(path);
    if (!mutable) return false;
    return (method === "POST" && [
      "/v1/appStoreVersions",
      "/v1/reviewSubmissions",
      "/v1/reviewSubmissionItems",
      "/v1/appStoreVersionReleaseRequests",
      "/v1/appStoreVersionPhasedReleases"
    ].includes(path)) ||
      (method === "PATCH" && (
        /^\/v1\/appStoreVersions\/[A-Za-z0-9-]+\/relationships\/build$/u.test(path) ||
        /^\/v1\/appStoreVersionPhasedReleases\/[A-Za-z0-9-]+$/u.test(path) ||
        /^\/v1\/reviewSubmissions\/[A-Za-z0-9-]+$/u.test(path)));
  }
  if (store !== "google" || !path.startsWith(`${PRODUCTION_GOOGLE_PATH}/`)) return false;
  const suffix = path.slice(PRODUCTION_GOOGLE_PATH.length).split("?", 1)[0];
  if (method === "GET") return /^\/edits\/[A-Za-z0-9-]+(?:\/(?:tracks(?:\/production)?|bundles|apks|listings))?$/u.test(suffix) ||
    /^\/tracks\/production\/releases$/u.test(suffix);
  if (method === "POST" && suffix === "/edits") return true;
  if (method === "DELETE" && /^\/edits\/[A-Za-z0-9-]+$/u.test(suffix)) return true;
  return mutable && ((method === "PUT" && /^\/edits\/[A-Za-z0-9-]+\/tracks\/production$/u.test(suffix)) ||
    (method === "POST" && /^\/edits\/[A-Za-z0-9-]+:commit$/u.test(suffix)));
}

export async function createProductionClients({ mutable = false, env = process.env, fetcher = fetch, platforms = ["ios", "android"] } = {}) {
  requireState(platforms.length > 0 && platforms.every((platform) => ["ios", "android"].includes(platform)),
    "Invalid production store platforms");
  if (mutable) requireState(env.ASH_ATLAS_PRODUCTION_MUTATION === "true",
    "production mutation capability is disabled; set the production environment gate explicitly");
  const now = Math.floor(Date.now() / 1000);
  const appleToken = platforms.includes("ios") && env.APP_STORE_CONNECT_PRODUCTION_KEY_P8_BASE64 ? jwt(
    { alg: "ES256", kid: env.APP_STORE_CONNECT_PRODUCTION_KEY_ID, typ: "JWT" },
    { iss: env.APP_STORE_CONNECT_PRODUCTION_ISSUER_ID, iat: now, exp: now + 1200, aud: "appstoreconnect-v1" },
    { key: Buffer.from(env.APP_STORE_CONNECT_PRODUCTION_KEY_P8_BASE64, "base64"), dsaEncoding: "ieee-p1363" }, "sha256") : null;
  let googleToken;
  if (platforms.includes("android") && env.GOOGLE_PLAY_PRODUCTION_SERVICE_ACCOUNT_JSON_BASE64) {
    const credential = JSON.parse(Buffer.from(env.GOOGLE_PLAY_PRODUCTION_SERVICE_ACCOUNT_JSON_BASE64, "base64"));
    const assertion = jwt({ alg: "RS256", typ: "JWT" }, {
      iss: credential.client_email,
      scope: "https://www.googleapis.com/auth/androidpublisher",
      aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600
    }, credential.private_key, "RSA-SHA256");
    const tokenResponse = await fetcher("https://oauth2.googleapis.com/token", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(30000),
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion })
    });
    requireState(tokenResponse.ok, `Google production authentication failed: HTTP ${tokenResponse.status}`);
    googleToken = (await tokenResponse.json()).access_token;
    requireState(typeof googleToken === "string", "Missing Google production access token");
  }
  const ownedEdits = new Set();
  const request = async (store, method, path, body) => {
    requireState(allowedProductionRequest(store, method, path, mutable),
      "Store request denied by production-only endpoint policy");
    const token = store === "apple" ? appleToken : googleToken;
    requireState(token, `Missing protected production ${store} credentials`);
    const requestPath = path.split("?", 1)[0];
    if (store === "google" && ["PUT", "DELETE"].includes(method)) {
      const editId = requestPath.slice(`${PRODUCTION_GOOGLE_PATH}/edits/`.length).split("/")[0];
      requireState(ownedEdits.has(editId), "Cannot mutate a production edit not created by this process");
      if (method === "PUT") {
        requireState(body?.track === "production" && Array.isArray(body.releases),
          "Production Google track assignment is required");
        for (const release of body.releases) {
          requireState(["draft", "inProgress", "halted", "completed"].includes(release.status),
            "Invalid Google production release status");
          for (const versionCode of release.versionCodes ?? []) number(versionCode);
        }
      }
    }
    if (store === "google" && requestPath.endsWith(":commit")) {
      const editId = requestPath.slice(`${PRODUCTION_GOOGLE_PATH}/edits/`.length, -":commit".length);
      requireState(ownedEdits.has(editId), "Cannot commit an unowned production edit");
    }
    if (store === "apple" && method === "POST" && path === "/v1/appStoreVersions") {
      requireState(body?.data?.type === "appStoreVersions" && body.data.attributes?.platform === "IOS" &&
        body.data.attributes.releaseType === "MANUAL" && body.data.relationships?.app?.data?.type === "apps",
      "Apple production version must be an iOS manual-release version");
    }
    const response = await fetcher(`${store === "apple" ? APPLE_PRODUCTION_BASE : GOOGLE_PRODUCTION_BASE}${path}`, {
      method, redirect: "error", signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    requireState(response.ok, `${store} production ${method} ${path} failed: HTTP ${response.status}; reconcile before retrying`);
    const result = response.status === 204 ? {} : await response.json();
    if (store === "google" && method === "POST" && requestPath === `${PRODUCTION_GOOGLE_PATH}/edits`) {
      requireState(/^[A-Za-z0-9-]+$/u.test(result.id), "Invalid Google production edit identity");
      ownedEdits.add(result.id);
    }
    return result;
  };
  return {
    apple: (method, path, body) => request("apple", method, path, body),
    google: (method, path, body) => request("google", method, path, body)
  };
}

export async function productionGoogleSnapshot(api) {
  const edit = await api("POST", `${PRODUCTION_GOOGLE_PATH}/edits`, {});
  requireState(/^[A-Za-z0-9-]+$/u.test(edit.id), "Invalid Google production edit identity");
  try {
    const tracks = (await api("GET", `${PRODUCTION_GOOGLE_PATH}/edits/${edit.id}/tracks`)).tracks;
    const bundles = (await api("GET", `${PRODUCTION_GOOGLE_PATH}/edits/${edit.id}/bundles`)).bundles ?? [];
    const apks = (await api("GET", `${PRODUCTION_GOOGLE_PATH}/edits/${edit.id}/apks`)).apks ?? [];
    requireState(Array.isArray(tracks) && new Set(tracks.map((track) => track.track)).size === tracks.length,
      "Google production track snapshot is incomplete or ambiguous");
    const editProductionTrack = tracks.find((track) => track.track === "production") ?? { track: "production", releases: [] };
    requireState(Array.isArray(editProductionTrack.releases), "Google production releases are invalid");
    const liveResponse = await api("GET", `${PRODUCTION_GOOGLE_PATH}/tracks/production/releases`);
    requireState(Array.isArray(liveResponse.releases), "Google production lifecycle response is incomplete");
    // The Android Publisher API caps this collection at twenty entries and
    // provides no pagination token. A full page is therefore not proof that
    // the returned history is complete. Keep the fact on the fresh snapshot
    // so a replay cannot use an omitted lifecycle entry as authorization.
    const productionLifecycleComplete = liveResponse.releases.length < GOOGLE_RELEASE_LIST_MAX;
    const productionLifecycle = liveResponse.releases.map(normalizeGoogleLifecycleRelease);
    const managedPublishing = liveResponse.managedPublishing ?? liveResponse.managed_publishing ?? null;
    if (managedPublishing !== null) requireState(managedPublishing === true,
      "ACTION_REQUIRED_GOOGLE_PLAY: fresh Play Console managed-publishing verification is not enabled");
    const codes = [...bundles, ...apks].map((artifact) => number(artifact.versionCode));
    for (const track of tracks) for (const release of track.releases ?? []) {
      for (const versionCode of release.versionCodes ?? []) codes.push(number(versionCode));
    }
    for (const release of productionLifecycle) for (const versionCode of release.versionCodes) codes.push(number(versionCode));
    requireState(codes.length > 0, "Google production history is empty; reconcile the store before choosing a build");
    return {
      packageName: PACKAGE,
      maximum: Math.max(...codes),
      tracks,
      bundles,
      apks,
      // Keep the edit-shaped track for all writes. The separate releases.list
      // endpoint returns ReleaseSummary objects and is only authoritative for
      // what is actually available on the production track.
      productionTrack: editProductionTrack,
      productionLifecycle,
      productionLifecycleComplete,
      managedPublishing,
      firstLaunch: !editProductionTrack.releases.some((release) => ["inProgress", "halted", "completed"].includes(release.status)) &&
        !productionLifecycle.some((release) => release.lifecycleState === "RELEASE_LIFECYCLE_STATE_PUBLISHED"),
      observedAt: new Date().toISOString()
    };
  } finally {
    await api("DELETE", `${PRODUCTION_GOOGLE_PATH}/edits/${edit.id}`);
  }
}

function normalizeGoogleLifecycleRelease(release) {
  const lifecycleState = release?.releaseLifecycleState;
  requireState(typeof release?.releaseName === "string" && release.releaseName.length > 0,
    "Google production lifecycle release identity is incomplete");
  requireState(typeof release?.track === "string" && release.track === "production",
    "Google production lifecycle track identity is invalid");
  requireState([
    "RELEASE_LIFECYCLE_STATE_UNSPECIFIED",
    "RELEASE_LIFECYCLE_STATE_DRAFT",
    "RELEASE_LIFECYCLE_STATE_NOT_SENT_FOR_REVIEW",
    "RELEASE_LIFECYCLE_STATE_IN_REVIEW",
    "RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED",
    "RELEASE_LIFECYCLE_STATE_NOT_APPROVED",
    "RELEASE_LIFECYCLE_STATE_PUBLISHED"
  ].includes(lifecycleState), "Google production lifecycle state is invalid or unavailable");
  const artifacts = release.activeArtifacts ?? [];
  requireState(Array.isArray(artifacts), "Google production lifecycle artifacts are invalid");
  return {
    name: release.releaseName,
    track: release.track,
    versionCodes: artifacts.map((artifact) => String(number(artifact?.versionCode))),
    lifecycleState
  };
}

export async function productionAppleSnapshot(api) {
  const apps = await appleList(api, `/v1/apps?filter[bundleId]=${PACKAGE}&limit=200`);
  requireState(apps.length === 1 && apps[0].attributes?.bundleId === PACKAGE, "Ambiguous Apple production app identity");
  const app = apps[0];
  const builds = await appleList(api, `/v1/builds?filter[app]=${app.id}&limit=200`);
  const versions = await appleList(api, `/v1/apps/${app.id}/appStoreVersions?include=build,appStoreVersionPhasedRelease&limit=200`);
  const submissionCollection = await appleCollectionWithIncluded(api,
    `/v1/apps/${app.id}/reviewSubmissions?include=appStoreVersionForReview,items&limit=200`);
  const submissions = submissionCollection.data;
  const includedById = new Map(submissionCollection.included.map((entry) => [`${entry.type}:${entry.id}`, entry]));
  requireState(builds.length > 0, "Apple production history is empty; reconcile the store before choosing a build");
  const phaseIds = versions.map((version) => version.relationships?.appStoreVersionPhasedRelease?.data?.id).filter(Boolean);
  const phases = new Map();
  for (const phaseId of phaseIds) {
    const phase = (await api("GET", `/v1/appStoreVersionPhasedReleases/${phaseId}`)).data;
    requireState(phase?.id === phaseId && phase?.attributes?.phasedReleaseState, "Apple phased release state is incomplete");
    phases.set(phaseId, phase.attributes.phasedReleaseState);
  }
  const versionSubmissions = new Map();
  for (const submission of submissions) {
    const itemReference = submission.relationships?.items?.data?.find((entry) => entry.type === "reviewSubmissionItems");
    const item = itemReference ? (includedById.get(`${itemReference.type}:${itemReference.id}`) ?? itemReference) : null;
    const versionId = submission.relationships?.appStoreVersionForReview?.data?.id ??
      item?.relationships?.appStoreVersion?.data?.id;
    if (versionId) {
      const normalized = { id: submission.id, state: submission.attributes?.state ?? null,
        appId: submission.relationships?.app?.data?.id ?? null, itemId: item?.id ?? null };
      const prior = versionSubmissions.get(versionId);
      if (!prior || reviewStateRank(normalized.state) >= reviewStateRank(prior.state)) versionSubmissions.set(versionId, normalized);
    }
  }
  const normalizedSubmissions = submissions.map((submission) => {
    const itemReference = submission.relationships?.items?.data?.find((entry) => entry.type === "reviewSubmissionItems");
    const item = itemReference ? (includedById.get(`${itemReference.type}:${itemReference.id}`) ?? itemReference) : null;
    return { id: submission.id, state: submission.attributes?.state ?? null,
      appId: submission.relationships?.app?.data?.id ?? null,
      versionId: submission.relationships?.appStoreVersionForReview?.data?.id ??
        item?.relationships?.appStoreVersion?.data?.id ?? null,
      itemId: item?.id ?? null };
  });
  const normalizedVersions = versions.map((version) => {
    const phasedReleaseId = version.relationships?.appStoreVersionPhasedRelease?.data?.id ?? null;
    const submission = versionSubmissions.get(version.id);
    return {
      id: version.id,
      versionString: version.attributes?.versionString,
      platform: version.attributes?.platform,
      state: version.attributes?.appVersionState ?? version.attributes?.appStoreState,
      releaseType: version.attributes?.releaseType,
      buildId: version.relationships?.build?.data?.id ?? null,
      phasedReleaseId,
      phasedReleaseState: phasedReleaseId ? phases.get(phasedReleaseId) ?? null : null,
      reviewSubmissionId: submission?.id ?? null,
      reviewSubmissionState: submission?.state ?? null,
      published: APPLE_PUBLISHED_STATES.has(version.attributes?.appVersionState ?? version.attributes?.appStoreState)
    };
  });
  return {
    appId: app.id,
    bundleId: PACKAGE,
    maximum: Math.max(...builds.map((build) => number(build.attributes?.version))),
    builds: builds.map((build) => ({ id: build.id, version: build.attributes?.version,
      processingState: build.attributes?.processingState, expired: build.attributes?.expired,
      audience: build.attributes?.buildAudienceType })),
    versions: normalizedVersions,
    firstLaunch: !normalizedVersions.some((version) => version.published),
    reviewSubmissions: normalizedSubmissions,
    observedAt: new Date().toISOString()
  };
}

async function readAndValidateReviewSubmission(api, submissionId, snapshot, candidate, version, approval, { allowRejected = true } = {}) {
  requireState(typeof submissionId === "string" && submissionId.length > 0 && approval?.remoteId === submissionId,
    "Apple review submission shell identity is invalid");
  const response = await api("GET", `/v1/reviewSubmissions/${submissionId}?include=appStoreVersionForReview,items`);
  const data = response?.data;
  requireState(data?.type === "reviewSubmissions" && data.id === submissionId,
    "Apple review submission shell identity is unavailable");
  const state = data.attributes?.state;
  const rejected = ["REJECTED", "CANCELED", "CANCELLED"].includes(state);
  requireState(["READY_FOR_REVIEW", "WAITING_FOR_REVIEW", "IN_REVIEW", "APPROVED", "COMPLETE",
    "REJECTED", "CANCELED", "CANCELLED"].includes(state) && (allowRejected || !rejected),
  "Apple review submission shell state is not adoptable");
  const appReference = data.relationships?.app?.data;
  const appId = appReference?.id ?? null;
  requireState(appReference?.type === "apps" && appId === snapshot.appId,
    "Apple review submission shell belongs to a different app or has no verified app");
  const itemReferences = data.relationships?.items?.data;
  requireState(Array.isArray(itemReferences), "Apple review submission item associations are unavailable");
  requireState(new Set(itemReferences.map((entry) => `${entry?.type}:${entry?.id}`)).size === itemReferences.length,
    "Apple review submission item associations are duplicated");
  requireState(itemReferences.length <= 1,
    "Apple review submission shell has additional item associations");
  const included = Array.isArray(response?.included) ? response.included : [];
  const submissionVersionReference = data.relationships?.appStoreVersionForReview?.data ?? null;
  if (submissionVersionReference) {
    requireState(submissionVersionReference.type === "appStoreVersions" &&
      submissionVersionReference.id === version.id,
    "Apple review submission shell is associated with a different version");
  }
  let itemId = null;
  let itemVersionId = null;
  if (itemReferences.length === 1) {
    const itemReference = itemReferences[0];
    requireState(itemReference?.type === "reviewSubmissionItems" && typeof itemReference.id === "string" &&
      itemReference.id.length > 0, "Apple review submission item identity is invalid");
    const item = included.find((entry) => entry?.type === itemReference.type && entry.id === itemReference.id) ?? itemReference;
    const itemVersionReference = item.relationships?.appStoreVersion?.data ?? null;
    requireState(itemVersionReference?.type === "appStoreVersions" && itemVersionReference.id === version.id,
      "Apple review submission shell has an unrelated item association");
    itemId = itemReference.id;
    itemVersionId = itemVersionReference.id;
  }
  const associatedVersionId = submissionVersionReference?.id ?? itemVersionId ?? null;
  requireState(!associatedVersionId || associatedVersionId === version.id,
    "Apple review submission shell is associated with a different version");
  const includedVersion = included.find((entry) => entry?.type === "appStoreVersions" && entry.id === version.id);
  if (includedVersion) {
    const versionApp = includedVersion.relationships?.app?.data;
    const versionBuild = includedVersion.relationships?.build?.data;
    requireState(!versionApp || (versionApp.type === "apps" && versionApp.id === snapshot.appId),
      "Apple review submission version belongs to a different app");
    requireState(includedVersion.attributes?.platform === "IOS" &&
      includedVersion.attributes?.versionString === candidate.marketingVersion &&
      includedVersion.attributes?.releaseType === "MANUAL",
    "Apple review submission version platform or policy is invalid");
    requireState(!versionBuild || (versionBuild.type === "builds" && versionBuild.id === candidate.storeBuildId),
      "Apple review submission version is attached to a different build");
  }
  requireState(candidate.platform === "ios" && (version.platform === undefined || version.platform === "IOS") &&
    version.releaseType === "MANUAL", "Apple review submission shell platform or version policy is invalid");
  return { id: submissionId, state, appId, versionId: associatedVersionId, itemId };
}

export function buildGoogleProductionTrack(snapshot, candidate, action) {
  assertCandidateForStore(candidate, "android");
  requireState(snapshot.packageName === PACKAGE && snapshot.productionTrack?.track === "production",
    "Google production snapshot identity is invalid");
  const existingCandidate = (snapshot.productionTrack.releases ?? []).find((release) =>
    (release.versionCodes ?? []).map(number).includes(candidate.build));
  requireState(candidate.firstLaunch === snapshot.firstLaunch ||
    (candidate.firstLaunch && existingCandidate !== undefined),
  "Google first-launch status changed since production preparation");
  if (candidate.firstLaunch) requireState(candidate.rollout.mode === "full",
    "Google first publication must use a full release; staged first publication is forbidden");
  const editLiveCodes = (snapshot.productionTrack.releases ?? [])
    .filter((release) => ["inProgress", "halted", "completed"].includes(release.status))
    .flatMap((release) => (release.versionCodes ?? []).map(number));
  const observedLiveCodes = (snapshot.productionLifecycle ?? [])
    .filter((release) => release.lifecycleState === "RELEASE_LIFECYCLE_STATE_PUBLISHED")
    .flatMap((release) => (release.versionCodes ?? []).map(number));
  const liveCodes = [...editLiveCodes, ...observedLiveCodes];
  if (liveCodes.length > 0) requireState(candidate.build >= Math.max(...liveCodes),
    "Google production candidate would downgrade the live production build");
  const bundle = snapshot.bundles?.find((artifact) => number(artifact.versionCode) === candidate.build);
  requireState(bundle?.sha256?.toLowerCase() === candidate.artifactSha256,
    "Google production artifact fingerprint does not match the verified AAB");
  const existing = (snapshot.productionTrack.releases ?? []).map((release) => structuredClone(release));
  const index = existing.findIndex((release) => (release.versionCodes ?? []).map(number).includes(candidate.build));
  const desired = desiredGoogleRelease(candidate, action, index >= 0 ? existing[index] : null);
  if (index >= 0) {
    requireState(existing[index].versionCodes?.map(number).includes(candidate.build), "Google production version identity mismatch");
    if (action !== "submit" && existing[index].status !== "draft") {
      const existingCountries = existing[index].countryTargeting?.countries ?? [];
      // Google omits countryTargeting from a halted release. Its approved
      // candidate is the only durable scope evidence available for a
      // pause->resume retry; an inProgress release still must carry and match
      // its remote scope so a real widening cannot be adopted.
      const recoveredCountries = existing[index].status === "halted" &&
        !Object.prototype.hasOwnProperty.call(existing[index], "countryTargeting")
        ? candidate.countries : existingCountries;
      requireState(sameJson([...recoveredCountries].sort(), [...candidate.countries].sort()),
        "Google production country scope changed; refuse an unapproved widening");
    }
    const eligiblePriorCompleted = action === "pause" && existing[index].status === "completed" &&
      existing.some((release, releaseIndex) => releaseIndex !== index && release.status === "completed" &&
        (snapshot.productionLifecycle ?? []).some((lifecycle) => lifecycle.lifecycleState === "RELEASE_LIFECYCLE_STATE_PUBLISHED" &&
          (lifecycle.versionCodes ?? []).some((versionCode) => (release.versionCodes ?? []).map(String).includes(String(versionCode)))));
    requireState(sameStoreIdentity(existing[index], desired) &&
      allowedGoogleTransition(existing[index].status, desired.status, action, eligiblePriorCompleted),
    "Google production version identity or transition changed; reconcile manually");
    // Keep store-managed notes and update priority when reconciling a response-loss
    // retry. The operation may change only the exact rollout fields it owns.
    const merged = { ...existing[index], ...desired };
    if (desired.status !== "inProgress") delete merged.countryTargeting;
    if (![
      "inProgress", "halted"
    ].includes(desired.status)) delete merged.userFraction;
    existing[index] = merged;
  } else {
    requireState(action === "submit" || action === "release", "Google production candidate is not assigned to production");
    existing.push(desired);
  }
  if (action === "release" && desired.status === "completed") {
    // Google permits a new full release only after any older staged release is
    // halted. Preserve the older release identity and fraction, but remove
    // country targeting because it is valid only while a release is inProgress.
    for (let releaseIndex = 0; releaseIndex < existing.length; releaseIndex += 1) {
      const prior = existing[releaseIndex];
      if (releaseIndex === (index >= 0 ? index : existing.length - 1) || prior.status !== "inProgress") continue;
      requireState(Number.isFinite(prior.userFraction) && prior.userFraction > 0 && prior.userFraction < 1,
        "Google staged release cannot be halted without its prior fraction");
      const halted = { ...prior, status: "halted" };
      delete halted.countryTargeting;
      existing[releaseIndex] = halted;
    }
  }
  const before = new Set(existing.flatMap((release) => (release.versionCodes ?? []).map(String)));
  for (const release of snapshot.productionTrack.releases ?? []) for (const code of release.versionCodes ?? []) {
    requireState(before.has(String(code)), "Google production update would remove an unrelated release");
  }
  return { track: "production", releases: existing };
}

export async function submitGoogleProduction(api, snapshot, candidate, metadataPacket = null, context = null) {
  return updateGoogleProduction(api, snapshot, candidate, "submit", metadataPacket, context);
}

export function assertGoogleManagedPublishingAttestation(attestation, candidate, context, now = Date.now()) {
  requireState(candidate?.platform === "android",
    "Google managed-publishing attestation is only valid for Android production");
  requireState(context && typeof context.operationId === "string" && context.operationId.length > 0,
    "Google managed-publishing attestation must be bound to a production operation");
  requireState(context.candidateFingerprint === productionCandidateFingerprint(candidate),
    "Google managed-publishing attestation is not bound to the exact candidate");
  requireState(attestation && typeof attestation === "object" && !Array.isArray(attestation),
    "ACTION_REQUIRED_GOOGLE_PLAY: fresh managed-publishing Console attestation is required");
  requireState(attestation.schemaVersion === 1 && attestation.kind === GOOGLE_MANAGED_PUBLISHING_ATTESTATION_KIND,
    "ACTION_REQUIRED_GOOGLE_PLAY: managed-publishing Console attestation schema is invalid");
  requireState(attestation.operationId === context.operationId &&
    attestation.candidateFingerprint === context.candidateFingerprint,
  "ACTION_REQUIRED_GOOGLE_PLAY: managed-publishing Console attestation is bound to a different operation or candidate");
  requireState(attestation.packageName === PACKAGE && attestation.track === "production",
    "ACTION_REQUIRED_GOOGLE_PLAY: managed-publishing Console attestation app identity is invalid");
  requireState(typeof attestation.consoleIdentity === "string" &&
    GOOGLE_CONSOLE_IDENTITY.test(attestation.consoleIdentity),
  "ACTION_REQUIRED_GOOGLE_PLAY: managed-publishing Console identity is required");
  requireState(attestation.managedPublishing === true,
    "ACTION_REQUIRED_GOOGLE_PLAY: managed publishing is not enabled in Play Console");
  requireState(attestation.appPreviouslyAvailable === true,
    "ACTION_REQUIRED_GOOGLE_PLAY: Play Console has not attested prior app availability");
  const observedAt = Date.parse(attestation.observedAt);
  requireState(Number.isFinite(observedAt) && observedAt <= now + 60 * 1000 &&
    now - observedAt <= GOOGLE_MANAGED_PUBLISHING_ATTESTATION_MAX_AGE_MS,
  "ACTION_REQUIRED_GOOGLE_PLAY: managed-publishing Console attestation is stale or has an invalid timestamp");
  return {
    schemaVersion: 1,
    kind: GOOGLE_MANAGED_PUBLISHING_ATTESTATION_KIND,
    operationId: context.operationId,
    candidateFingerprint: context.candidateFingerprint,
    packageName: PACKAGE,
    track: "production",
    consoleIdentity: attestation.consoleIdentity,
    managedPublishing: true,
    appPreviouslyAvailable: true,
    observedAt: attestation.observedAt
  };
}

/**
 * Build an operation-bound pre-submit proof from a fresh Play response and a
 * separate Console attestation. The Publishing API does not expose the
 * managed-publishing Console toggle in the lifecycle response, so a candidate
 * policy or omitted response field cannot authorize an edit commit.
 */
export function assertGooglePreSubmitEligibility(snapshot, candidate, context) {
  requireState(context && typeof context.operationId === "string" && context.operationId.length > 0,
    "Google pre-submit verification must be bound to a production operation");
  requireState(context.candidateFingerprint === productionCandidateFingerprint(candidate),
    "Google pre-submit verification is not bound to the exact candidate");
  requireState(candidate.managedPublishing === true,
    "ACTION_REQUIRED_GOOGLE_PLAY: managed publishing must be enabled in Play Console before submission");
  const managedPublishingAttestation = assertGoogleManagedPublishingAttestation(
    context.managedPublishingAttestation, candidate, context);
  if (snapshot.managedPublishing !== null && snapshot.managedPublishing !== undefined) {
    requireState(snapshot.managedPublishing === true,
      "ACTION_REQUIRED_GOOGLE_PLAY: fresh Play Console managed-publishing verification is not enabled");
  }
  requireState((candidate.firstLaunch === false && snapshot.firstLaunch === false) ||
    managedPublishingAttestation.appPreviouslyAvailable === true,
  "ACTION_REQUIRED_GOOGLE_PLAY: the app is not eligible for managed publishing first publication");
  requireState(snapshot.productionLifecycleComplete === true,
    "ACTION_REQUIRED_GOOGLE_PLAY: Google production lifecycle history is capped; verify prior availability in Play Console before retrying");
  const published = (snapshot.productionLifecycle ?? []).filter((entry) =>
    entry.track === "production" && entry.lifecycleState === "RELEASE_LIFECYCLE_STATE_PUBLISHED");
  requireState(published.length > 0,
    "ACTION_REQUIRED_GOOGLE_PLAY: the app has no fresh prior production availability proof; first publication requires Console bootstrap");
  return {
    schemaVersion: 1,
    operationId: context.operationId,
    candidateFingerprint: context.candidateFingerprint,
    managedPublishing: true,
    appPreviouslyAvailable: managedPublishingAttestation.appPreviouslyAvailable,
    managedPublishingAttestationFingerprint: sha256Json(managedPublishingAttestation),
    lifecycleFingerprint: sha256Json(snapshot.productionLifecycle),
    observedAt: snapshot.observedAt
  };
}

export async function releaseGoogleProduction(api, snapshot, candidate, metadataPacket = null) {
  assertCandidateForStore(candidate, "android");
  requireState(snapshot.packageName === PACKAGE && snapshot.productionTrack?.track === "production",
    "Google production snapshot identity is invalid");
  if (metadataPacket) requireState(candidate.metadataHash === sha256Json(metadataPacket),
    "Google production release metadata packet changed since prepare");
  const expectedName = `${candidate.generation} (${candidate.build})`;
  const trackRelease = (snapshot.productionTrack.releases ?? []).find((release) =>
    release.name === expectedName && (release.versionCodes ?? []).map(String).includes(String(candidate.build)));
  requireState(trackRelease, "ACTION_REQUIRED_GOOGLE_PLAY: Google production candidate is not assigned to the production track");
  const lifecycleMatches = (snapshot.productionLifecycle ?? []).filter((release) =>
    release.name === expectedName && (release.versionCodes ?? []).map(String).includes(String(candidate.build)));
  requireState(lifecycleMatches.length <= 1, "Google production lifecycle identity is ambiguous; reconcile manually");
  const lifecycle = lifecycleMatches[0]?.lifecycleState;
  if (lifecycle === "RELEASE_LIFECYCLE_STATE_PUBLISHED") return { phase: "released", readOnly: true };
  if (lifecycle === "RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED") {
    throw new Error("ACTION_REQUIRED_GOOGLE_PLAY: Google Play Publishing overview -> Publish changes is required before production availability can be confirmed");
  }
  if (lifecycle === "RELEASE_LIFECYCLE_STATE_IN_REVIEW") {
    throw new Error("ACTION_REQUIRED_GOOGLE_PLAY: Google Play review is still in progress; wait for APPROVED_NOT_PUBLISHED");
  }
  if (lifecycle === "RELEASE_LIFECYCLE_STATE_NOT_APPROVED") {
    throw new Error("ACTION_REQUIRED_GOOGLE_PLAY: Google Play review was not approved; resolve the rejection in Play Console");
  }
  throw new Error("ACTION_REQUIRED_GOOGLE_PLAY: Google Play Send for review is required before production availability can be confirmed");
}

export async function advanceGoogleProduction(api, snapshot, candidate, metadataPacket = null, context = null) {
  return updateGoogleProduction(api, snapshot, candidate, "advance", metadataPacket, context);
}

export async function pauseGoogleProduction(api, snapshot, candidate, metadataPacket = null, context = null) {
  return updateGoogleProduction(api, snapshot, candidate, "pause", metadataPacket, context);
}

export async function resumeGoogleProduction(api, snapshot, candidate, metadataPacket = null, context = null) {
  return updateGoogleProduction(api, snapshot, candidate, "resume", metadataPacket, context);
}

export async function submitAppleProduction(api, snapshot, candidate, metadataPacket = null, context = null) {
  assertCandidateForStore(candidate, "ios");
  assertAppleCountryScope(candidate);
  requireState(snapshot.bundleId === PACKAGE && candidate.firstLaunch === snapshot.firstLaunch,
    "Apple first-launch status or app identity changed since production preparation");
  if (metadataPacket) assertAppleMetadataCandidateBinding(candidate, metadataPacket);
  const build = snapshot.builds.find((entry) => entry.id === candidate.storeBuildId && String(entry.version) === String(candidate.build));
  requireState(build?.processingState === "VALID" && build.expired === false && build.audience === "APP_STORE_ELIGIBLE",
    "Apple production build is not the exact processed App Store eligible artifact");
  const matching = snapshot.versions.filter((version) => version.versionString === candidate.marketingVersion);
  requireState(matching.length <= 1, "Apple production version identity is ambiguous");
  let version = matching[0];
  if (!version) {
    const created = await remoteStep(api, context, "apple.version.create", "POST", "/v1/appStoreVersions", {
      data: { type: "appStoreVersions", attributes: { platform: "IOS", versionString: candidate.marketingVersion, releaseType: "MANUAL" },
        relationships: { app: { data: { type: "apps", id: snapshot.appId } } } }
    });
    version = normalizeAppleVersion(created.data);
  }
  requireState(version.releaseType === "MANUAL", "Apple production version must use MANUAL release; refusing to reuse an automatic version");
  requireState(!version.buildId || version.buildId === candidate.storeBuildId,
    "Apple production version is attached to a different build");
  if (metadataPacket) {
    // A fresh version has no pre-submit metadata resource in the initial
    // snapshot.  Verify the exact packet after the version create response is
    // observed, before attaching a build or creating review resources.
    const metadataSnapshot = matching.length === 0
      ? { ...snapshot, versions: [...snapshot.versions, version] }
      : snapshot;
    await verifyAppleProductionMetadata(api, metadataSnapshot, candidate, metadataPacket);
  }
  let reviewState = snapshot.reviewSubmissions?.find((submission) => submission.id === version.reviewSubmissionId) ??
    snapshot.reviewSubmissions?.filter((submission) => submission.versionId === version.id).at(-1);
  if (reviewState?.id && !["REJECTED", "CANCELED", "CANCELLED"].includes(reviewState.state)) {
    reviewState = await readAndValidateReviewSubmission(api, reviewState.id, snapshot, candidate, version, {
      remoteId: reviewState.id
    });
  }
  if (!reviewState) {
    // A review-submission shell is created against the app before its first
    // item binds it to an app-store version. If that create response was lost,
    // the only safe recovery is the durable remote id or one explicitly
    // journaled, unique detached shell from this operation. A fresh caller
    // must not adopt an unrelated shell.
    const originalStep = context?.getSubstep?.("apple.review-submission.create");
    const replacementStep = context?.getSubstep?.("apple.review-submission.replacement.create");
    const journaledStep = replacementStep ?? originalStep;
    if (journaledStep?.remoteId) {
      reviewState = await readAndValidateReviewSubmission(api, journaledStep.remoteId, snapshot, candidate, version, {
        remoteId: journaledStep.remoteId
      });
    } else {
      const detached = (snapshot.reviewSubmissions ?? []).filter((submission) => !submission.versionId && !submission.itemId);
      if (detached.length > 0) {
        requireState(detached.length <= 1, "Apple review submission shell identity is ambiguous; reconcile manually");
        const adoption = context?.reviewSubmissionAdoption;
        requireState(adoption && adoption.remoteId === detached[0].id,
          "Apple review submission shell requires explicit operation-bound adoption approval");
        requireState(adoption.operationId === context?.operationId &&
          adoption.candidateFingerprint === sha256Json(candidate),
        "Apple review submission shell adoption is not bound to this operation and candidate");
        reviewState = await readAndValidateReviewSubmission(api, detached[0].id,
          snapshot, candidate, version, adoption, { allowRejected: false });
      }
    }
  }
  if (!version.buildId) {
    await remoteStep(api, context, "apple.version.build", "PATCH", `/v1/appStoreVersions/${version.id}/relationships/build`, {
      data: { type: "builds", id: candidate.storeBuildId }
    });
  }
  if (["WAITING_FOR_REVIEW", "IN_REVIEW", ...APPLE_APPROVED_REVIEW_STATES].includes(reviewState?.state)) {
    return { versionId: version.id, buildId: candidate.storeBuildId, submissionId: reviewState.id, phase: "submitted", readOnly: true };
  }
  const rejectedSubmission = ["REJECTED", "CANCELED", "CANCELLED"].includes(reviewState?.state);
  let submission = rejectedSubmission ? null : reviewState;
  const submissionStepPrefix = rejectedSubmission ? "apple.review-submission.replacement" : "apple.review-submission";
  if (!submission) {
    const createdSubmission = await remoteStep(api, context, `${submissionStepPrefix}.create`, "POST", "/v1/reviewSubmissions", {
      data: { type: "reviewSubmissions", relationships: { app: { data: { type: "apps", id: snapshot.appId } } } }
    });
    submission = { id: createdSubmission.data?.id, state: createdSubmission.data?.attributes?.state ?? null };
    requireState(typeof submission.id === "string" && submission.id.length > 0, "Apple review submission identity is missing");
  }
  const item = submission?.itemId ? { data: { id: submission.itemId } } :
    await remoteStep(api, context, `${submissionStepPrefix}.item`, "POST", "/v1/reviewSubmissionItems", {
      data: { type: "reviewSubmissionItems", relationships: {
        reviewSubmission: { data: { type: "reviewSubmissions", id: submission.id } },
        appStoreVersion: { data: { type: "appStoreVersions", id: version.id } }
      } }
    });
  await remoteStep(api, context, `${submissionStepPrefix}.submit`, "PATCH", `/v1/reviewSubmissions/${submission.id}`, {
    data: { type: "reviewSubmissions", id: submission.id, attributes: { submitted: true } }
  });
  return { versionId: version.id, buildId: candidate.storeBuildId, submissionId: submission.id,
    itemId: item.data?.id ?? null, phase: "submitted" };
}

export async function releaseAppleProduction(api, snapshot, candidate, metadataPacket = null, context = null) {
  const version = appleVersionForCandidate(snapshot, candidate);
  assertAppleCountryScope(candidate);
  if (metadataPacket) await verifyAppleProductionMetadata(api, snapshot, candidate, metadataPacket);
  requireState(!candidate.firstLaunch || candidate.rollout.mode === "manual" || candidate.rollout.mode === "full",
    "Apple first publish requires a separate manual release; phased release is update-only");
  requireState(version.state === "PENDING_DEVELOPER_RELEASE",
    "Apple release requires an approved manual version in PENDING_DEVELOPER_RELEASE; review or rejected states are not availability");
  if (!candidate.firstLaunch && candidate.rollout.mode === "staged") {
    const phase = await ensureApplePhasedPolicy(api, version, context);
    requireState(phase.state === "INACTIVE", "Apple phased policy must be verified INACTIVE before releasing the update");
  }
  await remoteStep(api, context, "apple.release-request", "POST", "/v1/appStoreVersionReleaseRequests", {
    data: { type: "appStoreVersionReleaseRequests", relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: version.id } } } }
  });
  return { versionId: version.id, phase: "released" };
}

export async function advanceAppleProduction(api, snapshot, candidate, { complete = false } = {}, metadataPacket = null, context = null) {
  const version = appleVersionForCandidate(snapshot, candidate);
  if (metadataPacket) await verifyAppleProductionMetadata(api, snapshot, candidate, metadataPacket);
  requireState(!candidate.firstLaunch, "Apple phased release is unavailable for the first publish");
  requireState(candidate.rollout.mode === "staged" || complete, "Apple only advances an update phased rollout");
  assertAppleCountryScope(candidate);
  requireState(version.phasedReleaseId, "Apple update has no phased release policy");
  const phase = await readApplePhase(api, version.phasedReleaseId);
  requireState(phase.state === "ACTIVE", "Apple phased release must be ACTIVE before it can advance");
  await remoteStep(api, context, "apple.phased-advance", "PATCH", `/v1/appStoreVersionPhasedReleases/${version.phasedReleaseId}`, {
    data: { type: "appStoreVersionPhasedReleases", id: version.phasedReleaseId,
      attributes: { phasedReleaseState: complete ? "COMPLETE" : "ACTIVE" } }
  });
  return { versionId: version.id, phase: complete ? "completed" : "released" };
}

export async function pauseAppleProduction(api, snapshot, candidate, metadataPacket = null, context = null) {
  const version = appleVersionForCandidate(snapshot, candidate);
  assertAppleCountryScope(candidate);
  if (metadataPacket) await verifyAppleProductionMetadata(api, snapshot, candidate, metadataPacket);
  requireState(!candidate.firstLaunch && version.phasedReleaseId, "Apple first publish or missing phased release cannot be paused");
  const phase = await readApplePhase(api, version.phasedReleaseId);
  requireState(phase.state === "ACTIVE", "Apple phased release must be ACTIVE before it can be paused");
  await remoteStep(api, context, "apple.phased-pause", "PATCH", `/v1/appStoreVersionPhasedReleases/${version.phasedReleaseId}`, {
    data: { type: "appStoreVersionPhasedReleases", id: version.phasedReleaseId,
      attributes: { phasedReleaseState: "PAUSED" } }
  });
  return { versionId: version.id, phase: "paused" };
}

export async function resumeAppleProduction(api, snapshot, candidate, metadataPacket = null, context = null) {
  const version = appleVersionForCandidate(snapshot, candidate);
  assertAppleCountryScope(candidate);
  if (metadataPacket) await verifyAppleProductionMetadata(api, snapshot, candidate, metadataPacket);
  requireState(candidate.rollout.mode === "staged", "Apple only resumes a staged phased rollout");
  requireState(!candidate.firstLaunch && version.phasedReleaseId, "Apple first publish or missing phased release cannot be resumed");
  const phase = await readApplePhase(api, version.phasedReleaseId);
  requireState(phase.state === "PAUSED", "Apple phased release must be PAUSED before it can be resumed");
  await remoteStep(api, context, "apple.phased-resume", "PATCH", `/v1/appStoreVersionPhasedReleases/${version.phasedReleaseId}`, {
    data: { type: "appStoreVersionPhasedReleases", id: version.phasedReleaseId,
      attributes: { phasedReleaseState: "ACTIVE" } }
  });
  return { versionId: version.id, phase: "released" };
}

async function updateGoogleProduction(api, snapshot, candidate, action, metadataPacket = null, context = null) {
  const preSubmitVerification = action === "submit"
    ? assertGooglePreSubmitEligibility(snapshot, candidate, context)
    : null;
  const edit = await remoteStep(api, context, "google.edit.create", "POST", `${PRODUCTION_GOOGLE_PATH}/edits`, {});
  let committed = false;
  let commitAttempted = false;
  try {
    const current = await productionGoogleSnapshotForEdit(api, edit.id);
    requireState(sameJson(current.productionTrack, snapshot.productionTrack),
      "Google production track changed during production action; edit abandoned");
    if (metadataPacket) await verifyGoogleProductionMetadata(api, edit.id, metadataPacket);
    const track = buildGoogleProductionTrack(snapshot, candidate, action);
    await remoteStep(api, context, "google.track.update", "PUT", `${PRODUCTION_GOOGLE_PATH}/edits/${edit.id}/tracks/production`, track);
    commitAttempted = true;
    // The Android Publisher API takes these controls as query parameters and
    // requires an empty request body. A JSON body is rejected by the real API.
    await remoteStep(api, context, "google.edit.commit", "POST",
      `${PRODUCTION_GOOGLE_PATH}/edits/${edit.id}:commit?changesNotSentForReview=false&changesInReviewBehavior=ERROR_IF_IN_REVIEW`);
    committed = true;
    return { track, phase: desiredPhase(candidate, action), ...(preSubmitVerification ? { preSubmitVerification } : {}) };
  } finally {
    // A lost commit response may have published the edit. Leave that edit for
    // reconciliation; deleting it would erase the only evidence of a remote
    // production mutation and could turn a successful commit into a false
    // no-mutation result.
    if (!committed && !commitAttempted) await api("DELETE", `${PRODUCTION_GOOGLE_PATH}/edits/${edit.id}`);
  }
}

async function verifyAppleProductionMetadata(api, snapshot, candidate, packet) {
  const matches = snapshot.versions.filter((entry) => entry.versionString === candidate.marketingVersion);
  requireState(matches.length === 1, "Apple production metadata version identity is missing or ambiguous");
  const version = matches[0];
  requireState(version.releaseType === "MANUAL", "Apple production metadata version must use MANUAL release");
  requireState(!version.buildId || version.buildId === candidate.storeBuildId,
    "Apple production metadata version is attached to a different build");
  requireState(version.id, "Apple production metadata version is not present for verification");
  const response = await api("GET", `/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations?limit=200`);
  requireState(Array.isArray(response.data), "Apple production metadata response is incomplete");
  requireState(response.data.length === packet.localizations.length, "Apple production metadata locale set changed");
  const actual = response.data.map((entry) => normalizeRemoteLocalization(entry.attributes, "locale", packet.localizations));
  requireState(sameJson(sortLocalizations(actual), sortLocalizations(packet.localizations)),
    "Apple production metadata changed since approval; refusing the store mutation");
}

function assertAppleMetadataCandidateBinding(candidate, packet) {
  requireState(packet?.platform === "ios" && packet?.marketingVersion === candidate.marketingVersion,
    "Apple production metadata packet is not bound to the exact candidate version");
  if (packet.build !== undefined) requireState(String(packet.build) === String(candidate.build),
    "Apple production metadata packet build changed since preparation");
  if (packet.storeBuildId !== undefined) requireState(String(packet.storeBuildId) === String(candidate.storeBuildId),
    "Apple production metadata packet store build changed since preparation");
  requireState(sameJson([...(packet.policy?.countries ?? [])].map(String).sort(),
    [...(candidate.countries ?? [])].map(String).sort()),
  "Apple production metadata country policy changed since preparation");
  requireState(sameJson(packet.policy?.rollout, candidate.rollout),
    "Apple production metadata rollout policy changed since preparation");
}

async function verifyGoogleProductionMetadata(api, editId, packet) {
  const response = await api("GET", `${PRODUCTION_GOOGLE_PATH}/edits/${editId}/listings`);
  requireState(Array.isArray(response.listings), "Google production metadata response is incomplete");
  requireState(response.listings.length === packet.localizations.length, "Google production metadata locale set changed");
  const actual = response.listings.map((entry) => normalizeRemoteLocalization(entry, "language", packet.localizations));
  requireState(sameJson(sortLocalizations(actual), sortLocalizations(packet.localizations)),
    "Google production metadata changed since approval; refusing the store mutation");
}

async function appleCollectionWithIncluded(api, path) {
  const data = [];
  const included = [];
  const visited = new Set();
  while (path) {
    requireState(!visited.has(path) && visited.size < 1000, "Invalid Apple pagination");
    visited.add(path);
    const page = await api("GET", path);
    requireState(Array.isArray(page.data), "Missing Apple collection");
    data.push(...page.data);
    if (Array.isArray(page.included)) included.push(...page.included);
    const next = page.links?.next;
    if (!next) {
      path = null;
      continue;
    }
    const url = new URL(next, "https://api.appstoreconnect.apple.com");
    requireState(url.origin === "https://api.appstoreconnect.apple.com", "Untrusted Apple pagination origin");
    path = `${url.pathname}${url.search}`;
  }
  return { data, included };
}

function normalizeRemoteLocalization(value, localeKey, expected) {
  const locale = value?.[localeKey];
  requireState(typeof locale === "string" && locale.length > 0, "production metadata locale is missing");
  const fields = expected.find((entry) => entry.locale === locale);
  requireState(fields, `production metadata locale ${locale} was not approved`);
  const result = { locale };
  for (const key of Object.keys(fields).filter((name) => name !== "locale")) {
    requireState(typeof value?.[key] === "string" && value[key] === fields[key],
      `production metadata field ${key} changed for ${locale}`);
    result[key] = value[key];
  }
  return result;
}

function sortLocalizations(values) {
  return values.slice().sort((left, right) => left.locale.localeCompare(right.locale));
}

async function productionGoogleSnapshotForEdit(api, editId) {
  const tracks = (await api("GET", `${PRODUCTION_GOOGLE_PATH}/edits/${editId}/tracks`)).tracks;
  const productionTrack = tracks.find((track) => track.track === "production") ?? { track: "production", releases: [] };
  return { productionTrack };
}

function desiredGoogleRelease(candidate, action, previous = null) {
  const mode = candidate.rollout.mode;
  if (action === "resume") requireState(mode === "staged", "Google only resumes a staged production rollout");
  if (action === "submit") requireState(candidate.managedPublishing === true,
    "ACTION_REQUIRED_GOOGLE_PLAY: Google managed publishing must be enabled and verified before submission");
  const status = action === "submit" ? (mode === "full" ? "completed" : "inProgress") : action === "pause" ? "halted" :
    action === "resume" ? "inProgress" : action === "advance" ? (mode === "full" ? "completed" : "inProgress") :
      mode === "full" || (candidate.firstLaunch && action === "release") ? "completed" : mode === "staged" ? "inProgress" : "draft";
  const release = { name: `${candidate.generation} (${candidate.build})`, versionCodes: [String(candidate.build)], status };
  if (status === "inProgress" || status === "halted") {
    const fraction = candidate.rollout.fraction ?? previous?.userFraction;
    // Google permits halting a completed release only when an older completed
    // release can serve as the fallback. That wire shape omits userFraction;
    // staged inProgress/halted releases still require their approved fraction.
    if (!(action === "pause" && previous?.status === "completed")) {
      requireState(Number.isFinite(fraction) && fraction > 0 && fraction < 1,
        "staged production rollout requires a fraction between zero and one");
      release.userFraction = fraction;
    }
    if (status === "inProgress" && candidate.countries.length > 0) {
      release.countryTargeting = { countries: candidate.countries, includeRestOfWorld: false };
    }
  } else if (candidate.countries.length > 0 && status === "completed") {
    requireState(false, "Google country targeting is only representable for an inProgress or halted release");
  }
  return release;
}

function desiredPhase(candidate, action) {
  if (action === "pause") return "paused";
  if (action === "submit") return "submitted";
  if (action === "resume") return "released";
  if (candidate.rollout.mode === "full" || (action === "advance" && candidate.rollout.fraction >= 1)) return "completed";
  return "released";
}

function sameStoreIdentity(existing, desired) {
  return (existing.versionCodes ?? []).map(String).join(",") === desired.versionCodes.join(",") &&
    (existing.name === undefined || existing.name === desired.name);
}

function allowedGoogleTransition(currentStatus, desiredStatus, action, eligiblePriorCompleted = false) {
  if (currentStatus === desiredStatus) return true;
  if (action === "submit") return currentStatus === "draft" && ["inProgress", "completed"].includes(desiredStatus);
  if (action === "release") return currentStatus === "draft" && ["inProgress", "completed"].includes(desiredStatus);
  if (action === "advance") return ["inProgress", "halted"].includes(currentStatus) &&
    ["inProgress", "completed"].includes(desiredStatus);
  if (action === "pause") return (currentStatus === "inProgress" ||
    (currentStatus === "completed" && eligiblePriorCompleted)) && desiredStatus === "halted";
  if (action === "resume") return currentStatus === "halted" && desiredStatus === "inProgress";
  return false;
}

function appleVersionForCandidate(snapshot, candidate) {
  const matches = snapshot.versions.filter((version) => version.versionString === candidate.marketingVersion);
  requireState(matches.length === 1, "Apple production version identity is missing or ambiguous");
  requireState(!matches[0].buildId || matches[0].buildId === candidate.storeBuildId,
    "Apple production version build identity mismatch");
  requireState(matches[0].releaseType === "MANUAL", "Apple production version must use MANUAL release");
  return matches[0];
}

function normalizeAppleVersion(data) {
  return { id: data?.id, versionString: data?.attributes?.versionString,
    state: data?.attributes?.appVersionState ?? data?.attributes?.appStoreState,
    releaseType: data?.attributes?.releaseType, buildId: data?.relationships?.build?.data?.id ?? null,
    phasedReleaseId: data?.relationships?.appStoreVersionPhasedRelease?.data?.id ?? null,
    phasedReleaseState: data?.attributes?.phasedReleaseState ?? null };
}

async function ensureApplePhasedPolicy(api, version, context = null) {
  if (version.phasedReleaseId) return readApplePhase(api, version.phasedReleaseId);
  const created = await remoteStep(api, context, "apple.phased-policy.create", "POST", "/v1/appStoreVersionPhasedReleases", {
    data: { type: "appStoreVersionPhasedReleases", attributes: {
      phasedReleaseState: "INACTIVE"
    }, relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: version.id } } } }
  });
  const phaseId = created.data?.id;
  requireState(typeof phaseId === "string" && phaseId.length > 0, "Apple phased release identity is missing");
  return readApplePhase(api, phaseId);
}

async function readApplePhase(api, phaseId) {
  const phase = (await api("GET", `/v1/appStoreVersionPhasedReleases/${phaseId}`)).data;
  requireState(phase?.id === phaseId && ["INACTIVE", "ACTIVE", "PAUSED", "COMPLETE"].includes(phase.attributes?.phasedReleaseState),
    "Apple phased release state is invalid or unavailable");
  return { id: phase.id, state: phase.attributes.phasedReleaseState };
}

function assertAppleCountryScope(candidate) {
  requireState(candidate.countries.length === 0,
    "Apple production country scope is not representable by the guarded adapter; refuse an unverified widening");
}

function assertCandidateForStore(candidate, platform) {
  requireState(candidate?.platform === platform && /^[0-9a-f]{40}$/u.test(candidate.sourceSha) &&
    candidate.acceptedSha === candidate.sourceSha &&
    /^[0-9a-f]{64}$/u.test(candidate.artifactSha256) && typeof candidate.storeBuildId === "string" &&
    candidate.storeBuildId.length > 0, `invalid ${platform} production candidate identity`);
  if (platform === "android") requireState(String(candidate.storeBuildId) === String(candidate.build),
    "Google production store build identity mismatch");
}

function jwt(header, claim, key, algorithm) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${encode(header)}.${encode(claim)}`;
  return `${input}.${sign(algorithm, Buffer.from(input), key).toString("base64url")}`;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function reviewStateRank(state) {
  return {
    COMPLETE: 5, APPROVED: 5, IN_REVIEW: 4, WAITING_FOR_REVIEW: 4, READY_FOR_REVIEW: 3,
    REJECTED: 1, CANCELED: 1, CANCELLED: 1
  }[state] ?? 2;
}

async function remoteStep(api, context, stepId, method, path, body) {
  const requestFingerprint = createHash("sha256").update(JSON.stringify({ method, path, body })).digest("hex");
  if (context?.assertSubstepWritable) await context.assertSubstepWritable(stepId, requestFingerprint);
  if (context?.recordSubstep) await context.recordSubstep({ stepId, status: "sent", requestFingerprint });
  try {
    const result = await api(method, path, body);
    if (context?.recordSubstep) await context.recordSubstep({ stepId, status: "acknowledged", requestFingerprint,
      remoteId: result?.data?.id ?? result?.id ?? null });
    return result;
  } catch (error) {
    try {
      if (context?.recordSubstep) await context.recordSubstep({ stepId, status: "uncertain", requestFingerprint });
    } catch { /* preserve the store error; the operation remains unresolved */ }
    throw error;
  }
}
