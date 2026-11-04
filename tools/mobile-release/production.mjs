import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import {
  beginProductionOperation,
  finishProductionOperation,
  markProductionUncertain,
  productionCandidateFingerprint,
  productionIdentityFingerprint,
  productionStatus,
  reconcileProductionOperation,
  sha256Json,
  validateProductionCandidate
} from "./production-registry.mjs";
import {
  advanceAppleProduction,
  advanceGoogleProduction,
  createProductionClients,
  pauseAppleProduction,
  pauseGoogleProduction,
  productionAppleSnapshot,
  productionGoogleSnapshot,
  releaseAppleProduction,
  releaseGoogleProduction,
  resumeAppleProduction,
  resumeGoogleProduction,
  submitAppleProduction,
  submitGoogleProduction
} from "./production-store-api.mjs";
import { verifyLiveServerCompatibility } from "./live-server-compatibility.mjs";

export const PRODUCTION_ACTIONS = ["inspect", "prepare", "cancel", "submit", "reconcile", "release", "advance", "pause", "resume"];

export function normalizeProductionCountries(value) {
  const countries = String(value ?? "").split(",").map((country) => country.trim()).filter(Boolean).sort();
  requireState(new Set(countries).size === countries.length && countries.every((country) => /^[A-Z]{2}$/u.test(country)),
    "production countries must be unique uppercase two-letter codes");
  return countries;
}

export function parseProductionRollout(value, fallback) {
  let rollout;
  try { rollout = JSON.parse(value ?? JSON.stringify(fallback)); } catch { throw new Error("production rollout must be valid JSON"); }
  requireState(rollout && typeof rollout === "object" && !Array.isArray(rollout), "production rollout must be an object");
  return rollout;
}

export function assertPreparedCandidate(candidate, release, {
  toolSha,
  metadataHash,
  countries,
  rollout,
  sourceSha,
  generation,
  releaseId,
  publishedMasterSha
} = {}) {
  assertAcceptedRelease(release, { sourceSha, generation });
  requireState(candidate.releaseId === release.releaseId && candidate.platform === release.platform &&
    candidate.sourceSha === release.sourceSha && candidate.acceptedSha === release.sourceSha &&
    candidate.generation === release.generation && candidate.marketingVersion === release.marketingVersion &&
    candidate.build === release.build && candidate.storeBuildId === release.storeBuildId &&
    candidate.artifactSha256 === release.artifactSha256,
  "prepared production candidate does not match the exact verified release");
  if (releaseId !== undefined) requireState(candidate.releaseId === releaseId, "production release ID does not match the prepared candidate");
  if (toolSha !== undefined) requireState(candidate.toolSha === toolSha && candidate.toolingApproval?.toolSha === toolSha,
    "production tooling identity does not match the prepared candidate");
  requireState(/^[0-9a-f]{40}$/u.test(candidate.publishedMasterSha ?? ""),
    "prepared production candidate has no published master ancestry proof");
  if (publishedMasterSha !== undefined) requireState(candidate.publishedMasterSha === publishedMasterSha,
    "published master identity does not match the prepared candidate");
  if (metadataHash !== undefined) requireState(candidate.metadataHash === metadataHash,
    "production metadata approval does not match the prepared candidate");
  if (countries !== undefined) requireState(sha256Json(candidate.countries) === sha256Json(normalizeProductionCountries(countries)),
    "production country binding does not match the prepared candidate");
  if (rollout !== undefined) requireState(sha256Json(candidate.rollout) === sha256Json(rollout),
    "production rollout binding does not match the prepared candidate");
  return candidate;
}

export function assertPublishedMasterAncestry(candidate, currentMasterSha,
  repositoryPath = process.env.PRODUCTION_SOURCE_REPOSITORY ?? process.cwd()) {
  requireState(/^[0-9a-f]{40}$/u.test(candidate?.publishedMasterSha ?? "") &&
    /^[0-9a-f]{40}$/u.test(currentMasterSha ?? ""),
  "published master ancestry identities must be exact");
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", candidate.publishedMasterSha, currentMasterSha], {
      cwd: repositoryPath, stdio: "ignore"
    });
  } catch {
    requireState(false, "current published master is not a descendant of the prepared master; reprepare the candidate");
  }
  return currentMasterSha;
}

function assertInvocationBinding(candidate, release, platform) {
  const toolSha = requiredEnv("PRODUCTION_TOOL_SHA");
  const metadataHash = process.env[`${platform.toUpperCase()}_PRODUCTION_METADATA_SHA256`] ?? process.env.PRODUCTION_METADATA_SHA256;
  requireState(/^[0-9a-f]{64}$/u.test(metadataHash ?? ""), "production metadata hash is required for every action");
  const metadataPacket = readApprovedMetadataPacket(platform);
  requireState(metadataPacket.hash === metadataHash,
    `${platform} approved production metadata packet does not match the prepared SHA256`);
  const countries = normalizeProductionCountries(process.env[`${platform.toUpperCase()}_PRODUCTION_COUNTRIES`] ?? process.env.PRODUCTION_COUNTRIES ?? "");
  const rollout = parseProductionRollout(process.env[`${platform.toUpperCase()}_PRODUCTION_ROLLOUT`] ?? process.env.PRODUCTION_ROLLOUT,
    candidate.rollout);
  if (platform === "android" && Object.prototype.hasOwnProperty.call(candidate, "managedPublishing")) {
    requireState(candidate.managedPublishing === (process.env.GOOGLE_PLAY_MANAGED_PUBLISHING === "true"),
      "Google managed-publishing binding does not match the prepared candidate");
    if (candidate.firstLaunch) requireState(candidate.firstPublicationBootstrapVerified ===
      (process.env.GOOGLE_PLAY_FIRST_PUBLICATION_BOOTSTRAP === "true"),
    "Google first-publication bootstrap binding does not match the prepared candidate");
  }
  assertPreparedCandidate(candidate, release, { toolSha, metadataHash, countries,
    sourceSha: requiredEnv("SOURCE_SHA"), generation: requiredEnv("GENERATION"),
    releaseId: requiredEnv("RELEASE_ID") });
  // The metadata packet is part of the immutable artifact identity. Rollout
  // changes are separately approved transition records, so a 10% -> 50% ->
  // full action keeps the same packet hash and candidate binding.
  assertProductionMetadataBinding(metadataPacket.packet, platform, candidate, candidate.rollout, candidate.countries);
  assertPublishedMasterAncestry(candidate, requiredEnv("PRODUCTION_MASTER_SHA"));
  return { candidate, rollout, metadataPacket: metadataPacket.packet };
}

export function approvedMetadataPacketHash(platform, env = process.env) {
  const packetPath = env[`${platform.toUpperCase()}_PRODUCTION_METADATA_PACKET_PATH`] ?? env.PRODUCTION_METADATA_PACKET_PATH;
  requireState(typeof packetPath === "string" && packetPath.length > 0,
    `${platform} approved production metadata packet path is required`);
  return createHash("sha256").update(readFileSync(packetPath)).digest("hex");
}

export function readApprovedMetadataPacket(platform, env = process.env) {
  const packetPath = env[`${platform.toUpperCase()}_PRODUCTION_METADATA_PACKET_PATH`] ?? env.PRODUCTION_METADATA_PACKET_PATH;
  requireState(typeof packetPath === "string" && packetPath.length > 0,
    `${platform} approved production metadata packet path is required`);
  const bytes = readFileSync(packetPath);
  let packet;
  try { packet = JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`${platform} approved production metadata packet must be UTF-8 JSON`); }
  return { hash: createHash("sha256").update(bytes).digest("hex"), packet: validateProductionMetadataPacket(platform, packet) };
}

