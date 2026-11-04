import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { appleList, createClients, googlePath as GP, googleSnapshot, inspectStores, number,
  requireState, selectExternalGroup, verifyInternalStore } from "./store-api.mjs";
import { validateInternalSmokeEvidence } from "./registry.mjs";
import { verifyLiveServerCompatibility } from "./live-server-compatibility.mjs";

export function assertIdentity(reservations, env) {
  for (const platform of ["ios", "android"]) {
    const r = reservations[platform];
    requireState(r && r.releaseMode === "open-beta" && r.internal && r.processed && r.uploaded &&
      r.uploadAttempted && /^[0-9a-f]{64}$/u.test(r.artifactSha256) && r.storeBuildId,
    `${platform} must have a verified internal upload before either external promotion`);
    requireState(r.generation === env.GENERATION && r.sourceSha === env.SOURCE_SHA &&
      r.marketingVersion === env[`${platform.toUpperCase()}_MARKETING_VERSION`] && r.releaseId === env.RELEASE_ID,
    "Reconciliation source/version/release identity mismatch");
  }
}

export async function assertLiveServerCompatibility(reservations, env, fetcher = fetch) {
  for (const platform of ["ios", "android"]) {
    const release = reservations[platform];
    await verifyLiveServerCompatibility({
      serverUrl: env.MOBILE_COMPATIBILITY_SERVER_URL ?? "https://playashatlas.com",
      platform,
      version: release.marketingVersion,
      build: release.build,
      sourceSha: release.sourceSha,
      protocolMin: release.protocol.min,
      protocolMax: release.protocol.max,
      requireServerSha: env.MOBILE_COMPATIBILITY_REQUIRE_SERVER_SHA !== "false",
      fetcher
    });
    // Keep the upload-time proof in the registry as immutable historical evidence. A
    // later promotion may legitimately observe a newer compatible server deployment;
    // the fresh proof above still binds this exact source/version/build/protocol
    // candidate to the server's current protocol and hard minimum contract.
  }
}

export function assertGoogleLifecycle(snapshot, release) {
  requireState(snapshot.betaLifecycleReadable === true && Array.isArray(snapshot.lifecycle?.beta),
    "Google beta lifecycle is unreadable; promotion is forbidden");
  const assigned = snapshot.tracks.find((t) => t.track === "beta")?.releases ?? [];
  const lifecycle = snapshot.lifecycle.beta;
  requireState(assigned.length <= 1 && lifecycle.length === assigned.length,
    "Partial or ambiguous Google beta lifecycle requires operator reconciliation");
  for (const entry of lifecycle) {
    requireState(entry.track === "beta" && ["RELEASE_LIFECYCLE_STATE_PUBLISHED", "RELEASE_LIFECYCLE_STATE_IN_REVIEW",
      "RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED", "RELEASE_LIFECYCLE_STATE_NOT_APPROVED"].includes(entry.releaseLifecycleState),
    "Unknown or superseded Google beta lifecycle requires operator reconciliation");
    requireState(entry.activeArtifacts?.length === 1 && assigned[0]?.versionCodes?.length === 1 &&
      number(entry.activeArtifacts[0].versionCode) === number(assigned[0].versionCodes[0]) && assigned[0].status === "completed",
    "Partial or superseded Google beta artifact evidence requires operator reconciliation");
    requireState(number(entry.activeArtifacts[0].versionCode) === release.build ||
      entry.releaseLifecycleState === "RELEASE_LIFECYCLE_STATE_PUBLISHED", "Existing beta review/unpublished release requires operator reconciliation");
  }
}

export function googlePublished(snapshot, release) {
  assertGoogleLifecycle(snapshot, release);
  const fallback = snapshot.tracks.find((t) => t.track === "production")?.releases ?? [];
  requireState(!fallback.some((r) => (r.versionCodes ?? []).some((b) => number(b) >= release.build)),
    "Production fallback can supersede the proposed beta; operator reconciliation required");
  const assigned = snapshot.tracks.find((t) => t.track === "beta")?.releases ?? [];
  const expected = assigned.filter((r) => (r.versionCodes ?? []).map(number).includes(release.build));
  if (expected.length !== 1 || expected[0].status !== "completed" || expected[0].versionCodes.length !== 1) return false;
  const serving = snapshot.lifecycle.beta.filter((r) => r.releaseLifecycleState === "RELEASE_LIFECYCLE_STATE_PUBLISHED");
  const exact = serving.some((r) => r.track === "beta" && r.activeArtifacts?.length === 1 && number(r.activeArtifacts[0].versionCode) === release.build);
  return exact;
}

