import { sign } from "node:crypto";
import { normalizeTesterDestination, GOOGLE_INTERNAL_TEST_TRACK } from "./coordinated-mobile-testers.mjs";

export const PACKAGE = "com.ashatlas.game";
const APPLE = "https://api.appstoreconnect.apple.com";
const GOOGLE = "https://androidpublisher.googleapis.com";
const GP = `/androidpublisher/v3/applications/${PACKAGE}`;
export const requireState = (condition, message) => { if (!condition) throw new Error(message); };
export const number = (value) => {
  requireState(/^[0-9]+$/u.test(String(value)), "Store build number must be an integer; manual reconciliation required");
  const result = Number(value);
  requireState(Number.isSafeInteger(result) && result > 0 && result < 2_100_000_000, "Store build number out of range");
  return result;
};
const jwt = (header, claim, key, algorithm) => {
  const encode = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const input = `${encode(header)}.${encode(claim)}`;
  return `${input}.${sign(algorithm, Buffer.from(input), key).toString("base64url")}`;
};

// This is an endpoint allowlist, not a caller-supplied URL/track escape hatch.
// Inspection edits are temporary snapshots: they can only be created/read/deleted.
export function allowedRequest(store, method, path, mutable) {
  if (store === "apple") {
    if (method === "GET") return /^\/v1\/(apps|builds|betaGroups|betaAppLocalizations|betaAppReviewDetails|betaAppReviewSubmissions|betaBuildLocalizations)(\/|\?|$)/u.test(path);
    return mutable && method === "POST" && (
      path === "/v1/betaAppReviewSubmissions" || /^\/v1\/betaGroups\/[A-Za-z0-9-]+\/relationships\/builds$/u.test(path));
  }
  if (store !== "google" || !path.startsWith(`${GP}/`)) return false;
  const suffix = path.slice(GP.length);
  if (method === "GET") return /^\/edits\/[A-Za-z0-9-]+(?:\/(tracks(?:\/[^/?]+)?|bundles|apks))?$/u.test(suffix) || /^\/tracks\/[^/?]+\/releases$/u.test(suffix);
  if (method === "POST" && suffix === "/edits") return true;
  if (method === "DELETE" && /^\/edits\/[A-Za-z0-9-]+$/u.test(suffix)) return true;
  return mutable && ((method === "PUT" && /^\/edits\/[A-Za-z0-9-]+\/tracks\/(?:beta|internal)$/u.test(suffix)) ||
    (method === "POST" && /^\/edits\/[A-Za-z0-9-]+:commit$/u.test(suffix)));
}