export function validateProductionMetadataPacket(platform, packet) {
  requireState(packet && typeof packet === "object" && !Array.isArray(packet) && packet.schemaVersion === 1,
    `${platform} production metadata packet schemaVersion must be 1`);
  requireState(packet.platform === platform, `${platform} production metadata packet platform is invalid`);
  const identity = platform === "ios" ? (packet.bundleId ?? packet.app?.bundleId) : (packet.packageName ?? packet.app?.packageName);
  requireState(identity === "com.ashatlas.game", `${platform} production metadata packet app identity is invalid`);
  const marketingVersion = packet.marketingVersion ?? packet.versionString ?? packet.version?.marketingVersion ?? packet.version;
  requireState(typeof marketingVersion === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(marketingVersion),
    `${platform} production metadata packet version is invalid`);
  const localizations = packet.localizations ?? packet.localizedMetadata;
  requireState(Array.isArray(localizations) && localizations.length > 0,
    `${platform} production metadata packet localizations are required`);
  const normalizedLocalizations = localizations.map((entry) => {
    requireState(entry && typeof entry === "object" && !Array.isArray(entry),
      `${platform} production metadata localization is invalid`);
    const locale = entry.locale ?? entry.language;
    requireState(typeof locale === "string" && locale.length > 0 && locale.length <= 32,
      `${platform} production metadata localization locale is invalid`);
    const fields = Object.fromEntries(Object.entries(entry)
      .filter(([key]) => !["locale", "language"].includes(key))
      .sort(([left], [right]) => left.localeCompare(right)));
    requireState(Object.keys(fields).length > 0 && Object.values(fields).every((value) => typeof value === "string"),
      `${platform} production metadata localization fields are invalid`);
    return { locale, ...fields };
  }).sort((left, right) => left.locale.localeCompare(right.locale));
  requireState(new Set(normalizedLocalizations.map((entry) => entry.locale)).size === normalizedLocalizations.length,
    `${platform} production metadata localization locales must be unique`);
  const policy = packet.policy;
  requireState(policy && typeof policy === "object" && !Array.isArray(policy),
    `${platform} production metadata policy is required`);
  const countries = normalizeProductionCountries(policy.countries ?? packet.countries ?? "");
  const rollout = parseProductionRollout(JSON.stringify(policy.rollout ?? packet.rollout), null);
  requireState(["first-publish", "update"].includes(rollout.kind) && ["manual", "staged", "full"].includes(rollout.mode),
    `${platform} production metadata rollout policy is invalid`);
  if (rollout.mode === "staged") requireState(Number.isFinite(rollout.fraction) && rollout.fraction > 0 && rollout.fraction < 1,
    `${platform} production metadata staged fraction is invalid`);
  return { schemaVersion: 1, platform, identity,
    ...(platform === "ios" ? { bundleId: identity } : { packageName: identity }), marketingVersion,
    localizations: normalizedLocalizations, policy: { countries, rollout: structuredClone(rollout) },
    build: packet.build ?? packet.version?.build ?? null, storeBuildId: packet.storeBuildId ?? null };
}

export function assertProductionMetadataBinding(packet, platform, candidate, rollout, countries) {
  const normalized = validateProductionMetadataPacket(platform, packet);
  requireState(normalized.marketingVersion === candidate.marketingVersion,
    `${platform} production metadata version does not match the candidate`);
  requireState(sha256Json(normalized.policy.countries) === sha256Json(normalizeProductionCountries(countries)),
    `${platform} production metadata country policy does not match the candidate`);
  requireState(sha256Json(normalized.policy.rollout) === sha256Json(rollout),
    `${platform} production metadata rollout policy does not match the candidate transition`);
  if (normalized.build !== null) requireState(String(normalized.build) === String(candidate.build),
    `${platform} production metadata build does not match the candidate`);
  if (normalized.storeBuildId !== null) requireState(normalized.storeBuildId === candidate.storeBuildId,
    `${platform} production metadata store identity does not match the candidate`);
  return normalized;
}

export function assertProductionReleaseApproval(candidate, approved, approvalFingerprint, transition = null) {
  requireState(approved === true, "a separate production release approval is required");
  const expected = transition?.approvalFingerprint ?? productionCandidateFingerprint(candidate);
  requireState(typeof approvalFingerprint === "string" && approvalFingerprint === expected,
    transition ? "production release approval is not bound to the exact rollout transition" :
      "production release approval is not bound to the prepared candidate");
}

export function productionArtifactFingerprint(candidate) {
  const artifact = structuredClone(candidate);
  delete artifact.rollout;
  return sha256Json(artifact);
}

export function buildProductionTransition(candidate, {
  operationId,
  action,
  expectedRemoteFingerprint,
  toRollout,
  approvalFingerprint
}) {
  validateProductionCandidate(candidate);
  requireState(["release", "advance", "pause", "resume"].includes(action),
    "production rollout transitions are only valid for release actions");
  requireState(typeof operationId === "string" && operationId.length > 0 &&
    typeof expectedRemoteFingerprint === "string" && /^[0-9a-f]{64}$/u.test(expectedRemoteFingerprint),
  "production transition operation and remote identity are required");
  requireState(sha256Json({ kind: candidate.rollout.kind, mode: candidate.rollout.mode }) !==
    sha256Json({ kind: toRollout?.kind, mode: toRollout?.mode }) ||
    sha256Json(candidate.rollout) !== sha256Json(toRollout),
  "production transition must identify a rollout policy");
  validateProductionCandidate({ ...structuredClone(candidate), rollout: structuredClone(toRollout) }, candidate.platform);
  const payload = { schemaVersion: 1, operationId, action,
    artifactFingerprint: productionArtifactFingerprint(candidate), expectedRemoteFingerprint,
    expectedPriorPolicyFingerprint: expectedRemoteFingerprint, toRollout: structuredClone(toRollout) };
  const expectedApprovalFingerprint = sha256Json(payload);
  requireState(approvalFingerprint === expectedApprovalFingerprint,
    "production rollout approval is not bound to the exact artifact, prior policy, operation, and target rollout");
  const transition = { ...payload, approvalFingerprint };
  return { ...transition, fingerprint: sha256Json(transition) };
}

export function applyProductionTransition(candidate, transition) {
  requireState(transition?.artifactFingerprint === productionArtifactFingerprint(candidate),
    "production rollout transition artifact does not match the prepared candidate");
  const effective = { ...structuredClone(candidate), rollout: structuredClone(transition.toRollout) };
  validateProductionCandidate(effective);
  return effective;
}

export function assertActivationFence(candidate, currentFingerprint) {
  requireState((candidate.activationFenceFingerprint ?? null) === (currentFingerprint ?? null),
    "server activation intent changed since production prepare; reprepare the candidate");
}

export function assertAcceptedRelease(release, expected = {}) {
  requireState(release && ["ios", "android"].includes(release.platform) && release.uploadAttempted &&
    release.uploaded && release.processed && release.internal && /^[0-9a-f]{40}$/u.test(release.sourceSha) &&
    /^t\d{3,4}$/u.test(release.generation) && /^[0-9a-f]{64}$/u.test(release.artifactSha256) &&
    typeof release.storeBuildId === "string" && release.storeBuildId.length > 0,
  "production requires the exact existing verified internal artifact");
  for (const field of ["sourceSha", "generation", "marketingVersion", "build", "storeBuildId", "artifactSha256"]) {
    if (expected[field] !== undefined) requireState(String(release[field]) === String(expected[field]),
      `production accepted release ${field} identity mismatch`);
  }
  return release;
}