export async function promoteGoogle(api, release, record, availabilityFence = () => {}) {
  validateInternalSmokeEvidence(release);
  requireState(release.promotionApproval && release.promotionExecutions?.length > 0, "Explicit promotion approval and execution receipt required");
  let snapshot = await googleSnapshot(api);
  const bundle = snapshot.bundles.find((b) => number(b.versionCode) === release.build);
  requireState(bundle?.sha256?.toLowerCase() === release.artifactSha256, "Google AAB fingerprint does not match the internally verified artifact");
  requireState(snapshot.tracks.find((t) => t.track === "internal")?.releases?.some((r) =>
    r.status === "completed" && r.versionCodes?.map(number).includes(release.build)), "Google internal verification was lost");
  requireState(String(release.build) === String(release.storeBuildId), "Google store build identity mismatch");
  // Fail before any mutation if another publisher has overtaken this candidate.
  requireState(snapshot.maximum === release.build, "A higher Google build exists; reconcile operator changes before promotion");
  if (!googlePublished(snapshot, release)) {
    const beta = snapshot.tracks.find((t) => t.track === "beta");
    const assigned = beta.releases?.some((r) => r.versionCodes?.map(number).includes(release.build));
    if (!assigned) {
      requireState((beta.releases ?? []).every((r) => r.status === "completed"), "Existing beta draft/rollout or unknown state requires operator reconciliation");
      requireState(!(snapshot.lifecycle.beta ?? []).some((r) => !["RELEASE_LIFECYCLE_STATE_PUBLISHED"].includes(r.releaseLifecycleState)), "Existing beta review/unpublished release requires operator reconciliation");
      await record("android", { milestones: { google_open_submitted: true } });
      availabilityFence();
      const edit = await api("POST", `${GP}/edits`, {});
      let committed = false;
      try {
        const current = (await api("GET", `${GP}/edits/${edit.id}/tracks`)).tracks;
        requireState(JSON.stringify(current) === JSON.stringify(snapshot.tracks), "Google tracks changed during promotion; edit abandoned");
        const lifecycle = await api("GET", `${GP}/tracks/beta/releases`);
        requireState(!lifecycle.nextPageToken && !lifecycle.tokenPagination?.nextPageToken &&
          JSON.stringify(lifecycle.releases) === JSON.stringify(snapshot.lifecycle.beta), "Google lifecycle changed during promotion; edit abandoned");
        await api("PUT", `${GP}/edits/${edit.id}/tracks/beta`, {
          track: "beta", releases: [{ name: `${release.generation} (${release.build})`, status: "completed", versionCodes: [String(release.build)] }]
        });
        await api("POST", `${GP}/edits/${edit.id}:commit`, {});
        committed = true;
      } finally {
        if (!committed) await api("DELETE", `${GP}/edits/${edit.id}`);
      }
      snapshot = await googleSnapshot(api);
    }
  }
  const matching = snapshot.lifecycle.beta.filter((r) => r.activeArtifacts?.some((a) => number(a.versionCode) === release.build));
  requireState(!matching.some((r) => r.releaseLifecycleState === "RELEASE_LIFECYCLE_STATE_NOT_APPROVED"), "Google beta review rejected");
  if (!googlePublished(snapshot, release)) return { pending: true, betaLifecycleReadable: snapshot.betaLifecycleReadable,
    lifecycle: matching.map((r) => r.releaseLifecycleState) };
  await record("android", { open: true, milestones: { google_open_submitted: true, google_open_verified: true } });
  return { pending: false };
}