export async function createClients({ mutable = false, env = process.env, fetcher = fetch, platforms = ["ios", "android"] } = {}) {
  requireState(platforms.length > 0 && platforms.every((p) => ["ios", "android"].includes(p)), "Invalid store platforms");
  const now = Math.floor(Date.now() / 1000);
  const appleToken = platforms.includes("ios") && env.APP_STORE_CONNECT_KEY_P8_BASE64 ? jwt({ alg: "ES256", kid: env.APP_STORE_CONNECT_KEY_ID, typ: "JWT" },
    { iss: env.APP_STORE_CONNECT_ISSUER_ID, iat: now, exp: now + 1200, aud: "appstoreconnect-v1" },
    { key: Buffer.from(env.APP_STORE_CONNECT_KEY_P8_BASE64, "base64"), dsaEncoding: "ieee-p1363" }, "sha256") : null;
  let googleToken;
  if (platforms.includes("android") && env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64) {
    const credential = JSON.parse(Buffer.from(env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64, "base64"));
    const assertion = jwt({ alg: "RS256", typ: "JWT" }, {
      iss: credential.client_email, scope: "https://www.googleapis.com/auth/androidpublisher",
      aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600
    }, credential.private_key, "RSA-SHA256");
    const tokenResponse = await fetcher("https://oauth2.googleapis.com/token", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(30000),
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion })
    });
    requireState(tokenResponse.ok, `Google authentication failed: HTTP ${tokenResponse.status}`);
    googleToken = (await tokenResponse.json()).access_token;
    requireState(typeof googleToken === "string", "Missing Google access token");
  }
  const ownedEdits = new Set();
  const testingEdits = new Set();
  const request = async (store, method, path, body) => {
    requireState(allowedRequest(store, method, path, mutable), "Store request denied by testing-track endpoint policy");
    requireState(store === "apple" ? appleToken : googleToken, "Missing protected store credentials");
    if (store === "google" && ["PUT", "DELETE"].includes(method)) {
      const editId = path.slice(`${GP}/edits/`.length).split("/")[0];
      requireState(ownedEdits.has(editId), "Cannot mutate an edit not created by this process");
      if (method === "PUT") {
        requireState(["beta", GOOGLE_INTERNAL_TEST_TRACK].includes(body?.track) && body.releases?.length === 1 && body.releases[0].status === "completed" &&
          body.releases[0].versionCodes?.length === 1, "Only one completed testing-track artifact may be assigned");
        number(body.releases[0].versionCodes[0]);
      }
    }
    if (store === "google" && path.endsWith(":commit")) {
      requireState(testingEdits.has(path.slice(`${GP}/edits/`.length, -":commit".length)), "Cannot commit an edit without this process's testing-track assignment");
    }
    const response = await fetcher(`${store === "apple" ? APPLE : GOOGLE}${path}`, {
      method, redirect: "error", signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${store === "apple" ? appleToken : googleToken}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    // Never emit response bodies: Apple review details may contain credentials/PII. The
    // allowlisted route is safe and necessary to distinguish permission failures from
    // transient failures without exposing protected response data.
    requireState(response.ok, `${store} ${method} ${path} failed: HTTP ${response.status}; reconcile before retrying`);
    const result = response.status === 204 ? {} : await response.json();
    if (store === "google" && method === "POST" && path === `${GP}/edits`) ownedEdits.add(result.id);
    if (store === "google" && method === "PUT") testingEdits.add(path.slice(`${GP}/edits/`.length).split("/")[0]);
    return result;
  };
  return {
    mutable,
    apple: (method, path, body) => request("apple", method, path, body),
    google: (method, path, body) => request("google", method, path, body)
  };
}

export async function appleList(api, path) {
  const data = [];
  const visited = new Set();
  while (path) {
    requireState(!visited.has(path) && visited.size < 1000, "Invalid Apple pagination");
    visited.add(path);
    const page = await api("GET", path);
    requireState(Array.isArray(page.data), "Missing Apple collection");
    data.push(...page.data);
    const next = page.links?.next;
    if (next) {
      const url = new URL(next, APPLE);
      requireState(url.origin === APPLE, "Untrusted Apple pagination origin");
      path = `${url.pathname}${url.search}`;
    } else path = null;
  }
  return data;
}

export async function googleSnapshot(api, { includeBeta = true, testerTrack = null } = {}) {
  const edit = await api("POST", `${GP}/edits`, {});
  requireState(/^[A-Za-z0-9-]+$/u.test(edit.id), "Invalid Google edit identity");
  try {
    const tracks = (await api("GET", `${GP}/edits/${edit.id}/tracks`)).tracks;
    const bundles = (await api("GET", `${GP}/edits/${edit.id}/bundles`)).bundles ?? [];
    const apks = (await api("GET", `${GP}/edits/${edit.id}/apks`)).apks ?? [];
    requireState(Array.isArray(tracks) && (!includeBeta || tracks.some((t) => t.track === "beta")), "Existing Google beta track not found");
    const testerTrackPresent = testerTrack === null || tracks.some((t) => t.track === testerTrack);
    if (testerTrack !== null) requireState(testerTrack === GOOGLE_INTERNAL_TEST_TRACK,
      "Google tester inspection must use the internal track");
    requireState(new Set(tracks.map((t) => t.track)).size === tracks.length, "Duplicate Google track");
    for (const track of tracks) requireState(/^[A-Za-z0-9_:.-]+$/u.test(track.track), "Unexpected Google track identity");
    // The service identity intentionally has testing-track scope rather than Production
    // management. The edit snapshot supplies every track's assigned versions; only the
    // beta lifecycle endpoint is needed to prove that Open Testing is actually serving.
    const lifecycle = Object.fromEntries(tracks.map((track) => [track.track, []]));
    let betaLifecycleReadable = false;
    if (includeBeta) {
      try {
        const response = await api("GET", `${GP}/tracks/beta/releases`);
        requireState(Array.isArray(response.releases) && !response.nextPageToken && !response.tokenPagination?.nextPageToken,
          "Missing or partial Google beta lifecycle response");
        lifecycle.beta = response.releases;
        betaLifecycleReadable = true;
      } catch (error) {
        const denied = `google GET ${GP}/tracks/beta/releases failed: HTTP 403`;
        if (!String(error?.message).includes(denied)) throw error;
        betaLifecycleReadable = false;
      }
    }
    let testerLifecycleReadable = false;
    if (testerTrack !== null && testerTrackPresent) {
      const response = await api("GET", `${GP}/tracks/${testerTrack}/releases`);
      requireState(Array.isArray(response.releases) && !response.nextPageToken && !response.tokenPagination?.nextPageToken,
        "Missing or partial Google internal lifecycle response");
      lifecycle[testerTrack] = response.releases;
      testerLifecycleReadable = true;
    }
    const codes = [...bundles, ...apks].map((b) => number(b.versionCode));
    for (const t of tracks) for (const r of t.releases ?? []) codes.push(...(r.versionCodes ?? []).map(number));
    for (const rs of Object.values(lifecycle)) for (const r of rs) codes.push(...(r.activeArtifacts ?? []).map((a) => number(a.versionCode)));
    requireState(codes.length > 0, "Google history empty; refusing guessed build floor");
    const maximum = Math.max(...codes);
    return { packageName: PACKAGE, maximum, tracks, bundles, apks, lifecycle, betaLifecycleReadable,
      testerTrack, testerTrackPresent, testerLifecycleReadable,
      supersededExplanation: explainSuperseded(tracks, lifecycle) };
  } finally {
    await api("DELETE", `${GP}/edits/${edit.id}`);
  }
}

export function explainSuperseded(tracks, lifecycle) {
  const betaCodes = tracks.find((t) => t.track === "beta")?.releases?.flatMap((r) => r.versionCodes ?? []).map(number) ?? [];
  const productionCodes = tracks.find((t) => t.track === "production")?.releases?.filter((r) => r.status === "completed")
    .flatMap((r) => r.versionCodes ?? []).map(number) ?? [];
  return { betaCodes, productionCodes,
    higherProductionFallback: productionCodes.some((p) => betaCodes.length && betaCodes.every((b) => p > b)),
    betaLifecycle: lifecycle.beta,
    explanation: "A higher production fallback can shadow beta. Track assignment alone does not prove serving; require PUBLISHED active artifact evidence. Device targeting and Console superseded label require Console confirmation when evidence is ambiguous." };
}

export function selectExternalGroup(groups, expectedId) {
  const candidates = groups.filter((g) => g.attributes?.isInternalGroup === false && g.attributes?.publicLinkEnabled === true);
  const matching = expectedId ? candidates.filter((g) => g.id === expectedId) : candidates;
  requireState(matching.length === 1, "Expected exactly one existing enabled external public group; configure ASH_ATLAS_TESTFLIGHT_EXTERNAL_GROUP_ID to disambiguate");
  const group = matching[0];
  requireState(/^https:\/\/testflight\.apple\.com\/join\/[A-Za-z0-9]+$/u.test(group.attributes.publicLink), "Invalid existing TestFlight public link");
  requireState(!group.attributes.publicLinkLimitEnabled || group.attributes.publicLinkLimit > 0, "Invalid public link limit");
  return group;
}

export async function appleSnapshot(api, expectedGroupId, { includeBeta = true } = {}) {
  const apps = await appleList(api, `/v1/apps?filter[bundleId]=${PACKAGE}&limit=200`);
  requireState(apps.length === 1 && apps[0].attributes.bundleId === PACKAGE, "Ambiguous Apple app identity");
  const app = apps[0];
  const builds = await appleList(api, `/v1/builds?filter[app]=${app.id}&limit=200`);
  requireState(builds.length > 0, "Apple history empty; refusing guessed build floor");
  const maximum = Math.max(...builds.map((b) => number(b.attributes.version)));
  if (!includeBeta) return { appId: app.id, bundleId: PACKAGE, maximum };
  const groups = await appleList(api, `/v1/apps/${app.id}/betaGroups?limit=200`);
  let group;
  const blockers = [];
  try { group = selectExternalGroup(groups, expectedGroupId); } catch (error) { blockers.push(error.message); }
  const localizations = await appleList(api, `/v1/apps/${app.id}/betaAppLocalizations?limit=200`);
  const review = (await api("GET", `/v1/apps/${app.id}/betaAppReviewDetail`)).data?.attributes;
  const testInfo = (await api("GET", `/v1/apps/${app.id}/betaLicenseAgreement`)).data;
  const metadataReady = localizations.some((l) => l.attributes?.description?.trim() && l.attributes?.feedbackEmail?.trim()) &&
    !!review && ["contactFirstName", "contactLastName", "contactPhone", "contactEmail"].every((k) => review[k]?.trim()) &&
    typeof review.demoAccountRequired === "boolean" && (!review.demoAccountRequired || !!(review.demoAccountName && review.demoAccountPassword));
  // Return only non-sensitive facts, never contact details, reviewer credentials or full review metadata.
  return { appId: app.id, bundleId: PACKAGE, maximum, metadataReady: !!metadataReady,
    betaLicensePresent: !!testInfo,
    builds: builds.map((b) => ({ id: b.id, version: b.attributes.version, processingState: b.attributes.processingState,
      buildAudienceType: b.attributes.buildAudienceType, expired: b.attributes.expired,
      usesNonExemptEncryption: b.attributes.usesNonExemptEncryption })),
    groups: groups.map((g) => ({ id: g.id, name: g.attributes.name, isInternalGroup: g.attributes.isInternalGroup,
      publicLinkEnabled: g.attributes.publicLinkEnabled, publicLink: g.attributes.publicLink,
      publicLinkLimitEnabled: g.attributes.publicLinkLimitEnabled, publicLinkLimit: g.attributes.publicLinkLimit })),
    blockers,
    externalGroup: group ? { id: group.id, publicLink: group.attributes.publicLink,
      buildIds: (await appleList(api, `/v1/betaGroups/${group.id}/builds?limit=200`)).map((b) => b.id) } : null };
}

export async function inspectStores(clients, groupId, { platforms = ["ios", "android"], includeBeta = true } = {}) {
  const google = platforms.includes("android") ? await googleSnapshot(clients.google, { includeBeta }) : undefined;
  const apple = platforms.includes("ios") ? await appleSnapshot(clients.apple, groupId, { includeBeta }) : undefined;
  return { observedAt: new Date().toISOString(), google, apple };
}

export async function verifyInternalStore(clients, release, internalGroupName) {
  requireState(release.uploadAttempted && /^[0-9a-f]{64}$/u.test(release.artifactSha256), "Missing attempted artifact identity");
  if (release.platform === "android") {
    const snapshot = await googleSnapshot(clients.google, { includeBeta: false });
    const bundles = snapshot.bundles.filter((b) => number(b.versionCode) === release.build);
    requireState(bundles.length === 1 && bundles[0].sha256?.toLowerCase() === release.artifactSha256,
      "Google internal bundle fingerprint mismatch");
    requireState(!release.storeBuildId || release.storeBuildId === String(release.build), "Google store build identity mismatch");
    requireState(snapshot.tracks.find((t) => t.track === "internal")?.releases?.some((r) =>
      r.status === "completed" && r.versionCodes?.map(number).includes(release.build)), "Google internal build is not completed");
    return String(release.build);
  }
  requireState(release.platform === "ios", "Invalid internal platform");
  const snapshot = await appleSnapshot(clients.apple, undefined, { includeBeta: false });
  const builds = await appleList(clients.apple, `/v1/builds?filter[app]=${snapshot.appId}&filter[version]=${release.build}&limit=200`);
  const matching = [];
  for (const build of builds.filter((b) => b.attributes.version === String(release.build))) {
    const app = (await clients.apple("GET", `/v1/builds/${build.id}/app`)).data;
    const version = (await clients.apple("GET", `/v1/builds/${build.id}/preReleaseVersion`)).data;
    if (app?.id === snapshot.appId && version?.attributes.platform === "IOS" && version.attributes.version === release.marketingVersion) matching.push(build);
  }
  requireState(matching.length === 1, "Apple app/platform/marketingVersion/build identity is missing or ambiguous");
  const build = matching[0];
  requireState(!release.storeBuildId || build.id === release.storeBuildId, "Apple store build ID mismatch");
  requireState(build.attributes.processingState === "VALID" && build.attributes.expired === false, "Apple internal build is not valid");
  const groups = (await appleList(clients.apple, `/v1/apps/${snapshot.appId}/betaGroups?limit=200`))
    .filter((g) => g.attributes.isInternalGroup && g.attributes.name === internalGroupName);
  requireState(groups.length === 1, "Apple internal group identity is missing or ambiguous");
  requireState((await appleList(clients.apple, `/v1/betaGroups/${groups[0].id}/builds?limit=200`)).some((b) => b.id === build.id),
    "Apple build is not attached to internal group");
  return build.id;
}

/**
 * Verify the daily Android tester destination.  Google calls the internal
 * testing track `internal`; a completed exact assignment is the store observation
 * required by the coordinated server gate.
 */
export async function verifyGoogleTesterStore(clients, release, destination, { activate = true } = {}) {
  const target = normalizeTesterDestination("android", destination);
  requireState(release.uploadAttempted && /^[0-9a-f]{64}$/u.test(release.artifactSha256),
    "Missing attempted Android tester artifact identity");
  const snapshot = await googleSnapshot(clients.google, { includeBeta: false, testerTrack: target.track });
  const bundles = snapshot.bundles.filter((entry) => number(entry.versionCode) === Number(release.build));
  requireState(bundles.length === 1 && bundles[0].sha256?.toLowerCase() === release.artifactSha256.toLowerCase(),
    "Google internal tester bundle fingerprint mismatch");
  const track = snapshot.tracks.find((entry) => entry.track === target.track) ?? null;
  const assignedReleases = track?.releases ?? [];
  const releases = (track?.releases ?? []).filter((entry) =>
    (entry.versionCodes ?? []).map(number).includes(Number(release.build)));
  requireState(releases.length <= 1, "Google internal tester track has an ambiguous candidate assignment");
  const lifecycle = (snapshot.lifecycle?.[target.track] ?? []).filter((entry) =>
    (entry.activeArtifacts ?? []).some((artifact) => number(artifact.versionCode) === Number(release.build)));
  requireState(lifecycle.length <= 1, "Google internal tester lifecycle has an ambiguous candidate assignment");
  const assigned = releases[0] ?? null;
  const lifecycleEntry = lifecycle[0] ?? null;
  const candidateDraft = assigned?.status === "draft" &&
    lifecycleEntry?.releaseLifecycleState === "RELEASE_LIFECYCLE_STATE_DRAFT";
  const priorReleases = candidateDraft ? assignedReleases.filter((entry) => entry !== assigned) : assignedReleases;
  const priorLifecycle = (snapshot.lifecycle?.[target.track] ?? [])
    .filter((entry) => !candidateDraft || entry !== lifecycleEntry);
  requireState(priorReleases.length <= 1,
    "Google internal tester track has multiple active release assignments");
  if (assigned) requireState((assigned.versionCodes ?? []).length === 1 &&
    Number(assigned.versionCodes[0]) === Number(release.build),
  "Google internal tester candidate assignment contains unrelated version codes");
  if (lifecycleEntry?.track !== undefined) requireState(lifecycleEntry.track === target.track,
    "Google internal tester lifecycle track changed");
  const available = assigned?.status === "completed" && lifecycleEntry?.releaseLifecycleState ===
    "RELEASE_LIFECYCLE_STATE_PUBLISHED" && lifecycleEntry.activeArtifacts?.length === 1 &&
    number(lifecycleEntry.activeArtifacts[0].versionCode) === Number(release.build);
  if (assigned && !candidateDraft) {
    if (!activate) {
      throw new Error("Google internal tester candidate was assigned before authenticated activation");
    }
    requireState(assigned.status === "completed", "Google internal tester candidate assignment is unresolved");
    const lifecycleState = lifecycleEntry?.releaseLifecycleState ?? null;
    requireState(lifecycleState !== "RELEASE_LIFECYCLE_STATE_NOT_APPROVED",
      "Google internal tester candidate was not approved");
    const observation = { platform: "android", marketing_version: release.marketingVersion,
      build: Number(release.build), store_build_id: String(release.storeBuildId ?? release.build),
      artifact_sha256: release.artifactSha256, track: target.track, status: assigned.status,
      ...(lifecycleState ? { lifecycle_status: lifecycleState } : {}),
      ...(lifecycleEntry?.activeArtifacts?.length === 1
        ? { active_artifact_version_code: Number(lifecycleEntry.activeArtifacts[0].versionCode) } : {}),
      available };
    return { storeBuildId: String(release.build), pending: !available,
      ...(lifecycleState === "RELEASE_LIFECYCLE_STATE_DRAFT" ||
        lifecycleState === "RELEASE_LIFECYCLE_STATE_NOT_SENT_FOR_REVIEW"
        ? { actionRequired: "Google Play requires the internal tester release to be sent for review in Console" } : {}),
      snapshot, observation };
  }
  if (!activate) {
    const observation = { platform: "android", marketing_version: release.marketingVersion,
      build: Number(release.build), store_build_id: String(release.storeBuildId ?? release.build),
      artifact_sha256: release.artifactSha256, track: target.track, status: "NOT_ACTIVATED",
      available: false, prepared: true };
    return { storeBuildId: String(release.build), pending: false, snapshot, observation };
  }
  if (!available) {
    requireState(clients.mutable === true, "Google internal tester build is not an exact completed assignment");
    const existingCodes = priorReleases.flatMap((entry) => (entry.versionCodes ?? []).map(number));
    requireState(priorReleases.every((entry) => entry.status === "completed") &&
      Number(release.build) > (existingCodes.length ? Math.max(...existingCodes) : 0) &&
      existingCodes.length <= 1 &&
      priorLifecycle.every((entry) =>
        entry.releaseLifecycleState === "RELEASE_LIFECYCLE_STATE_PUBLISHED") &&
      (!snapshot.testerTrackPresent || (snapshot.lifecycle?.[target.track] ?? []).length < 20),
    "Google internal tester track has an unresolved or superseding release");
    const edit = await clients.google("POST", `${GP}/edits`, {});
    let committed = false;
    try {
      const current = (await clients.google("GET", `${GP}/edits/${edit.id}/tracks`)).tracks;
      const currentTesterTrack = current.find((entry) => entry.track === target.track);
      requireState((currentTesterTrack === undefined && track === null) || JSON.stringify(currentTesterTrack) === JSON.stringify(track),
        "Google internal tester track changed during assignment");
      await clients.google("PUT", `${GP}/edits/${edit.id}/tracks/${target.track}`, {
        track: target.track,
        releases: [{ name: `${release.generation} (${release.build})`, status: "completed",
          versionCodes: [String(release.build)] }]
      });
      await clients.google("POST", `${GP}/edits/${edit.id}:commit`, {});
      committed = true;
    } finally {
      if (!committed) await clients.google("DELETE", `${GP}/edits/${edit.id}`);
    }
    return verifyGoogleTesterStore({ ...clients, mutable: false }, release, target, { activate: true });
  }
}

/**
 * Read and, when explicitly allowed by the coordinated submit step, attach an
 * exact build to an existing TestFlight group.  Group type and public link are
 * checked immediately before the only possible relationship write.
 */
export async function verifyTestFlightTesterStore(clients, release, destination,
  { allowMutations = false, activate = allowMutations, allowReviewSubmission = allowMutations } = {}) {
  const target = normalizeTesterDestination("ios", destination);
  requireState(release.uploadAttempted && /^[0-9a-f]{64}$/u.test(release.artifactSha256),
    "Missing attempted iOS tester artifact identity");
  const apps = await appleList(clients.apple, `/v1/apps?filter[bundleId]=${PACKAGE}&limit=200`);
  requireState(apps.length === 1, "Apple app identity is missing or ambiguous");
  const appId = apps[0].id;
  let storeBuildId = release.storeBuildId;
  if (!storeBuildId) {
    const candidates = await appleList(clients.apple,
      `/v1/builds?filter[app]=${appId}&filter[version]=${release.build}&limit=200`);
    requireState(candidates.length === 1, "Apple tester build identity is missing or ambiguous");
    storeBuildId = candidates[0].id;
  }
  const buildResponse = (await clients.apple("GET", `/v1/builds/${storeBuildId}`)).data;
  requireState(buildResponse?.id === String(storeBuildId), "Apple tester build identity changed");
  const app = (await clients.apple("GET", `/v1/builds/${storeBuildId}/app`)).data;
  const version = (await clients.apple("GET", `/v1/builds/${storeBuildId}/preReleaseVersion`)).data;
  requireState(app?.id === appId && version?.attributes?.platform === "IOS" &&
    version.attributes.version === release.marketingVersion &&
    buildResponse.attributes?.processingState === "VALID" && buildResponse.attributes?.expired === false &&
    String(buildResponse.attributes?.version) === String(release.build),
  "Apple TestFlight app/version/build identity is not exact");
  const groups = await appleList(clients.apple, `/v1/apps/${appId}/betaGroups?limit=200`);
  const matches = groups.filter((group) => group.id === target.group_id &&
    Boolean(group.attributes?.isInternalGroup) === (target.group_type === "internal"));
  requireState(matches.length === 1, "Configured TestFlight group is missing or has the wrong type");
  const group = matches[0];
  if (target.group_type === "external") {
    requireState(group.attributes?.publicLinkEnabled === true && group.attributes?.publicLink === target.public_link,
      "Configured external TestFlight public link changed");
  }
  let attached = (await appleList(clients.apple, `/v1/betaGroups/${group.id}/builds?limit=200`))
    .some((entry) => entry.id === String(storeBuildId));
  if (target.group_type === "internal") {
    const detail = (await clients.apple("GET", `/v1/builds/${storeBuildId}/buildBetaDetail`)).data?.attributes;
    const allowedInternal = new Set(["READY_FOR_BETA_TESTING", "IN_BETA_TESTING"]);
    requireState(detail && typeof detail.internalBuildState === "string",
      "Apple TestFlight internal build availability state is unavailable");
    requireState(detail.internalBuildState !== "MISSING_EXPORT_COMPLIANCE",
      "Apple TestFlight export compliance is unresolved");
    if (!activate) {
      requireState(!attached, "Apple TestFlight build was attached before authenticated activation");
      const observation = { platform: "ios", group_type: target.group_type, group_id: target.group_id,
        marketing_version: release.marketingVersion, build: Number(release.build),
        store_build_id: String(storeBuildId), artifact_sha256: release.artifactSha256,
        status: detail.internalBuildState, available: false, prepared: allowedInternal.has(detail.internalBuildState) };
      return { storeBuildId: String(storeBuildId), pending: false,
        snapshot: { tester: observation }, observation };
    }
    if (!attached && allowMutations) {
      await clients.apple("POST", `/v1/betaGroups/${group.id}/relationships/builds`, {
        data: [{ type: "builds", id: String(storeBuildId) }]
      });
      attached = true;
    }
    const finalBuilds = await appleList(clients.apple, `/v1/betaGroups/${group.id}/builds?limit=200`);
    const finalDetail = (await clients.apple("GET", `/v1/builds/${storeBuildId}/buildBetaDetail`)).data?.attributes;
    requireState(finalDetail && typeof finalDetail.internalBuildState === "string",
      "Apple TestFlight internal build availability state is unavailable");
    const available = attached && finalBuilds.some((entry) => entry.id === String(storeBuildId)) &&
      allowedInternal.has(finalDetail.internalBuildState);
    const observation = { platform: "ios", group_type: target.group_type, group_id: target.group_id,
      marketing_version: release.marketingVersion, build: Number(release.build),
      store_build_id: String(storeBuildId), artifact_sha256: release.artifactSha256,
      status: finalDetail.internalBuildState, available };
    return { storeBuildId: String(storeBuildId), pending: !available,
      snapshot: { tester: observation }, observation };
  }
  requireState(activate || !attached,
    "external TestFlight group attachment must wait for authenticated server health");
  const detail = (await clients.apple("GET", `/v1/builds/${storeBuildId}/buildBetaDetail`)).data?.attributes;
  requireState(detail && typeof detail.externalBuildState === "string",
    "Apple TestFlight build processing state is unavailable");
  const allowed = new Set(["BETA_APPROVED", "READY_FOR_BETA_TESTING", "IN_BETA_TESTING"]);
  if (!attached && target.group_type === "external") {
      const reviews = await appleList(clients.apple,
      `/v1/betaAppReviewSubmissions?filter[build]=${storeBuildId}&limit=200`);
    requireState(reviews.length <= 1, "Apple TestFlight review state is ambiguous");
    const reviewState = reviews[0]?.attributes?.betaReviewState ?? null;
    requireState(reviewState !== "REJECTED", "Apple TestFlight review rejected the candidate");
    if (!allowed.has(detail.externalBuildState)) {
      if (allowReviewSubmission && detail.externalBuildState === "READY_FOR_BETA_SUBMISSION" && !reviewState) {
        await clients.apple("POST", "/v1/betaAppReviewSubmissions", {
          data: { type: "betaAppReviewSubmissions", relationships: { build: {
            data: { type: "builds", id: String(storeBuildId) }
          } } }
        });
      }
      const observation = { platform: "ios", group_type: target.group_type, group_id: target.group_id,
        public_link: target.public_link, marketing_version: release.marketingVersion, build: Number(release.build),
        store_build_id: String(storeBuildId), artifact_sha256: release.artifactSha256,
        status: reviewState ?? detail.externalBuildState, available: false, prepared: true };
      return { storeBuildId: String(storeBuildId), pending: true,
        snapshot: { tester: observation }, observation };
    }
  }
  if (!activate) {
    const observation = { platform: "ios", group_type: target.group_type, group_id: target.group_id,
      public_link: target.public_link, marketing_version: release.marketingVersion, build: Number(release.build),
      store_build_id: String(storeBuildId), artifact_sha256: release.artifactSha256,
      status: detail.externalBuildState, available: false, prepared: true };
    return { storeBuildId: String(storeBuildId), pending: false,
      snapshot: { tester: observation }, observation };
  }
  if (!attached && activate && allowMutations) {
    await clients.apple("POST", `/v1/betaGroups/${group.id}/relationships/builds`, {
      data: [{ type: "builds", id: String(storeBuildId) }]
    });
    attached = true;
  }
  const finalBuilds = await appleList(clients.apple, `/v1/betaGroups/${group.id}/builds?limit=200`);
  const available = attached && finalBuilds.some((entry) => entry.id === String(storeBuildId)) && allowed.has(detail.externalBuildState);
  const observation = { platform: "ios", group_type: target.group_type, group_id: target.group_id,
    ...(target.group_type === "external" ? { public_link: target.public_link } : {}),
    marketing_version: release.marketingVersion, build: Number(release.build),
    store_build_id: String(storeBuildId), artifact_sha256: release.artifactSha256,
    status: detail.externalBuildState, available, prepared: true };
  return { storeBuildId: String(storeBuildId), pending: !available,
    snapshot: { tester: observation }, observation };
}

export async function verifyDailyTesterStore(clients, release, destination, options = {}) {
  const target = normalizeTesterDestination(release.platform, destination);
  return release.platform === "android"
    ? verifyGoogleTesterStore(clients, release, target, options)
    : verifyTestFlightTesterStore(clients, release, target, options);
}

export function assertNewBuild(snapshot, platform, build) {
  requireState(number(build) > snapshot[platform === "ios" ? "apple" : "google"].maximum,
    `${platform} build conflicts with remote maximum; never replace an uploaded number`);
}

export const googlePath = GP;