export function normalizeServerCompatibility(proof, candidate) {
  requireState(proof?.schemaVersion === 1 && /^[0-9a-f]{40}$/u.test(proof.serverSha),
    "production server compatibility proof is missing an immutable server SHA");
  const minimum = proof.hardMinimum?.version ? proof.hardMinimum : proof.hardMinimum?.[candidate.platform];
  requireState(minimum && typeof minimum.version === "string" && Number.isInteger(minimum.build),
    "production server compatibility hard minimum is invalid");
  const normalized = {
    schemaVersion: 1,
    serverSha: proof.serverSha,
    serverProtocol: { min: proof.serverProtocol?.min ?? proof.protocol?.min ?? proof.wsMin,
      max: proof.serverProtocol?.max ?? proof.protocol?.max ?? proof.wsMax },
    hardMinimum: { [candidate.platform]: { version: minimum.version, build: minimum.build } },
    observedAt: proof.observedAt ?? new Date().toISOString()
  };
  requireState(Number.isInteger(normalized.serverProtocol.min) && Number.isInteger(normalized.serverProtocol.max) &&
    normalized.serverProtocol.min > 0 && normalized.serverProtocol.min <= normalized.serverProtocol.max,
  "production server compatibility protocol range is invalid");
  return normalized;
}

export function remoteBaselineFor(platform, snapshot) {
  if (platform === "android") {
    return { platform, firstLaunch: snapshot.firstLaunch, productionTrack: snapshot.productionTrack,
      productionLifecycle: snapshot.productionLifecycle ?? null };
  }
  return { platform, firstLaunch: snapshot.firstLaunch,
    versions: snapshot.versions.map(({ id, versionString, state, releaseType, buildId, phasedReleaseId,
      phasedReleaseState, reviewSubmissionId, reviewSubmissionState, published }) =>
      ({ id, versionString, state, releaseType, buildId, phasedReleaseId, phasedReleaseState,
        reviewSubmissionId, reviewSubmissionState, published })) };
}

export function assertRemoteBaseline(candidate, platform, snapshot) {
  requireState(candidate.remoteBaselineFingerprint === sha256Json(remoteBaselineFor(platform, snapshot)),
    "production store changed since prepare; reconcile before retrying");
}

export function assertTransitionSnapshot(expectedFingerprint, platform, snapshot) {
  requireState(typeof expectedFingerprint === "string" &&
    expectedFingerprint === sha256Json(remoteBaselineFor(platform, snapshot)),
  "production store changed during the transition; reconcile before retrying");
}

export function assertReleaseServerFence(candidate, proof) {
  const current = normalizeServerCompatibility(proof, candidate);
  requireState(current.serverProtocol.min <= candidate.protocol.max && current.serverProtocol.max >= candidate.protocol.min,
    "production candidate has no live server protocol overlap");
  const hardMinimum = current.hardMinimum[candidate.platform];
  requireState(compareRelease(candidate.marketingVersion, candidate.build, hardMinimum.version, hardMinimum.build) >= 0,
    "production candidate is below the live server hard minimum");
  return current;
}