export async function promoteApple(api, release, snapshot, record, inspectOnly = false, availabilityFence = () => {}) {
  validateInternalSmokeEvidence(release);
  requireState(release.promotionApproval && release.promotionExecutions?.length > 0, "Explicit promotion approval and execution receipt required");
  requireState(snapshot.metadataReady, "Existing Apple beta description, feedback or review details are incomplete; update them in App Store Connect first");
  requireState(snapshot.externalGroup, "Existing public TestFlight group could not be resolved");
  const groups = await appleList(api, `/v1/apps/${snapshot.appId}/betaGroups?limit=200`);
  const group = selectExternalGroup(groups, release.externalGroupId ?? snapshot.externalGroup.id);
  requireState(group.attributes.publicLink === (release.publicLink ?? snapshot.externalGroup.publicLink), "Existing public TestFlight link changed");
  const build = (await api("GET", `/v1/builds/${release.storeBuildId}`)).data;
  requireState(build?.attributes.version === String(release.build) && build.attributes.processingState === "VALID" && build.attributes.expired === false,
    "Apple build identity/processing/expiration mismatch");
  requireState(build.attributes.buildAudienceType === "APP_STORE_ELIGIBLE", "Build is TestFlight Internal Only or eligibility is unknown");
  const app = (await api("GET", `/v1/builds/${build.id}/app`)).data;
  const version = (await api("GET", `/v1/builds/${build.id}/preReleaseVersion`)).data;
  requireState(app?.id === snapshot.appId && version?.attributes.version === release.marketingVersion && version.attributes.platform === "IOS", "Wrong Apple app/version/platform");
  const internalGroups = groups.filter((g) => g.attributes.isInternalGroup && g.attributes.name === process.env.ASH_ATLAS_TESTFLIGHT_INTERNAL_GROUP);
  requireState(internalGroups.length === 1, "Apple internal group identity is missing or ambiguous");
  const internalBuilds = await appleList(api, `/v1/betaGroups/${internalGroups[0].id}/builds?limit=200`);
  requireState(internalBuilds.some((candidate) => candidate.id === build.id), "Apple internal group verification was lost");
  const localizations = await appleList(api, `/v1/builds/${build.id}/betaBuildLocalizations?limit=200`);
  requireState(localizations.some((l) => l.attributes?.whatsNew?.trim()), "Missing beta build testing notes");
  const detail = (await api("GET", `/v1/builds/${build.id}/buildBetaDetail`)).data?.attributes;
  requireState(detail && ["READY_FOR_BETA_SUBMISSION", "WAITING_FOR_BETA_REVIEW", "IN_BETA_REVIEW", "BETA_APPROVED", "READY_FOR_BETA_TESTING", "IN_BETA_TESTING"].includes(detail.externalBuildState), "Export compliance/processing requires operator action");
  requireState(typeof build.attributes.usesNonExemptEncryption === "boolean", "Export compliance declaration missing");
  const reviews = await appleList(api, `/v1/betaAppReviewSubmissions?filter[build]=${build.id}&limit=200`);
  requireState(reviews.length <= 1, "Ambiguous beta review state");
  const state = reviews[0]?.attributes.betaReviewState;
  requireState(!state || ["WAITING_FOR_REVIEW", "IN_REVIEW", "APPROVED", "REJECTED"].includes(state), "Unexpected Beta App Review state");
  requireState(state !== "REJECTED", "Beta App Review rejected; operator action required");
  if (inspectOnly) return { state, externalBuildState: detail.externalBuildState };
  await record("ios", { externalGroupId: group.id, publicLink: group.attributes.publicLink });
  if (state === "WAITING_FOR_REVIEW" || state === "IN_REVIEW") {
    await record("ios", { milestones: { ios_beta_review_submitted: true, ios_beta_review_pending: true } });
    return { pending: true, reviewState: state };
  }
  if (state !== "APPROVED" && !["BETA_APPROVED", "READY_FOR_BETA_TESTING", "IN_BETA_TESTING"].includes(detail.externalBuildState)) {
    requireState(detail.externalBuildState === "READY_FOR_BETA_SUBMISSION", "Unexpected external build state");
    requireState(!release.milestones?.ios_beta_review_submitted, "Prior beta review submission has no remote receipt; resolve ambiguous submission before retry");
    await record("ios", { milestones: { ios_beta_review_submitted: true } });
    availabilityFence();
    await api("POST", "/v1/betaAppReviewSubmissions", {
      data: { type: "betaAppReviewSubmissions", relationships: { build: { data: { type: "builds", id: build.id } } } }
    });
    await record("ios", { milestones: { ios_beta_review_pending: true } });
    return { pending: true, reviewState: "SUBMITTED" };
  }
  const attached = await appleList(api, `/v1/betaGroups/${group.id}/builds?limit=200`);
  if (!attached.some((b) => b.id === build.id)) {
    availabilityFence();
    await api("POST", `/v1/betaGroups/${group.id}/relationships/builds`, {
      data: [{ type: "builds", id: build.id }]
    });
  }
  const finalGroup = (await api("GET", `/v1/betaGroups/${group.id}`)).data;
  selectExternalGroup([finalGroup], group.id);
  requireState(finalGroup.attributes.publicLink === group.attributes.publicLink, "Public link changed during attachment");
  const finalBuilds = await appleList(api, `/v1/betaGroups/${group.id}/builds?limit=200`);
  const finalDetail = (await api("GET", `/v1/builds/${build.id}/buildBetaDetail`)).data?.attributes;
  if (!finalBuilds.some((b) => b.id === build.id) || finalDetail?.externalBuildState !== "IN_BETA_TESTING") return { pending: true, reviewState: "APPROVED_AWAITING_DISTRIBUTION" };
  await record("ios", { externalApproved: true, milestones: { ios_external_verified: true } });
  return { pending: false, publicLink: group.attributes.publicLink };
}

function registry(command, args = []) {
  const commandArgs = ["tools/mobile-release/registry-remote.mjs", command, ...args];
  if (process.env.PRODUCTION_REGISTRY_FILE) commandArgs.push("--file", process.env.PRODUCTION_REGISTRY_FILE);
  else {
    if (process.env.PRODUCTION_REGISTRY_REMOTE) commandArgs.push("--remote", process.env.PRODUCTION_REGISTRY_REMOTE);
    if (process.env.PRODUCTION_REGISTRY_BRANCH) commandArgs.push("--branch", process.env.PRODUCTION_REGISTRY_BRANCH);
    if (process.env.PRODUCTION_REGISTRY_SEED) commandArgs.push("--seed", process.env.PRODUCTION_REGISTRY_SEED);
  }
  return JSON.parse(execFileSync(process.execPath, commandArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
}

function assertAvailabilityFence() {
  const state = registry("activation-status");
  requireState(!state.activationIntent,
    `mobile availability is frozen by activation intent ${state.activationIntent?.intentId ?? "active"}`);
}

async function main() {
  const mode = process.argv[2];
  requireState(["inspect", "promote", "check-upload", "verify-internal"].includes(mode), "usage: open-beta.mjs inspect|promote|check-upload|verify-internal");
  if (mode === "promote") requireState(process.env.RELEASE_MODE === "open-beta" && process.env.DRY_RUN === "false" &&
    process.env.GITHUB_REF === "refs/heads/integration/test" && process.env.PROMOTION_INTENT === "promote-existing" &&
    process.env.PROMOTION_APPROVED === "true", "Explicit approved second-stage promotion on integration/test required");
  const platforms = ["check-upload", "verify-internal"].includes(mode) ? [process.env.STORE_PLATFORM] :
    (process.env.PLATFORM_LIST ?? "ios,android").split(",");
  const clients = await createClients({ mutable: mode === "promote", platforms });
  if (mode === "verify-internal") {
    const release = registry("inspect", ["--release-id", process.env.RELEASE_ID]).reservations[process.env.STORE_PLATFORM];
    requireState(release && release.sourceSha === process.env.SOURCE_SHA && release.generation === process.env.GENERATION &&
      release.marketingVersion === process.env.VITE_NATIVE_APP_VERSION && String(release.build) === process.env.ASH_ATLAS_STORE_BUILD,
    "Internal reconciliation identity mismatch");
    const id = await verifyInternalStore(clients, release, process.env.ASH_ATLAS_TESTFLIGHT_INTERNAL_GROUP);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `store_build_id=${id}\n`);
    console.log(JSON.stringify({ platform: release.platform, storeBuildId: id, internalVerified: true }));
    return;
  }
  if (mode === "check-upload") {
    const build = number(process.env.ASH_ATLAS_STORE_BUILD);
    if (process.env.STORE_PLATFORM === "android") {
      requireState(build > (await googleSnapshot(clients.google, { includeBeta: false })).maximum, "Android versionCode conflicts with remote store history");
    } else {
      requireState(process.env.STORE_PLATFORM === "ios", "Invalid upload platform");
      const apps = await appleList(clients.apple, "/v1/apps?filter[bundleId]=com.ashatlas.game&limit=200");
      requireState(apps.length === 1, "Apple app identity missing");
      const builds = await appleList(clients.apple, `/v1/builds?filter[app]=${apps[0].id}&limit=200`);
      requireState(builds.length > 0 && builds.every((b) => number(b.attributes.version) < build), "iOS build conflicts with remote store history");
    }
    return;
  }
  const snapshot = await inspectStores(clients, process.env.ASH_ATLAS_TESTFLIGHT_EXTERNAL_GROUP_ID,
    { platforms, includeBeta: process.env.RELEASE_MODE === "open-beta" });
  if (mode === "inspect") {
    requireState(process.env.REMOTE_SNAPSHOT_PATH, "REMOTE_SNAPSHOT_PATH is required");
    writeFileSync(process.env.REMOTE_SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify(snapshot));
    return;
  }
  let { reservations } = registry("inspect", ["--release-id", process.env.RELEASE_ID]);
  assertAvailabilityFence();
  assertIdentity(reservations, process.env);
  for (const release of Object.values(reservations)) validateInternalSmokeEvidence(release);
  await assertLiveServerCompatibility(reservations, process.env);
  const toolSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  requireState(toolSha === process.env.GITHUB_SHA, "Promotion tool SHA must match the approved workflow SHA");
  const record = async (platform, patch) => {
    const result = registry("transition", ["--reservation-id", reservations[platform].reservationId, "--patch", JSON.stringify(patch)]);
    reservations[platform] = result.reservations[platform];
  };
  for (const platform of ["ios", "android"]) {
    if (!reservations[platform].promotionApproval) await record(platform, { promotionApproval: {
      schemaVersion: 1, intent: "promote-existing", toolSha, actor: process.env.GITHUB_ACTOR,
      approvedAt: new Date().toISOString(), receiptUrl: `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    } });
    const receiptUrl = `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
    const prior = reservations[platform].promotionExecutions ?? [];
    if (!prior.some((e) => e.receiptUrl === receiptUrl && e.toolSha === toolSha)) await record(platform, { promotionExecutions: [
      ...prior, { schemaVersion: 1, toolSha, actor: process.env.GITHUB_ACTOR, receiptUrl, startedAt: new Date().toISOString() }
    ] });
  }
  // All bounded polling runs through the same monotone durable state. Review can take days;
  // timeout leaves a resumable pending state and never reports completion.
  let google, apple;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    assertAvailabilityFence();
    await assertLiveServerCompatibility(reservations, process.env);
    await promoteApple(clients.apple, reservations.ios, snapshot.apple, record, true, assertAvailabilityFence);
    assertAvailabilityFence();
    google = await promoteGoogle(clients.google, reservations.android, record, assertAvailabilityFence);
    assertAvailabilityFence();
    apple = await promoteApple(clients.apple, reservations.ios, snapshot.apple, record, false, assertAvailabilityFence);
    if (!google.pending && !apple.pending) {
      await record("android", { milestones: { open_beta_complete: true } });
      await record("ios", { milestones: { open_beta_complete: true } });
      console.log(JSON.stringify({ state: "open_beta_complete", google, apple }));
      return;
    }
    console.log(JSON.stringify({ state: "pending", google, apple }));
    if (attempt < 9) await new Promise((resolve) => setTimeout(resolve, 30000));
  }
  throw new Error("Open beta is pending store review/publication. Re-run approved promote-existing with the original release ID; no rebuild/upload is performed.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => {
  // Child stderr can include remote transport details. Keep failures bounded and credential-free.
  console.error(error.stderr ? "Registry operation failed; inspect the durable state before retrying" : error.message);
  process.exitCode = 1;
});