export function classifyObservedProductionAction(action, platform, candidate, snapshot,
  expectedRemoteFingerprint = candidate.remoteBaselineFingerprint, unchangedReadCount = 1, operation = null,
  adoptionApproval = null) {
  assertRemoteIdentity(platform, snapshot);
  if (platform === "ios" && ["advance", "pause"].includes(action)) {
    requireState(candidate.firstLaunch === false, "Apple phased release is unavailable for the first publish");
  }
  const remote = remoteBaselineFor(platform, snapshot);
  const candidateRemoteChanged = sha256Json(remote) !== expectedRemoteFingerprint;
  if (platform === "android") {
    const matching = (snapshot.productionTrack.releases ?? []).filter((release) =>
      (release.versionCodes ?? []).map(String).includes(String(candidate.build)));
    const release = matching.length === 1 ? matching[0] : null;
    const lifecycleMatching = (snapshot.productionLifecycle ?? []).filter((entry) =>
      entry.name === `${candidate.generation} (${candidate.build})` &&
      (entry.versionCodes ?? []).map(String).includes(String(candidate.build)));
    const lifecycle = lifecycleMatching.length === 1 ? lifecycleMatching[0] : null;
    const expectedStatus = action === "submit" ? (candidate.rollout.mode === "full" ? "completed" : "inProgress") : action === "pause" ? "halted" :
      action === "release" && candidate.firstLaunch ? "completed" : action === "release" || action === "advance" || action === "resume" ?
        (candidate.rollout.mode === "full" ? "completed" : "inProgress") : null;
    const requiresPublishedAvailability = ["release", "advance", "pause", "resume"].includes(action);
    const requiresRolloutFraction = ["inProgress", "halted"].includes(release?.status);
    const candidateIdentityMatches = release !== null && release.name === `${candidate.generation} (${candidate.build})` &&
      (release.versionCodes ?? []).map(String).includes(String(candidate.build));
    const lifecycleState = lifecycle?.lifecycleState ?? null;
    const reviewSubmitted = ["RELEASE_LIFECYCLE_STATE_IN_REVIEW", "RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED",
      "RELEASE_LIFECYCLE_STATE_PUBLISHED"].includes(lifecycleState);
    const publishedBeforeServerHealth = action === "submit" &&
      lifecycleState === "RELEASE_LIFECYCLE_STATE_PUBLISHED";
    let actionRequiredReason = null;
    if (action === "submit") {
      if (publishedBeforeServerHealth) {
        actionRequiredReason = "ACTION_REQUIRED_GOOGLE_PLAY: candidate became publicly available before server health; stop and reconcile";
      } else if (lifecycleState === "RELEASE_LIFECYCLE_STATE_NOT_APPROVED") {
        actionRequiredReason = "ACTION_REQUIRED_GOOGLE_PLAY: Google Play review was not approved; resolve the rejection in Play Console";
      } else if (!reviewSubmitted) {
        actionRequiredReason = "ACTION_REQUIRED_GOOGLE_PLAY: Google Play Send for review is required in Publishing overview";
      }
    } else if (action === "release") {
      if (lifecycleState === "RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED") {
        actionRequiredReason = "ACTION_REQUIRED_GOOGLE_PLAY: Google Play Publishing overview -> Publish changes is required";
      } else if (lifecycleState === "RELEASE_LIFECYCLE_STATE_IN_REVIEW") {
        actionRequiredReason = "ACTION_REQUIRED_GOOGLE_PLAY: Google Play review is still in progress; wait for APPROVED_NOT_PUBLISHED";
      } else if (lifecycleState === "RELEASE_LIFECYCLE_STATE_NOT_APPROVED") {
        actionRequiredReason = "ACTION_REQUIRED_GOOGLE_PLAY: Google Play review was not approved; resolve the rejection in Play Console";
      } else if (!lifecycleState || ["RELEASE_LIFECYCLE_STATE_DRAFT", "RELEASE_LIFECYCLE_STATE_NOT_SENT_FOR_REVIEW",
        "RELEASE_LIFECYCLE_STATE_UNSPECIFIED"].includes(lifecycleState)) {
        actionRequiredReason = "ACTION_REQUIRED_GOOGLE_PLAY: Google Play Send for review is required before production publication";
      }
    }
    const matched = release !== null && release.name === `${candidate.generation} (${candidate.build})` &&
      (expectedStatus === null || release.status === expectedStatus) &&
      (candidate.rollout.mode !== "staged" || !requiresRolloutFraction || release.userFraction === candidate.rollout.fraction) &&
      (action !== "submit" || reviewSubmitted) &&
      (!requiresPublishedAvailability || lifecycleState === "RELEASE_LIFECYCLE_STATE_PUBLISHED") &&
      (!publishedBeforeServerHealth);
    const available = matched && ["inProgress", "completed"].includes(release.status) && action !== "pause" &&
      lifecycleState === "RELEASE_LIFECYCLE_STATE_PUBLISHED";
    const assignmentJournaled = operation?.substeps?.some((step) =>
      ["google.track.update", "google.edit.commit"].includes(step.stepId) &&
      ["sent", "acknowledged", "uncertain", "observed"].includes(step.status));
    const assignmentConfirmed = ["release", "advance", "resume"].includes(action) && candidateIdentityMatches &&
      (assignmentJournaled || action === "release") &&
      ["RELEASE_LIFECYCLE_STATE_IN_REVIEW", "RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED"].includes(lifecycleState);
    return { matched, terminal: matched, mutation: matched, available, published: available,
      noMutation: !candidateRemoteChanged && !matched && unchangedReadCount >= 2,
      unchangedReadCount,
      authoritative: !candidateRemoteChanged || matched || candidateIdentityMatches,
      partial: !matched && candidateIdentityMatches,
      assignmentConfirmed,
      currentRemoteFingerprint: sha256Json(remote),
      completedSubsteps: candidateIdentityMatches ? ["google.edit.create", "google.track.update", "google.edit.commit"] : [],
      expectedRemoteFingerprint,
      candidateFingerprint: productionCandidateFingerprint(candidate),
      phase: action === "submit" ? "submitted" : release?.status === "halted" ? "paused" :
        release?.status === "completed" ? "completed" : "released",
      storeBuildId: release ? String(candidate.build) : null, lifecycleState,
      reviewSubmitted, publishedBeforeServerHealth, actionRequiredReason };
  }
  const allVersionMatches = snapshot.versions.filter((entry) => entry.versionString === candidate.marketingVersion);
  const conflictingVersion = allVersionMatches.some((entry) => entry.buildId && entry.buildId !== candidate.storeBuildId);
  const matching = allVersionMatches.filter((version) => !version.buildId || version.buildId === candidate.storeBuildId);
  const version = !conflictingVersion && matching.length === 1 ? matching[0] : null;
  const submitted = ["WAITING_FOR_REVIEW", "IN_REVIEW", "APPROVED", "COMPLETE"].includes(version?.reviewSubmissionState);
  const phaseState = version?.phasedReleaseState ?? null;
  const matched = version !== null && (action === "submit" ? submitted : action === "release" ?
    ["READY_FOR_SALE", "READY_FOR_DISTRIBUTION"].includes(version.state) &&
      (candidate.rollout.mode !== "staged" || phaseState === "ACTIVE") :
    action === "advance" ? phaseState === (candidate.rollout.mode === "full" ? "COMPLETE" : "ACTIVE") :
    action === "pause" ? phaseState === "PAUSED" : action === "resume" ? phaseState === "ACTIVE" : false);
  const available = matched && action !== "submit" && action !== "pause";
  const canRecoverSubstep = (stepId, remoteId = null) => {
    const journaled = operation?.substeps?.find((step) => step.stepId === stepId);
    return !journaled || !journaled.remoteId || journaled.remoteId === remoteId;
  };
  const versionIdentityMatches = version !== null && canRecoverSubstep("apple.version.create", version.id);
  const candidateIdentityMatches = versionIdentityMatches;
  const completedSubsteps = versionIdentityMatches ? ["apple.version.create"] : [];
  const substepRemoteIds = {};
  if (versionIdentityMatches && operation?.substeps?.some((step) => step.stepId === "apple.version.create")) {
    substepRemoteIds["apple.version.create"] = version.id;
  }
  if (version?.buildId === candidate.storeBuildId && canRecoverSubstep("apple.version.build")) {
    completedSubsteps.push("apple.version.build");
  }
  if (version?.phasedReleaseId && canRecoverSubstep("apple.phased-policy.create", version.phasedReleaseId)) {
    if (operation?.substeps?.some((step) => step.stepId === "apple.phased-policy.create")) {
      completedSubsteps.push("apple.phased-policy.create");
      substepRemoteIds["apple.phased-policy.create"] = version.phasedReleaseId;
    }
  }
  if (action === "submit" && version) {
    const submission = snapshot.reviewSubmissions?.find((entry) => entry.id === version.reviewSubmissionId) ??
      snapshot.reviewSubmissions?.filter((entry) => entry.versionId === version.id).at(-1);
    const replacementJournaled = operation?.substeps?.some((step) =>
      step.stepId.startsWith("apple.review-submission.replacement."));
    const reviewPrefix = replacementJournaled ? "apple.review-submission.replacement" : "apple.review-submission";
    const reviewCreateStep = operation?.substeps?.find((step) => step.stepId === `${reviewPrefix}.create`);
    let recoveredSubmission = submission;
    if (!recoveredSubmission && reviewCreateStep) {
      const detached = (snapshot.reviewSubmissions ?? []).filter((entry) => !entry.versionId && !entry.itemId);
      requireState(detached.length <= 1, "Apple review submission shell identity is ambiguous; reconcile manually");
      if (detached.length === 1 && canRecoverSubstep(`${reviewPrefix}.create`, detached[0].id)) {
        requireState(adoptionApproval && adoptionApproval.operationId === operation?.operationId &&
          adoptionApproval.remoteId === detached[0].id &&
          adoptionApproval.candidateFingerprint === productionCandidateFingerprint(operation.candidate),
        "Apple review submission shell requires explicit operation-bound adoption approval");
        requireState(detached[0].appId === snapshot.appId &&
          ["READY_FOR_REVIEW", "WAITING_FOR_REVIEW", "IN_REVIEW", "APPROVED", "COMPLETE"].includes(detached[0].state) &&
          detached[0].versionId === null && detached[0].itemId === null,
        "Apple review submission shell app, state, or association is not adoptable");
        recoveredSubmission = detached[0];
      }
    }
    const submissionId = version.reviewSubmissionId ?? recoveredSubmission?.id ?? null;
    if (submissionId && canRecoverSubstep(`${reviewPrefix}.create`, submissionId)) {
      completedSubsteps.push(`${reviewPrefix}.create`);
      if (reviewCreateStep) substepRemoteIds[`${reviewPrefix}.create`] = submissionId;
    }
    if (recoveredSubmission?.itemId && canRecoverSubstep(`${reviewPrefix}.item`, recoveredSubmission.itemId)) {
      completedSubsteps.push(`${reviewPrefix}.item`);
      if (operation?.substeps?.some((step) => step.stepId === `${reviewPrefix}.item`)) {
        substepRemoteIds[`${reviewPrefix}.item`] = recoveredSubmission.itemId;
      }
    }
    if (submitted && canRecoverSubstep(`${reviewPrefix}.submit`, submissionId)) {
      completedSubsteps.push(`${reviewPrefix}.submit`);
      if (operation?.substeps?.some((step) => step.stepId === `${reviewPrefix}.submit`)) {
        substepRemoteIds[`${reviewPrefix}.submit`] = submissionId;
      }
    }
  }
  return { matched, terminal: matched, mutation: matched, available, published: available,
      noMutation: !candidateRemoteChanged && !matched && unchangedReadCount >= 2,
      unchangedReadCount,
      authoritative: !candidateRemoteChanged || matched || candidateIdentityMatches,
      partial: !matched && candidateIdentityMatches,
      currentRemoteFingerprint: sha256Json(remote),
      completedSubsteps,
      substepRemoteIds,
      expectedRemoteFingerprint,
      candidateFingerprint: productionCandidateFingerprint(candidate),
      phase: action === "pause" ? "paused" : action === "advance" ? (phaseState === "COMPLETE" ? "completed" : "released") : action === "resume" ? "released" : action === "release" ? "released" : "submitted",
      storeBuildId: version?.buildId ?? null, versionId: version?.id ?? null };
}

export async function runProductionAction({
  action,
  platform,
  candidate,
  clients,
  snapshot,
  serverProof,
  registry,
  operationId,
  requestFingerprint,
  expectedRemoteFingerprint,
  expectedActivationFingerprint = null,
  activationFenceFetcher,
  serverProofFetcher,
  releaseApproved = false,
  approvalFingerprint,
  transition = null,
  metadataPacket = null,
  substepRecorder = null,
  substepGuard = null,
  substepLookup = null,
  reviewSubmissionAdoption = null,
  managedPublishingAttestation = null,
  now = new Date().toISOString()
}) {
  validateProductionCandidate(candidate, platform);
  requireState(["submit", "reconcile", "release", "advance", "pause", "resume"].includes(action),
    "production action cannot mutate from this entry point");
  const prior = productionStatus(registry, platform).operations.find((entry) => entry.operationId === operationId);
  transition ??= prior?.transition ?? null;
  const effectiveCandidate = transition ? applyProductionTransition(candidate, transition) : candidate;
  if (prior !== undefined) {
    requireState(sha256Json(prior.candidate) === sha256Json(candidate),
      "production operation candidate identity changed during retry");
    if (prior.status === "succeeded") return { registry, outcome: prior.receipt, skipped: true };
    if (prior.status === "failed") requireState(false, "failed production action requires reconciliation before retry");
  }
  if (["release", "advance", "pause", "resume"].includes(action)) {
    assertProductionReleaseApproval(candidate, releaseApproved, approvalFingerprint, transition);
  }
  assertReleaseServerFence(candidate, serverProof);
  const transitionFingerprint = expectedRemoteFingerprint ?? sha256Json(remoteBaselineFor(platform, snapshot));
  assertTransitionSnapshot(transitionFingerprint, platform, snapshot);
  assertActivationFence(candidate, expectedActivationFingerprint);
  let next = beginProductionOperation(registry, { operationId, platform, action, candidate,
    expectedBaselineFingerprint: productionIdentityFingerprint(productionStatus(registry, platform).baseline),
    expectedRemoteFingerprint: transitionFingerprint, expectedActivationFingerprint, requestFingerprint, transition, startedAt: now });
  const recordSubstep = substepRecorder ? (step) => {
    const updated = substepRecorder(step, next);
    if (updated !== undefined) next = updated;
  } : null;
  const lookupSubstep = substepLookup ? (stepId) => substepLookup(stepId, next) : null;
  const guardSubstep = substepGuard ? (stepId, fingerprint) => substepGuard(stepId, fingerprint, next) : null;
  // The pending registry receipt is the durable fence. Take a fresh read after it
  // is committed; a changed store or server now fails before the store write.
  try {
    const freshSnapshot = await snapshotFor(platform, clients);
    assertTransitionSnapshot(transitionFingerprint, platform, freshSnapshot);
    const freshActivationFingerprint = activationFenceFetcher ? await activationFenceFetcher() : expectedActivationFingerprint;
    assertActivationFence(candidate, freshActivationFingerprint);
    assertReleaseServerFence(candidate, serverProofFetcher ? await serverProofFetcher(candidate) : serverProof);
    // Every store mutation receives the journal identity, even when it has no
    // per-substep recorder. Google uses this binding for its fresh pre-submit
    // Console eligibility proof before opening or committing an edit.
    const storeContext = buildProductionStoreContext({ operationId, candidate, recordSubstep,
      assertSubstepWritable: guardSubstep, getSubstep: lookupSubstep, reviewSubmissionAdoption,
      managedPublishingAttestation });
    const result = await callStoreAction(action, platform, clients, freshSnapshot, effectiveCandidate, metadataPacket,
      storeContext);
    const operation = productionStatus(next, platform).operations.find((entry) => entry.operationId === operationId);
    const observed = classifyObservedProductionAction(action, platform, effectiveCandidate,
      await snapshotFor(platform, clients), transitionFingerprint, 1, operation, reviewSubmissionAdoption);
    requireState(!observed.actionRequiredReason, observed.actionRequiredReason ?? "Google production lifecycle is not ready for this action");
    observed.candidateFingerprint = productionCandidateFingerprint(candidate);
    if (transition) observed.transitionFingerprint = transition.fingerprint;
    const receipt = { schemaVersion: 1, operationId, action, platform, candidate: identityReceipt(candidate),
      transition: transition ? sanitizeStoreResult(transition) : null,
      observedAt: new Date().toISOString(), response: sanitizeStoreResult(result) };
    next = finishProductionOperation(next, operationId, { status: "succeeded", receipt, remote: observed, updatedAt: new Date().toISOString() });
    return { registry: next, outcome: receipt, skipped: false };
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    failure.productionRegistry = markProductionUncertain(next, operationId, { receipt: {
      schemaVersion: 1, operationId, action, platform, uncertainAt: new Date().toISOString()
    } });
    throw failure;
  }
}

export async function reconcileProductionAction({ action, platform, candidate, clients, registry, operationId,
  expectedRemoteFingerprint, expectedActivationFingerprint = null, activationFenceFetcher,
  reviewSubmissionAdoption = null, now = new Date().toISOString() }) {
  validateProductionCandidate(candidate, platform);
  const operation = productionStatus(registry, platform).operations.find((entry) => entry.operationId === operationId);
  requireState(operation !== undefined, `unknown production operation ${operationId}`);
  requireState(sha256Json(operation.candidate) === sha256Json(candidate),
    "reconcile operation candidate identity changed");
  expectedRemoteFingerprint ??= operation.expectedRemoteFingerprint;
  const transition = operation.transition ?? null;
  const effectiveCandidate = transition ? applyProductionTransition(candidate, transition) : candidate;
  const snapshot = await snapshotFor(platform, clients);
  const currentActivationFingerprint = activationFenceFetcher ? await activationFenceFetcher() : expectedActivationFingerprint;
  assertActivationFence(candidate, currentActivationFingerprint);
  const observed = await classifyWithNoMutationConfirmation(action, platform, effectiveCandidate, snapshot,
    expectedRemoteFingerprint, clients, operation, reviewSubmissionAdoption);
  observed.candidateFingerprint = productionCandidateFingerprint(candidate);
  if (transition) observed.transitionFingerprint = transition.fingerprint;
  const receipt = { schemaVersion: 1, operationId, action, platform, candidate: identityReceipt(candidate),
    transition: transition ? sanitizeStoreResult(transition) : null,
    observedAt: now, observed: sanitizeStoreResult(observed) };
  const next = reconcileProductionOperation(registry, operationId, { observed, receipt, reconciledAt: now });
  return { registry: next, observed, receipt, resolved: next !== registry };
}

export function assertRemoteIdentity(platform, snapshot) {
  if (platform === "android") requireState(snapshot?.packageName === "com.ashatlas.game" && snapshot.productionTrack?.track === "production",
    "Google production snapshot app/track identity is invalid");
  else requireState(snapshot?.bundleId === "com.ashatlas.game", "Apple production snapshot app identity is invalid");
}

async function snapshotFor(platform, clients) {
  return platform === "android" ? productionGoogleSnapshot(clients.google) : productionAppleSnapshot(clients.apple);
}

async function classifyWithNoMutationConfirmation(action, platform, candidate, snapshot,
  expectedRemoteFingerprint, clients, operation = null, adoptionApproval = null) {
  const first = classifyObservedProductionAction(action, platform, candidate, snapshot, expectedRemoteFingerprint, 1,
    operation, adoptionApproval);
  if (first.matched || sha256Json(remoteBaselineFor(platform, snapshot)) !== expectedRemoteFingerprint) return first;
  // An unchanged read immediately after a lost response can race an async store
  // write. Require a second independent snapshot before declaring no mutation.
  const confirmation = await snapshotFor(platform, clients);
  const sameRemote = sha256Json(remoteBaselineFor(platform, confirmation)) ===
    sha256Json(remoteBaselineFor(platform, snapshot));
  const confirmed = classifyObservedProductionAction(action, platform, candidate, confirmation,
    expectedRemoteFingerprint, sameRemote ? 2 : 1, operation, adoptionApproval);
  const recoveredSubstep = confirmed.partial && Object.keys(confirmed.substepRemoteIds ?? {}).length > 0;
  if (operation?.substeps?.length > 0 && confirmed.noMutation && !recoveredSubstep && confirmed.assignmentConfirmed !== true) {
    // A mutation request was already journaled. Even two unchanged reads do
    // not prove that an asynchronous store write did not land; keep it
    // unresolved until a terminal store state is observed.
    confirmed.noMutation = false;
    confirmed.authoritative = false;
  }
  return confirmed;
}

async function callStoreAction(action, platform, clients, snapshot, candidate, metadataPacket = null, context = null) {
  const api = platform === "android" ? clients.google : clients.apple;
  if (platform === "android") {
    if (action === "submit") return submitGoogleProduction(api, snapshot, candidate, metadataPacket, context);
    if (action === "release") return releaseGoogleProduction(api, snapshot, candidate, metadataPacket, context);
    if (action === "advance") return advanceGoogleProduction(api, snapshot, candidate, metadataPacket, context);
    if (action === "resume") return resumeGoogleProduction(api, snapshot, candidate, metadataPacket, context);
    return pauseGoogleProduction(api, snapshot, candidate, metadataPacket, context);
  }
  if (action === "submit") return submitAppleProduction(api, snapshot, candidate, metadataPacket, context);
  if (action === "release") return releaseAppleProduction(api, snapshot, candidate, metadataPacket, context);
  if (action === "advance") return advanceAppleProduction(api, snapshot, candidate,
    { complete: candidate.rollout.mode === "full" }, metadataPacket, context);
  if (action === "resume") return resumeAppleProduction(api, snapshot, candidate, metadataPacket, context);
  return pauseAppleProduction(api, snapshot, candidate, metadataPacket, context);
}

function identityReceipt(candidate) {
  return { sourceSha: candidate.sourceSha, acceptedSha: candidate.acceptedSha, generation: candidate.generation,
    platform: candidate.platform, marketingVersion: candidate.marketingVersion, build: candidate.build,
    storeBuildId: candidate.storeBuildId, artifactSha256: candidate.artifactSha256, metadataHash: candidate.metadataHash,
    countries: candidate.countries, rollout: candidate.rollout, toolingApproval: candidate.toolingApproval,
    publishedMasterSha: candidate.publishedMasterSha ?? null,
    activationFenceFingerprint: candidate.activationFenceFingerprint ?? null };
}

function sanitizeStoreResult(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

function reviewSubmissionAdoption(operationId, candidate) {
  const remoteId = process.env.PRODUCTION_REVIEW_SHELL_ADOPTION_ID;
  if (!remoteId) return null;
  return { operationId, remoteId, candidateFingerprint: productionCandidateFingerprint(candidate) };
}

function compareRelease(leftVersion, leftBuild, rightVersion, rightBuild) {
  const left = String(leftVersion).split(/[.-]/u).slice(0, 3).map(Number);
  const right = String(rightVersion).split(/[.-]/u).slice(0, 3).map(Number);
  for (let index = 0; index < 3; index += 1) if (left[index] !== right[index]) return left[index] - right[index];
  return Number(leftBuild) - Number(rightBuild);
}

function requireState(condition, message) {
  if (!condition) throw new Error(message);
}

function requiredEnv(name) {
  const value = process.env[name];
  requireState(typeof value === "string" && value.length > 0, `${name} is required`);
  return value;
}

function readActivationFence() {
  const status = registry("activation-status");
  const intent = status.activationIntent;
  return { intentId: intent?.intentId ?? null, fingerprint: intent ? sha256Json(intent) : null };
}

async function main() {
  const action = process.argv[2];
  requireState(PRODUCTION_ACTIONS.includes(action), `usage: production.mjs ${PRODUCTION_ACTIONS.join("|")}`);
  const platforms = String(process.env.PLATFORM_LIST ?? "ios,android").split(",").filter(Boolean);
  requireState(platforms.length > 0 && platforms.every((platform) => ["ios", "android"].includes(platform)), "invalid production platform list");
  if (action === "inspect" || process.env.DRY_RUN === "true") {
    const clients = await createProductionClients({ mutable: false, platforms });
    const snapshots = {};
    for (const platform of platforms) snapshots[platform] = await snapshotFor(platform, clients);
    const production = registry("production-status").production;
    if (action === "inspect") return emit({ action, dryRun: true, snapshots, production });
    return emit({ action, dryRun: true, snapshots, production,
      plan: "production mutation is disabled in dry-run mode" });
  }
  requireState(process.env.DRY_RUN === "false", "production actions default to dry-run; set DRY_RUN=false explicitly");
  if (["cancel", "reconcile", "release", "advance", "pause", "resume"].includes(action)) {
    requireState(platforms.length === 1,
      `${action} requires one platform so its candidate, approval, and operation identity stay exact`);
  }
  const storeMutation = ["submit", "release", "advance", "pause", "resume"].includes(action);
  const registryMutation = ["prepare", "cancel", "submit", "reconcile", "release", "advance", "pause", "resume"].includes(action);
  if (registryMutation) requireState(process.env.ASH_ATLAS_PRODUCTION_MUTATION === "true", "production mutation gate is not enabled");
  const clients = await createProductionClients({ mutable: storeMutation, platforms });
  const snapshots = Object.fromEntries(await Promise.all(platforms.map(async (platform) => [platform, await snapshotFor(platform, clients)])));
  return runActions(action, platforms, snapshots, clients);
}

async function runActions(action, platforms, snapshots, clients) {
  const output = { action, dryRun: false, platforms: {} };
  for (const platform of platforms) {
    const status = registry("production-status", ["--platform", platform]);
    const releaseStatus = registry("inspect", ["--release-id", requiredEnv("RELEASE_ID")]);
    const release = releaseStatus.reservations[platform];
    if (action === "prepare") {
      output.platforms[platform] = await prepareFromStatus(platform, snapshots[platform], clients);
      continue;
    }
    const candidate = status.production.candidate;
    requireState(candidate, `${platform} has no prepared production candidate`);
    const binding = assertInvocationBinding(candidate, release, platform);
    const activation = readActivationFence();
    if (action === "cancel") {
      const candidateFingerprint = requiredEnv("PRODUCTION_CANDIDATE_SHA256");
      requireState(candidateFingerprint === productionCandidateFingerprint(candidate),
        "production cancellation is not bound to the prepared candidate");
      assertRemoteBaseline(candidate, platform, snapshots[platform]);
      assertActivationFence(candidate, activation.fingerprint);
      const reason = requiredEnv("PRODUCTION_CANCEL_REASON");
      const cancelled = registry("production-cancel", ["--request", JSON.stringify({ platform,
        candidateFingerprint, remoteBaselineFingerprint: candidate.remoteBaselineFingerprint, reason })]);
      output.platforms[platform] = { cancelled: true, registry: cancelled.registry ?? null };
      continue;
    }
    if (action === "reconcile") {
      const operationId = requiredEnv("PRODUCTION_OPERATION_ID");
      const operation = status.production.operations.find((entry) => entry.operationId === operationId);
      requireState(operation, `${platform} has no production operation ${operationId} to reconcile`);
      requireState(sha256Json(operation.candidate) === sha256Json(candidate),
        "reconcile operation candidate does not match the prepared candidate");
      assertActivationFence(candidate, activation.fingerprint);
      const transition = operation.transition ?? null;
      const observedCandidate = transition ? applyProductionTransition(candidate, transition) : candidate;
      const observed = await classifyWithNoMutationConfirmation(operation.action, platform, observedCandidate,
        snapshots[platform], operation.expectedRemoteFingerprint, clients, operation,
        reviewSubmissionAdoption(operationId, candidate));
      observed.candidateFingerprint = productionCandidateFingerprint(candidate);
      if (transition) observed.transitionFingerprint = transition.fingerprint;
      const receipt = { schemaVersion: 1, operationId, action: operation.action, platform,
        candidate: identityReceipt(candidate), transition: transition ? sanitizeStoreResult(transition) : null,
        observedAt: new Date().toISOString(), observed: sanitizeStoreResult(observed) };
      const resolved = registry("production-reconcile", ["--operation-id", operationId, "--observed", JSON.stringify(observed),
        "--receipt", JSON.stringify(receipt)]);
      output.platforms[platform] = { observed, receipt, resolved: resolved.production?.operations?.find((entry) => entry.operationId === operationId)?.status === "succeeded" };
      continue;
    }
    const operationId = process.env.PRODUCTION_OPERATION_ID || `${candidate.operationId}:${action}`;
    const priorOperation = status.production.operations.find((entry) => entry.operationId === operationId);
    if (priorOperation && ["pending", "uncertain"].includes(priorOperation.status) &&
        priorOperation.substeps?.some((step) => ["sent", "uncertain"].includes(step.status))) {
      requireState(false, `${platform} production operation ${operationId} has an unresolved store substep; reconcile that exact operation before retrying`);
    }
    if (priorOperation?.status === "succeeded") {
      // A successful retry is a read-only journal lookup. Never issue another
      // store request for an operation whose publication receipt is terminal.
      output.platforms[platform] = { outcome: priorOperation.receipt, skipped: true, readOnly: true };
      continue;
    }
    const releaseApproved = process.env.PRODUCTION_RELEASE_APPROVED === "true";
    const approvalFingerprint = process.env.PRODUCTION_RELEASE_APPROVAL_SHA256;
    const expectedRemoteFingerprint = sha256Json(remoteBaselineFor(platform, snapshots[platform]));
    const transition = buildRequestedTransition(candidate, action, binding.rollout, operationId,
      expectedRemoteFingerprint, approvalFingerprint);
    if (transition) assertProductionMetadataBinding(binding.metadataPacket, platform, candidate,
      candidate.rollout, candidate.countries);
    if (["release", "advance", "pause", "resume"].includes(action)) {
      assertProductionReleaseApproval(candidate, releaseApproved, approvalFingerprint, transition);
    }
    assertActivationFence(candidate, activation.fingerprint);
    const result = await executeWithUncertainty({ action, platform, candidate, clients,
      operationId, releaseApproved, approvalFingerprint, transition,
      metadataPacket: binding.metadataPacket, expectedRemoteFingerprint,
      expectedActivationFingerprint: activation.fingerprint,
      reviewSubmissionAdoption: reviewSubmissionAdoption(operationId, candidate) });
    output.platforms[platform] = result;
  }
  return emit(output);
}

async function prepareFromStatus(platform, snapshot, clients) {
  if (clients) snapshot = await snapshotFor(platform, clients);
  const status = registry("inspect", ["--release-id", process.env.RELEASE_ID]);
  const release = status.reservations[platform];
  const prior = registry("production-status", ["--platform", platform]).production?.candidate ?? null;
  assertAcceptedRelease(release, { sourceSha: process.env.SOURCE_SHA, generation: process.env.GENERATION });
  const proof = await verifyLiveServerCompatibility({ platform, version: release.marketingVersion, build: release.build,
    sourceSha: release.sourceSha, protocolMin: release.protocol.min, protocolMax: release.protocol.max });
  const candidate = candidateRequest(release, platform, snapshot, proof, readActivationFence(), prior);
  const result = registry("production-prepare", ["--request", JSON.stringify(candidate)]);
  return result.production ?? result;
}

function buildRequestedTransition(candidate, action, requestedRollout, operationId,
  expectedRemoteFingerprint, approvalFingerprint) {
  if (!["release", "advance", "pause", "resume"].includes(action)) {
    requireState(sha256Json(candidate.rollout) === sha256Json(requestedRollout),
      "submit cannot change the prepared rollout policy; prepare a new candidate");
    return null;
  }
  if (sha256Json(candidate.rollout) === sha256Json(requestedRollout)) return null;
  return buildProductionTransition(candidate, { operationId, action, expectedRemoteFingerprint,
    toRollout: requestedRollout, approvalFingerprint });
}

async function executeWithUncertainty({ action, platform, candidate, clients, operationId, releaseApproved,
  approvalFingerprint, transition = null, metadataPacket = null, expectedRemoteFingerprint, expectedActivationFingerprint,
  reviewSubmissionAdoption = null, managedPublishingAttestation = null }) {
  const effectiveCandidate = transition ? applyProductionTransition(candidate, transition) : candidate;
  if (["release", "advance", "pause", "resume"].includes(action)) {
    assertProductionReleaseApproval(candidate, releaseApproved, approvalFingerprint, transition);
  }
  beginRegistry(operationId, platform, action, candidate, expectedRemoteFingerprint, expectedActivationFingerprint, transition);
  try {
    const freshServerProof = await liveProof(candidate);
    assertReleaseServerFence(candidate, freshServerProof);
    const freshSnapshot = await snapshotFor(platform, clients);
    assertTransitionSnapshot(expectedRemoteFingerprint, platform, freshSnapshot);
    assertActivationFence(candidate, readActivationFence().fingerprint);
    const substepRecorder = (step) => registry("production-substep", ["--operation-id", operationId,
      "--step", JSON.stringify(step)]);
    const freshManagedPublishingAttestation = platform === "android" && action === "submit"
      ? managedPublishingAttestation ?? readGoogleManagedPublishingAttestation()
      : null;
    const substepContext = buildProductionStoreContext({ operationId, candidate,
      managedPublishingAttestation: freshManagedPublishingAttestation,
      recordSubstep: substepRecorder,
      reviewSubmissionAdoption,
      getSubstep: (stepId) => registry("production-status", ["--platform", platform]).production.operations
        .find((entry) => entry.operationId === operationId)?.substeps?.find((step) => step.stepId === stepId),
      assertSubstepWritable: (stepId, requestFingerprint) => {
        const journal = registry("production-status", ["--platform", platform]).production.operations
          .find((entry) => entry.operationId === operationId);
        const priorStep = journal?.substeps?.find((entry) => entry.stepId === stepId);
        requireState(!priorStep || priorStep.requestFingerprint === requestFingerprint,
          "production substep request identity changed during retry");
        requireState(!priorStep || !["sent", "uncertain"].includes(priorStep.status),
          `production substep ${stepId} remains unresolved; reconcile before retrying`);
      } });
    const storeResult = await callStoreAction(action, platform, clients, freshSnapshot, effectiveCandidate, metadataPacket,
      substepContext);
    const observed = classifyObservedProductionAction(action, platform, effectiveCandidate, await snapshotFor(platform, clients),
      expectedRemoteFingerprint);
    observed.candidateFingerprint = productionCandidateFingerprint(candidate);
    if (transition) observed.transitionFingerprint = transition.fingerprint;
    const receipt = { schemaVersion: 1, operationId, action, platform, candidate: identityReceipt(candidate),
      transition: transition ? sanitizeStoreResult(transition) : null,
      observedAt: new Date().toISOString(), response: sanitizeStoreResult(storeResult), observed: sanitizeStoreResult(observed) };
    const finished = registry("production-finish", ["--operation-id", operationId, "--status", "succeeded",
      "--receipt", JSON.stringify(receipt), "--remote", JSON.stringify(observed)]);
    return { outcome: receipt, registry: finished.registry ?? null, skipped: false };
  } catch (error) {
    try { registry("production-uncertain", ["--operation-id", operationId, "--receipt", JSON.stringify({ schemaVersion: 1,
      operationId, action, platform, uncertainAt: new Date().toISOString() })]); } catch { /* preserve original failure; reconcile remains required */ }
    throw error;
  }
}

export function buildProductionStoreContext({ operationId, candidate, recordSubstep = null,
  assertSubstepWritable = null, getSubstep = null, reviewSubmissionAdoption = null,
  managedPublishingAttestation = null }) {
  return { operationId, candidateFingerprint: productionCandidateFingerprint(candidate),
    recordSubstep, assertSubstepWritable, getSubstep, reviewSubmissionAdoption,
    managedPublishingAttestation };
}

function beginRegistry(operationId, platform, action, candidate, expectedRemoteFingerprint, expectedActivationFingerprint,
  transition = null) {
  const current = registry("production-status", ["--platform", platform]);
  requireState(typeof expectedRemoteFingerprint === "string", "production transition requires a fresh store snapshot");
  return registry("production-begin", ["--request", JSON.stringify({ operationId, platform, action, candidate,
    expectedBaselineFingerprint: productionIdentityFingerprint(current.production.baseline),
    expectedRemoteFingerprint,
    expectedActivationFingerprint: expectedActivationFingerprint ?? null,
    requestFingerprint: sha256Json({ action, candidate, transition }), transition })]);
}

async function liveProof(candidate) {
  return verifyLiveServerCompatibility({ platform: candidate.platform, version: candidate.marketingVersion, build: candidate.build,
    sourceSha: candidate.sourceSha, protocolMin: candidate.protocol.min, protocolMax: candidate.protocol.max });
}

export function candidateRequest(release, platform, snapshot, proof, activation, priorCandidate = null) {
  const toolSha = process.env.PRODUCTION_TOOL_SHA ?? process.env.GITHUB_SHA;
  requireState(/^[0-9a-f]{40}$/u.test(toolSha ?? ""), "production tooling SHA must be exact");
  const currentPublishedMasterSha = process.env.PRODUCTION_MASTER_SHA;
  requireState(/^[0-9a-f]{40}$/u.test(currentPublishedMasterSha ?? ""), "published master SHA must be exact");
  const metadataHash = process.env[`${platform.toUpperCase()}_PRODUCTION_METADATA_SHA256`] ?? process.env.PRODUCTION_METADATA_SHA256;
  requireState(/^[0-9a-f]{64}$/u.test(metadataHash ?? ""), "production metadata hash is required");
  const metadataPacket = readApprovedMetadataPacket(platform);
  requireState(metadataPacket.hash === metadataHash,
    `${platform} approved production metadata packet does not match the prepared SHA256`);
  const countries = normalizeProductionCountries(process.env[`${platform.toUpperCase()}_PRODUCTION_COUNTRIES`] ?? process.env.PRODUCTION_COUNTRIES ?? "");
  const rollout = parseProductionRollout(process.env[`${platform.toUpperCase()}_PRODUCTION_ROLLOUT`] ?? process.env.PRODUCTION_ROLLOUT,
    { kind: snapshot.firstLaunch ? "first-publish" : "update", mode: snapshot.firstLaunch && platform === "android" ? "full" : "manual" });
  const managedPublishing = platform === "android"
    ? process.env.GOOGLE_PLAY_MANAGED_PUBLISHING === "true" : null;
  const firstPublicationBootstrapVerified = platform === "android" && snapshot.firstLaunch
    ? process.env.GOOGLE_PLAY_FIRST_PUBLICATION_BOOTSTRAP === "true" : false;
  const operationId = process.env.PRODUCTION_CANDIDATE_ID ?? `${release.releaseId}:${platform}`;
  const normalizedProof = normalizeServerCompatibility(proof, { platform });
  const comparableProof = structuredClone(normalizedProof);
  delete comparableProof.observedAt;
  const priorProof = priorCandidate?.serverCompatibility ? structuredClone(priorCandidate.serverCompatibility) : null;
  if (priorProof) delete priorProof.observedAt;
  const remoteBaseline = remoteBaselineFor(platform, snapshot);
  const priorRemoteBaselineFingerprint = priorCandidate?.remoteBaselineFingerprint ??
    (priorCandidate?.remoteBaseline ? sha256Json(priorCandidate.remoteBaseline) : null);
  const reusableCandidate = priorCandidate && priorCandidate.operationId === operationId &&
    priorCandidate.releaseId === release.releaseId && priorCandidate.platform === platform &&
    priorCandidate.sourceSha === release.sourceSha && priorCandidate.generation === release.generation &&
    priorCandidate.marketingVersion === release.marketingVersion && priorCandidate.build === release.build &&
    priorCandidate.storeBuildId === release.storeBuildId && priorCandidate.artifactSha256 === release.artifactSha256 &&
    (priorCandidate.toolSha ?? priorCandidate.toolingApproval?.toolSha) === toolSha && priorCandidate.metadataHash === metadataHash &&
    sha256Json(priorCandidate.countries) === sha256Json(countries) &&
    sha256Json(priorCandidate.rollout) === sha256Json(rollout) &&
    (priorCandidate.managedPublishing ?? (platform === "android" ? false : null)) === managedPublishing &&
    (priorCandidate.firstPublicationBootstrapVerified ?? false) === firstPublicationBootstrapVerified &&
    sha256Json(priorProof) === sha256Json(comparableProof) &&
    priorRemoteBaselineFingerprint === sha256Json(remoteBaseline) &&
    priorCandidate.activationFenceFingerprint === (activation?.fingerprint ?? null)
    ? priorCandidate : null;
  const publishedMasterSha = reusableCandidate?.publishedMasterSha ?? currentPublishedMasterSha;
  const reusableApproval = reusableCandidate ? structuredClone(reusableCandidate.toolingApproval) : null;
  const toolingApproval = reusableApproval ?? { approved: true, toolSha, actor: process.env.GITHUB_ACTOR ?? "operator",
    receiptUrl: process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : "https://github.com/local/actions/runs/1",
    approvedAt: new Date().toISOString() };
  const candidate = { releaseId: release.releaseId, platform, operationId, sourceSha: release.sourceSha,
    acceptedSha: release.sourceSha, generation: release.generation, toolingApproval,
    marketingVersion: release.marketingVersion, build: release.build, storeBuildId: release.storeBuildId,
    artifactSha256: release.artifactSha256, metadataHash, countries, rollout,
    serverCompatibility: normalizedProof, remoteBaseline,
    publishedMasterSha, activationFenceFingerprint: activation?.fingerprint ?? null,
    managedPublishing, firstPublicationBootstrapVerified };
  assertProductionMetadataBinding(metadataPacket.packet, platform, candidate, rollout, countries);
  return candidate;
}

export function readGoogleManagedPublishingAttestation(env = process.env) {
  const path = env.GOOGLE_PLAY_MANAGED_PUBLISHING_ATTESTATION_PATH;
  requireState(typeof path === "string" && path.length > 0,
    "ACTION_REQUIRED_GOOGLE_PLAY: managed-publishing Console attestation path is required");
  let attestation;
  try {
    attestation = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("ACTION_REQUIRED_GOOGLE_PLAY: managed-publishing Console attestation is unavailable or invalid JSON");
  }
  return attestation;
}

function registry(command, args = []) {
  const full = ["tools/mobile-release/registry-remote.mjs", command, ...args];
  if (process.env.PRODUCTION_REGISTRY_FILE) full.push("--file", process.env.PRODUCTION_REGISTRY_FILE);
  else {
    if (process.env.PRODUCTION_REGISTRY_REMOTE) full.push("--remote", process.env.PRODUCTION_REGISTRY_REMOTE);
    if (process.env.PRODUCTION_REGISTRY_BRANCH) full.push("--branch", process.env.PRODUCTION_REGISTRY_BRANCH);
    if (process.env.PRODUCTION_REGISTRY_SEED) full.push("--seed", process.env.PRODUCTION_REGISTRY_SEED);
  }
  return JSON.parse(execFileSync(process.execPath, full, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
}

function emit(value) {
  const output = JSON.stringify(value, null, 2);
  if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `production_result=${JSON.stringify(output)}\n`, { flag: "a" });
  process.stdout.write(`${output}\n`);
  return value;
}

if (process.argv[1] && process.argv[1].endsWith("production.mjs")) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
