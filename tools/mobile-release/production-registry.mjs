import { createHash } from "node:crypto";

import { validateRegistry } from "./registry.mjs";

const PLATFORMS = new Set(["ios", "android"]);
const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const GENERATION = /^t\d{3,4}$/u;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const COUNTRY = /^[A-Z]{2}$/u;

export const PRODUCTION_SCHEMA_VERSION = 1;
export const PRODUCTION_ACTIONS = ["prepare", "submit", "reconcile", "release", "advance", "pause", "resume"];
export const PRODUCTION_OPERATION_STATES = ["pending", "uncertain", "succeeded", "failed"];

/**
 * Production state is deliberately separate from the beta release fields. A beta
 * build can be the source of a production candidate, but beta track state never
 * becomes the production baseline by accident.
 */
export function emptyProductionState() {
  return {
    schemaVersion: PRODUCTION_SCHEMA_VERSION,
    platforms: {
      ios: { baseline: null, candidate: null, phase: "idle", history: [] },
      android: { baseline: null, candidate: null, phase: "idle", history: [] }
    },
    operations: [],
    cancellations: []
  };
}

export function productionState(registry) {
  validateRegistry(registry);
  if (registry.production === undefined) return emptyProductionState();
  const state = structuredClone(registry.production);
  // The production journal was introduced after the base release registry. Keep
  // older prepared state readable, while every new write records cancellations.
  state.cancellations ??= [];
  state.operations ??= [];
  for (const platform of ["ios", "android"]) {
    const candidate = state.platforms[platform]?.candidate;
    if (candidate) {
      if (!Object.prototype.hasOwnProperty.call(candidate, "managedPublishing")) {
        candidate.managedPublishing = platform === "android" ? false : null;
      }
      if (!Object.prototype.hasOwnProperty.call(candidate, "firstPublicationBootstrapVerified")) {
        candidate.firstPublicationBootstrapVerified = false;
      }
    }
  }
  for (const operation of state.operations ?? []) {
    operation.expectedBaselineFingerprint ??= null;
    operation.expectedRemoteFingerprint ??= null;
    operation.expectedActivationFingerprint ??= null;
    operation.requestFingerprint ??= null;
    operation.transition ??= null;
    operation.substeps ??= [];
    operation.receipt ??= null;
    if (!Object.prototype.hasOwnProperty.call(operation.candidate, "managedPublishing")) {
      operation.candidate.managedPublishing = operation.platform === "android" ? false : null;
    }
    if (!Object.prototype.hasOwnProperty.call(operation.candidate, "firstPublicationBootstrapVerified")) {
      operation.candidate.firstPublicationBootstrapVerified = false;
    }
  }
  validateProductionState(state);
  return state;
}

export function validateProductionState(state) {
  failUnless(object(state) && state.schemaVersion === PRODUCTION_SCHEMA_VERSION,
    "production state schemaVersion must be 1");
  failUnless(object(state.platforms), "production platforms are required");
  for (const platform of PLATFORMS) {
    const entry = state.platforms[platform];
    failUnless(object(entry), `production ${platform} state is required`);
    failUnless(["idle", "prepared", "submitted", "pending", "released", "advancing", "paused", "halted", "completed"].includes(entry.phase),
      `production ${platform} phase is invalid`);
    if (entry.baseline !== null) validateProductionIdentity(entry.baseline, platform, "baseline");
    if (entry.candidate !== null) validateProductionCandidate(entry.candidate, platform);
    failUnless(Array.isArray(entry.history), `production ${platform} history is required`);
    const historyIds = new Set();
    for (const identity of entry.history) {
      validateProductionIdentity(identity, platform, "history");
      failUnless(!historyIds.has(identity.storeBuildId), `production ${platform} history contains a duplicate store build`);
      historyIds.add(identity.storeBuildId);
    }
    if (entry.baseline !== null) failUnless(entry.history.some((identity) => identity.storeBuildId === entry.baseline.storeBuildId),
      `production ${platform} baseline is missing from history`);
  }
  failUnless(Array.isArray(state.operations), "production operations are required");
  const operationIds = new Set();
  for (const operation of state.operations) {
    validateProductionOperation(operation);
    failUnless(!operationIds.has(operation.operationId), "production operation IDs must be unique");
    operationIds.add(operation.operationId);
  }
  failUnless(Array.isArray(state.cancellations), "production cancellations are required");
  for (const cancellation of state.cancellations) validateProductionCancellation(cancellation);
  return state;
}

export function prepareProductionCandidate(registry, {
  platform,
  release,
  operationId,
  toolingApproval,
  metadataHash,
  countries = [],
  rollout,
  serverCompatibility,
  remoteBaseline,
  publishedMasterSha,
  activationFenceFingerprint = null,
  managedPublishing = null,
  firstPublicationBootstrapVerified = false,
  preparedAt = new Date().toISOString()
}) {
  validateRegistry(registry);
  const result = structuredClone(registry);
  const state = productionState(result);
  const source = assertVerifiedRelease(release, platform);
  const candidate = makeCandidate({ platform, source, operationId, toolingApproval, metadataHash,
    countries, rollout, serverCompatibility, remoteBaseline, publishedMasterSha, activationFenceFingerprint,
    managedPublishing, firstPublicationBootstrapVerified, preparedAt });
  if (remoteBaseline?.firstLaunch !== undefined) {
    failUnless(candidate.firstLaunch === remoteBaseline.firstLaunch,
      "production first-publish classification changed during prepare");
  }
  if (platform === "ios" && candidate.firstLaunch) failUnless(["manual", "full"].includes(candidate.rollout.mode),
    "Apple first publish requires a manual rollout mode");
  const current = state.platforms[platform];
  if (current.candidate !== null) {
    if (samePrepareIdentity(current.candidate, candidate)) {
      result.production = state;
      return result;
    }
    failUnless(["released", "completed", "paused", "halted"].includes(current.phase) &&
      current.baseline?.storeBuildId === current.candidate.storeBuildId,
    `a different ${platform} production candidate is already prepared`);
    current.candidate = null;
    current.phase = "idle";
  }
  if (current.baseline !== null) {
    failUnless(compareRelease(candidate.marketingVersion, candidate.build,
      current.baseline.marketingVersion, current.baseline.build) > 0,
    `${platform} production candidate must be newer than the independent production baseline`);
  }
  current.candidate = candidate;
  current.phase = "prepared";
  result.production = state;
  validateProductionState(result.production);
  return result;
}

/**
 * A prepared candidate may be replaced only after a caller proves that no
 * store transition was attempted for it. This keeps an abandoned/rejected
 * preparation from becoming an implicit overwrite of durable release history.
 */
export function cancelProductionCandidate(registry, {
  platform,
  candidateFingerprint,
  remoteBaselineFingerprint,
  reason,
  cancelledAt = new Date().toISOString()
}) {
  validateRegistry(registry);
  const result = structuredClone(registry);
  const state = productionState(result);
  requirePlatform(platform);
  failUnless(typeof reason === "string" && reason.trim().length > 0, "production cancellation reason is required");
  const normalizedReason = reason.trim();
  const existingCancellation = state.cancellations.find((entry) => entry.platform === platform &&
    entry.candidateFingerprint === candidateFingerprint &&
    entry.remoteBaselineFingerprint === remoteBaselineFingerprint && entry.reason === normalizedReason);
  if (existingCancellation !== undefined) {
    result.production = state;
    return result;
  }
  const entry = state.platforms[platform];
  failUnless(entry.candidate !== null, `${platform} has no prepared production candidate`);
  const candidate = entry.candidate;
  failUnless(candidateFingerprint === productionCandidateFingerprint(candidate),
    "production cancellation candidate identity does not match the prepared candidate");
  failUnless(remoteBaselineFingerprint === candidate.remoteBaselineFingerprint,
    "production cancellation requires the exact prepare-time store snapshot");
  const operations = state.operations.filter((operation) => operation.candidate.operationId === candidate.operationId);
  failUnless(operations.every((operation) => operation.status === "failed"),
    "production candidate cannot be cancelled while an operation is unresolved or succeeded");
  for (const operation of operations) {
    failUnless(operation.receipt?.observed?.noMutation === true && operation.receipt?.observed?.authoritative === true,
      "production candidate cancellation requires authoritative no-mutation receipts");
  }
  state.cancellations.push({ schemaVersion: 1, platform, candidateFingerprint,
    operationId: candidate.operationId, remoteBaselineFingerprint, reason: normalizedReason, cancelledAt });
  entry.candidate = null;
  entry.phase = "idle";
  result.production = state;
  validateProductionState(result.production);
  return result;
}

export function beginProductionOperation(registry, {
  operationId,
  platform,
  action,
  candidate,
  expectedBaselineFingerprint,
  expectedRemoteFingerprint,
  expectedActivationFingerprint = null,
  requestFingerprint,
  transition = null,
  startedAt = new Date().toISOString()
}) {
  validateRegistry(registry);
  const result = structuredClone(registry);
  const state = productionState(result);
  validateOperationIdentity({ operationId, platform, action });
  const entry = state.platforms[platform];
  failUnless(entry.candidate !== null, `${platform} has no prepared production candidate`);
  assertCandidateMatch(entry.candidate, candidate);
  const prior = state.operations.find((operation) => operation.operationId === operationId);
  if (prior !== undefined) {
    failUnless(prior.platform === platform && prior.action === action && sameJson(prior.candidate, candidate),
      "production operation identity changed during retry");
    if (prior.status === "succeeded") return result;
    if (prior.status === "failed") {
      failUnless(false, "failed production operation requires a new operation ID and a fresh remote proof");
    }
    if (expectedRemoteFingerprint !== undefined) failUnless(prior.expectedRemoteFingerprint === (expectedRemoteFingerprint ?? null),
      "production operation remote snapshot changed during retry");
    if (expectedActivationFingerprint !== undefined) failUnless(prior.expectedActivationFingerprint === (expectedActivationFingerprint ?? null),
      "production operation activation fence changed during retry");
    if (requestFingerprint !== undefined) failUnless(prior.requestFingerprint === (requestFingerprint ?? null),
      "production operation request identity changed during retry");
    if (transition !== undefined) failUnless(sameJson(prior.transition, transition ?? null),
      "production operation transition changed during retry");
    return result;
  }
  if (expectedBaselineFingerprint !== undefined) {
    failUnless(productionIdentityFingerprint(entry.baseline) === expectedBaselineFingerprint,
      "production baseline CAS failed before store mutation");
  }
  if (expectedRemoteFingerprint !== undefined) {
    failUnless(expectedRemoteFingerprint === null || SHA256.test(expectedRemoteFingerprint),
      "production remote snapshot CAS fingerprint is invalid");
  }
  if (expectedActivationFingerprint !== undefined) {
    failUnless(expectedActivationFingerprint === null || SHA256.test(expectedActivationFingerprint),
      "production activation CAS fingerprint is invalid");
    failUnless(currentActivationFenceFingerprint(registry) === expectedActivationFingerprint,
      "production activation intent changed before journaling the transition");
  }
  const active = state.operations.find((operation) => operation.platform === platform &&
    operation.status !== "succeeded" && operation.status !== "failed");
  failUnless(active === undefined, `${platform} has an unresolved production operation ${active?.operationId}`);
  state.operations.push({ schemaVersion: 1, operationId, platform, action, status: "pending",
    candidate: structuredClone(candidate), expectedBaselineFingerprint: productionIdentityFingerprint(entry.baseline),
    expectedRemoteFingerprint: expectedRemoteFingerprint ?? null,
    expectedActivationFingerprint: expectedActivationFingerprint ?? null,
    requestFingerprint: requestFingerprint ?? null,
    transition: transition === null ? null : structuredClone(transition),
    substeps: [], startedAt, updatedAt: startedAt, receipt: null });
  entry.phase = "pending";
  result.production = state;
  validateProductionState(result.production);
  return result;
}

export function markProductionUncertain(registry, operationId, {
  receipt = null,
  updatedAt = new Date().toISOString()
} = {}) {
  const state = productionState(registry);
  const operation = state.operations.find((entry) => entry.operationId === operationId);
  failUnless(operation, `unknown production operation ${operationId}`);
  if (operation.status === "uncertain") {
    const result = structuredClone(registry);
    result.production = state;
    return result;
  }
  return updateProductionOperation(registry, operationId, { status: "uncertain", receipt, updatedAt });
}

export function recordProductionSubstep(registry, operationId, substep, updatedAt = new Date().toISOString()) {
  validateRegistry(registry);
  const result = structuredClone(registry);
  const state = productionState(result);
  const operation = state.operations.find((entry) => entry.operationId === operationId);
  failUnless(operation, `unknown production operation ${operationId}`);
  failUnless(["pending", "uncertain"].includes(operation.status),
    "production substeps can only be recorded for an unresolved operation");
  const normalized = { ...substep, updatedAt: substep.updatedAt ?? updatedAt };
  validateProductionSubstep(normalized);
  const existing = operation.substeps.find((entry) => entry.stepId === normalized.stepId);
  if (existing !== undefined) {
    failUnless(existing.requestFingerprint === normalized.requestFingerprint,
      "production substep request identity changed during retry");
    if (existing.status === "observed") return result;
    if (existing.status === "acknowledged" && normalized.status === "sent") return result;
    Object.assign(existing, structuredClone(normalized), { updatedAt });
  } else {
    operation.substeps.push({ ...structuredClone(normalized), updatedAt });
  }
  operation.updatedAt = updatedAt;
  result.production = state;
  validateProductionState(result.production);
  return result;
}

export function finishProductionOperation(registry, operationId, {
  status,
  receipt,
  remote,
  updatedAt = new Date().toISOString()
}) {
  failUnless(PRODUCTION_OPERATION_STATES.includes(status) && ["succeeded", "failed"].includes(status),
    "terminal production operation status is invalid");
  failUnless(object(receipt), "terminal production receipt is required");
  const state = productionState(registry);
  const operation = state.operations.find((entry) => entry.operationId === operationId);
  failUnless(operation, `unknown production operation ${operationId}`);
  if (status === "succeeded") assertSuccessfulObservation(remote, operation);
  if (status === "failed") assertNoMutationObservation(remote, operation);
  if (operation.status === status) {
    const result = structuredClone(registry);
    result.production = state;
    return result;
  }
  const terminalReceipt = { ...receipt, observed: receipt.observed ?? sanitizeObservation(remote) };
  const result = updateProductionOperation(registry, operationId, { status, receipt: terminalReceipt, updatedAt });
  const nextState = result.production;
  const platform = nextState.platforms[operation.platform];
  if (status === "succeeded") {
    for (const substep of nextState.operations.find((entry) => entry.operationId === operationId).substeps) {
      substep.status = "observed";
    }
    applyTerminalPhase(platform, operation, remote);
  } else if (platform.phase === "pending") {
    platform.phase = "prepared";
  }
  validateProductionState(nextState);
  return result;
}

export function reconcileProductionOperation(registry, operationId, {
  observed,
  receipt,
  reconciledAt = new Date().toISOString()
}) {
  validateRegistry(registry);
  const state = productionState(registry);
  const operation = state.operations.find((entry) => entry.operationId === operationId);
  failUnless(operation, `unknown production operation ${operationId}`);
  failUnless(object(observed), "authoritative production observation is required");
  assertObservationIdentity(observed, operation);
  if (operation.status === "succeeded") {
    assertSuccessfulObservation(observed, operation);
    return registry;
  }
  if (operation.status === "failed") {
    assertNoMutationObservation(observed, operation);
    return registry;
  }
  failUnless(operation.status === "pending" || operation.status === "uncertain",
    "production operation is already terminal");
  if (observed.matched === true && observed.terminal === true && observed.mutation !== false && observed.authoritative === true) {
    return finishProductionOperation(registry, operationId, {
      status: "succeeded",
      receipt: receipt ?? { schemaVersion: 1, reconciledAt, observed: sanitizeObservation(observed) },
      remote: observed,
      updatedAt: reconciledAt
    });
  }
  const confirmedAssignmentPending = observed.assignmentConfirmed === true && observed.authoritative === true &&
    observed.mutation === false && observed.published === false && observed.available === false;
  if (observed.partial === true && observed.authoritative === true &&
      (operation.transition === null || confirmedAssignmentPending) &&
      typeof observed.currentRemoteFingerprint === "string" && SHA256.test(observed.currentRemoteFingerprint)) {
    // The store shows an identity-bound intermediate result (for example an
    // Apple version/build exists but review submission is still pending). Move
    // the operation's CAS snapshot forward and mark only the substeps proven
    // by that result as observed. The same operation can then resume its next
    // idempotent step without reusing an old remote snapshot.
    // A plain partial action can retry against the newly observed remote
    // baseline. A rollout transition keeps its original prior-policy CAS
    // identity: the confirmed assignment is durable evidence for activation
    // fencing, but the approved transition must remain bound to its original
    // snapshot until the store publishes it.
    if (operation.transition === null) operation.expectedRemoteFingerprint = observed.currentRemoteFingerprint;
    // Preserve the authoritative intermediate receipt. It is the evidence
    // that lets the activation CAS fence reopen for a confirmed submission
    // while the store continues review asynchronously.
    operation.receipt = receipt ?? { schemaVersion: 1, reconciledAt, observed: sanitizeObservation(observed) };
    for (const stepId of observed.completedSubsteps ?? []) {
      const step = operation.substeps.find((entry) => entry.stepId === stepId);
      if (step) {
        const remoteId = observed.substepRemoteIds?.[stepId];
        if (remoteId !== undefined && remoteId !== null) {
          failUnless(typeof remoteId === "string" && remoteId.length > 0,
            "production observed substep remote identity is invalid");
          failUnless(step.remoteId === undefined || step.remoteId === null || step.remoteId === remoteId,
            "production observed substep remote identity changed");
          step.remoteId = remoteId;
        }
        step.status = "observed";
      }
    }
    operation.updatedAt = reconciledAt;
    state.platforms[operation.platform].phase = "pending";
    const result = structuredClone(registry);
    result.production = state;
    validateProductionState(result.production);
    return result;
  }
  if (observed.noMutation === true && observed.authoritative === true && observed.published === false) {
    return finishProductionOperation(registry, operationId, {
      status: "failed",
      receipt: receipt ?? { schemaVersion: 1, reconciledAt, observed: sanitizeObservation(observed) },
      remote: observed,
      updatedAt: reconciledAt
    });
  }
  // A read that cannot prove either outcome keeps the operation unresolved. This
  // is the critical response-loss rule: do not retry a non-idempotent store write.
  return registry;
}

export function productionStatus(registry, platform) {
  const state = productionState(registry);
  if (platform !== undefined) requirePlatform(platform);
  return platform ? { ...structuredClone(state.platforms[platform]),
    operations: structuredClone(state.operations.filter((operation) => operation.platform === platform)) } : state;
}

/**
 * A production operation normally keeps the activation CAS fence closed until
 * its terminal receipt. A confirmed store assignment whose publication is
 * still pending is the short-lived exception: its store identity is
 * authoritative, no remote substep is unresolved, and the candidate remains
 * durable while the baseline stays unchanged. A later release still has to
 * acquire its own CAS fence.
 */
export function productionOperationBlocksActivation(operation) {
  if (!operation || !["pending", "uncertain"].includes(operation.status)) return false;
  if (operation.substeps?.some((step) => ["sent", "uncertain"].includes(step.status))) return true;
  const observed = operation.receipt?.observed;
  const confirmedAssignmentPending = ["release", "advance", "resume"].includes(operation.action) &&
    observed?.authoritative === true &&
    observed.mutation === false && observed.published === false && observed.available === false &&
    observed.assignmentConfirmed === true && ["released", "completed"].includes(observed.phase);
  const confirmedSubmission = operation.action === "submit" && observed?.authoritative === true &&
    observed.mutation !== false && observed.published === false && observed.available === false &&
    (operation.platform !== "android" || observed.reviewSubmitted === true) &&
    observed.publishedBeforeServerHealth !== true &&
    (observed.matched === true || observed.partial === true) &&
    observed.phase === "submitted";
  return !(confirmedSubmission || confirmedAssignmentPending);
}

export function productionIdentityFingerprint(identity) {
  return identity === null || identity === undefined ? null : sha256Json(identity);
}

export function productionCandidateFingerprint(candidate) {
  validateProductionCandidate(candidate);
  return sha256Json(candidate);
}

export function currentActivationFenceFingerprint(registry) {
  return registry.activationIntent === undefined ? null : sha256Json(registry.activationIntent);
}

export function sha256Json(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function validateProductionCandidate(candidate, platform = candidate?.platform) {
  requirePlatform(platform);
  failUnless(object(candidate) && candidate.schemaVersion === 1 && candidate.platform === platform,
    "production candidate identity is invalid");
  validateProductionIdentity(candidate, platform, "candidate");
  failUnless(typeof candidate.releaseId === "string" && candidate.releaseId.length > 0,
    "production candidate releaseId is invalid");
  failUnless(SHA.test(candidate.sourceSha) && candidate.acceptedSha === candidate.sourceSha,
    "production candidate accepted SHA is invalid");
  failUnless(GENERATION.test(candidate.generation), "production candidate generation is invalid");
  failUnless(object(candidate.protocol) && positiveInteger(candidate.protocol.min) && positiveInteger(candidate.protocol.max) &&
    candidate.protocol.min <= candidate.protocol.max, "production candidate protocol range is invalid");
  failUnless(object(candidate.toolingApproval) && candidate.toolingApproval.approved === true &&
    SHA.test(candidate.toolingApproval.toolSha) && candidate.toolingApproval.toolSha === candidate.toolSha &&
    typeof candidate.toolingApproval.actor === "string" && candidate.toolingApproval.actor.trim().length > 0 &&
    /^https:\/\//u.test(candidate.toolingApproval.receiptUrl) && Number.isFinite(Date.parse(candidate.toolingApproval.approvedAt)),
  "production tooling approval is invalid");
  failUnless(SHA256.test(candidate.metadataHash), "production metadata hash is invalid");
  failUnless(Array.isArray(candidate.countries) && new Set(candidate.countries).size === candidate.countries.length &&
    candidate.countries.every((country) => COUNTRY.test(country)), "production country binding is invalid");
  failUnless(object(candidate.rollout) && ["first-publish", "update"].includes(candidate.rollout.kind) &&
    ["manual", "staged", "full"].includes(candidate.rollout.mode), "production rollout binding is invalid");
  failUnless(candidate.firstLaunch === (candidate.rollout.kind === "first-publish"),
    "production first-launch rollout binding is invalid");
  if (candidate.rollout.mode === "staged") failUnless(Number.isFinite(candidate.rollout.fraction) &&
    candidate.rollout.fraction > 0 && candidate.rollout.fraction < 1, "staged production rollout fraction is invalid");
  if (candidate.firstLaunch && platform === "ios") failUnless(["manual", "full"].includes(candidate.rollout.mode),
    "Apple first publish cannot use phased rollout");
  if (candidate.firstLaunch && platform === "android") failUnless(candidate.rollout.mode === "full",
    "Google first publish must be a full release; staged first publication is not supported");
  if (platform === "android") failUnless(["staged", "full"].includes(candidate.rollout.mode),
    "Google production rollout must be staged or full");
  if (candidate.managedPublishing !== null && candidate.managedPublishing !== undefined) {
    failUnless(typeof candidate.managedPublishing === "boolean",
      "production managed-publishing binding is invalid");
  }
  if (candidate.firstPublicationBootstrapVerified !== undefined) {
    failUnless(typeof candidate.firstPublicationBootstrapVerified === "boolean",
      "production first-publication bootstrap binding is invalid");
  }
  failUnless(typeof candidate.preparedAt === "string" && Number.isFinite(Date.parse(candidate.preparedAt)),
    "production candidate preparedAt is invalid");
  failUnless(candidate.remoteBaselineFingerprint === null || SHA256.test(candidate.remoteBaselineFingerprint),
    "production remote baseline fingerprint is invalid");
  failUnless(candidate.publishedMasterSha === null || SHA.test(candidate.publishedMasterSha),
    "production published master identity is invalid");
  failUnless(candidate.activationFenceFingerprint === null || SHA256.test(candidate.activationFenceFingerprint),
    "production activation fence identity is invalid");
  if (candidate.serverCompatibility !== null) validateServerCompatibility(candidate.serverCompatibility, candidate);
  return candidate;
}

function makeCandidate({ platform, source, operationId, toolingApproval, metadataHash, countries, rollout,
  serverCompatibility, remoteBaseline, publishedMasterSha = null, activationFenceFingerprint = null,
  managedPublishing = null, firstPublicationBootstrapVerified = false, preparedAt }) {
  requirePlatform(platform);
  failUnless(typeof operationId === "string" && /^[A-Za-z0-9._:-]{3,128}$/u.test(operationId), "production operationId is invalid");
  const candidate = {
    schemaVersion: 1,
    platform,
    releaseId: source.releaseId,
    sourceSha: source.sourceSha,
    acceptedSha: source.sourceSha,
    generation: source.generation,
    marketingVersion: source.marketingVersion,
    build: source.build,
    storeBuildId: source.storeBuildId,
    artifactSha256: source.artifactSha256,
    protocol: structuredClone(source.protocol),
    toolingApproval: structuredClone(toolingApproval),
    toolSha: toolingApproval?.toolSha,
    metadataHash,
    countries: [...countries].sort(),
    rollout: structuredClone(rollout),
    serverCompatibility: serverCompatibility ? structuredClone(serverCompatibility) : null,
    remoteBaselineFingerprint: remoteBaseline ? productionIdentityFingerprint(remoteBaseline) : null,
    publishedMasterSha: publishedMasterSha ?? null,
    activationFenceFingerprint: activationFenceFingerprint ?? null,
    managedPublishing: managedPublishing ?? null,
    firstPublicationBootstrapVerified: Boolean(firstPublicationBootstrapVerified),
    firstLaunch: rollout?.kind === "first-publish",
    preparedAt,
    operationId
  };
  validateProductionCandidate(candidate, platform);
  return candidate;
}

function assertVerifiedRelease(release, platform) {
  requirePlatform(platform);
  failUnless(object(release) && release.platform === platform && release.uploadAttempted && release.uploaded &&
    release.processed && release.internal && SHA.test(release.sourceSha) && GENERATION.test(release.generation) &&
    VERSION.test(release.marketingVersion) && positiveInteger(release.build) && SHA256.test(release.artifactSha256) &&
    typeof release.storeBuildId === "string" && release.storeBuildId.length > 0,
  `${platform} release is not an exact verified internal artifact`);
  return release;
}

function validateProductionIdentity(identity, platform, label) {
  failUnless(object(identity) && identity.platform === platform && SHA.test(identity.sourceSha) &&
    GENERATION.test(identity.generation) && VERSION.test(identity.marketingVersion) && positiveInteger(identity.build) &&
    typeof identity.storeBuildId === "string" && identity.storeBuildId.length > 0 && SHA256.test(identity.artifactSha256),
  `production ${label} identity is invalid`);
  if (identity.metadataHash !== undefined) failUnless(SHA256.test(identity.metadataHash), `production ${label} metadata hash is invalid`);
  return identity;
}

function validateProductionOperation(operation) {
  failUnless(object(operation) && operation.schemaVersion === 1 && typeof operation.operationId === "string" &&
    /^[A-Za-z0-9._:-]{3,128}$/u.test(operation.operationId), "production operation identity is invalid");
  requirePlatform(operation.platform);
  failUnless(PRODUCTION_ACTIONS.includes(operation.action), "production operation action is invalid");
  failUnless(PRODUCTION_OPERATION_STATES.includes(operation.status), "production operation status is invalid");
  validateProductionCandidate(operation.candidate, operation.platform);
  failUnless(operation.expectedBaselineFingerprint === null || SHA256.test(operation.expectedBaselineFingerprint),
    "production baseline CAS fingerprint is invalid");
  failUnless(operation.expectedRemoteFingerprint === null || SHA256.test(operation.expectedRemoteFingerprint),
    "production remote CAS fingerprint is invalid");
  failUnless(operation.expectedActivationFingerprint === null || SHA256.test(operation.expectedActivationFingerprint),
    "production activation CAS fingerprint is invalid");
  failUnless(operation.requestFingerprint === null || SHA256.test(operation.requestFingerprint),
    "production request fingerprint is invalid");
  if (operation.transition !== null && operation.transition !== undefined) validateProductionTransition(operation.transition, operation);
  failUnless(Array.isArray(operation.substeps), "production operation substeps are required");
  const substepIds = new Set();
  for (const substep of operation.substeps) {
    validateProductionSubstep(substep);
    failUnless(!substepIds.has(substep.stepId), "production operation substep IDs must be unique");
    substepIds.add(substep.stepId);
  }
  failUnless(typeof operation.startedAt === "string" && Number.isFinite(Date.parse(operation.startedAt)) &&
    typeof operation.updatedAt === "string" && Number.isFinite(Date.parse(operation.updatedAt)),
  "production operation timestamps are invalid");
  if (operation.status === "succeeded" || operation.status === "failed") failUnless(object(operation.receipt),
    "terminal production operations require a receipt");
}

function validateOperationIdentity({ operationId, platform, action }) {
  failUnless(typeof operationId === "string" && /^[A-Za-z0-9._:-]{3,128}$/u.test(operationId), "production operationId is invalid");
  requirePlatform(platform);
  failUnless(PRODUCTION_ACTIONS.includes(action), "production action is invalid");
}

function validateServerCompatibility(proof, candidate) {
  failUnless(object(proof) && proof.schemaVersion === 1 && SHA.test(proof.serverSha) &&
    object(proof.serverProtocol) && positiveInteger(proof.serverProtocol.min) && positiveInteger(proof.serverProtocol.max) &&
    object(proof.hardMinimum) && object(proof.hardMinimum[candidate.platform]) &&
    VERSION.test(proof.hardMinimum[candidate.platform].version) &&
    Number.isInteger(proof.hardMinimum[candidate.platform].build) && proof.hardMinimum[candidate.platform].build >= 0,
  "production server compatibility fence is invalid");
  failUnless(candidate.protocol.max >= proof.serverProtocol.min && candidate.protocol.min <= proof.serverProtocol.max,
    "production candidate has no server protocol overlap");
}

function assertCandidateMatch(left, right) {
  validateProductionCandidate(right, left.platform);
  failUnless(sameJson(left, right), "production candidate identity changed during operation retry");
}

function updateProductionOperation(registry, operationId, patch) {
  validateRegistry(registry);
  const result = structuredClone(registry);
  const state = productionState(result);
  const operation = state.operations.find((entry) => entry.operationId === operationId);
  failUnless(operation, `unknown production operation ${operationId}`);
  if (patch.status !== undefined) {
    failUnless(operation.status === "pending" || operation.status === "uncertain" || operation.status === patch.status,
      "production operation is already terminal");
    operation.status = patch.status;
  }
  if (patch.receipt !== undefined) operation.receipt = patch.receipt === null ? null : structuredClone(patch.receipt);
  operation.updatedAt = patch.updatedAt;
  result.production = state;
  validateProductionState(result.production);
  return result;
}

function validateProductionCancellation(cancellation) {
  failUnless(object(cancellation) && cancellation.schemaVersion === 1, "production cancellation is invalid");
  requirePlatform(cancellation.platform);
  failUnless(typeof cancellation.operationId === "string" && /^[A-Za-z0-9._:-]{3,128}$/u.test(cancellation.operationId),
    "production cancellation operation identity is invalid");
  failUnless(SHA256.test(cancellation.candidateFingerprint) && SHA256.test(cancellation.remoteBaselineFingerprint),
    "production cancellation fingerprints are invalid");
  failUnless(typeof cancellation.reason === "string" && cancellation.reason.trim().length > 0 &&
    typeof cancellation.cancelledAt === "string" && Number.isFinite(Date.parse(cancellation.cancelledAt)),
    "production cancellation receipt is invalid");
}

function samePrepareIdentity(left, right) {
  const normalize = (candidate) => {
    const value = structuredClone(candidate);
    delete value.preparedAt;
    if (value.toolingApproval) delete value.toolingApproval.approvedAt;
    if (value.serverCompatibility) delete value.serverCompatibility.observedAt;
    return value;
  };
  return sameJson(normalize(left), normalize(right));
}

function assertSuccessfulObservation(observed, operation) {
  failUnless(object(observed) && observed.matched === true && observed.terminal === true &&
    observed.authoritative === true && observed.mutation !== false,
  "production success requires authoritative mutation evidence");
  if (["release", "advance", "resume"].includes(operation.action)) failUnless(observed.published === true && observed.available === true,
    "production availability evidence is required before advancing the production baseline");
  if (operation.action === "pause") failUnless(observed.phase === "paused" && observed.published === false,
    "production pause requires an authoritative paused phase");
  assertObservationIdentity(observed, operation);
  failUnless(observed.storeBuildId === operation.candidate.storeBuildId,
    "production success store identity does not match the prepared candidate");
}

function assertNoMutationObservation(observed, operation) {
  failUnless(object(observed) && observed.matched === false && observed.published === false &&
    observed.noMutation === true && observed.authoritative === true,
  "production failure requires authoritative no-mutation evidence");
  assertObservationIdentity(observed, operation);
}

function assertObservationIdentity(observed, operation) {
  failUnless(observed?.candidateFingerprint === productionCandidateFingerprint(operation.candidate),
    "production observation candidate identity does not match the journaled candidate");
  failUnless(observed?.expectedRemoteFingerprint === operation.expectedRemoteFingerprint,
    "production observation remote snapshot does not match the journaled transition");
  if (operation.transition !== null && operation.transition !== undefined) failUnless(
    observed?.transitionFingerprint === operation.transition.fingerprint,
    "production observation transition identity does not match the journaled transition");
}

function validateProductionTransition(transition, operation) {
  failUnless(object(transition) && transition.schemaVersion === 1 &&
    transition.operationId === operation.operationId && transition.action === operation.action,
    "production transition identity is invalid");
  failUnless(SHA256.test(transition.artifactFingerprint) && SHA256.test(transition.expectedRemoteFingerprint) &&
    SHA256.test(transition.expectedPriorPolicyFingerprint) && SHA256.test(transition.approvalFingerprint) &&
    SHA256.test(transition.fingerprint), "production transition fingerprints are invalid");
  const artifact = structuredClone(operation.candidate);
  delete artifact.rollout;
  failUnless(transition.artifactFingerprint === sha256Json(artifact),
    "production transition artifact identity does not match the journaled candidate");
  failUnless(transition.expectedRemoteFingerprint === operation.expectedRemoteFingerprint,
    "production transition remote snapshot does not match the journaled operation");
  failUnless(transition.expectedPriorPolicyFingerprint === transition.expectedRemoteFingerprint,
    "production transition prior policy snapshot does not match the journaled remote state");
  failUnless(object(transition.toRollout), "production transition rollout is required");
  validateProductionCandidate({ ...structuredClone(operation.candidate), rollout: structuredClone(transition.toRollout) }, operation.platform);
  const approvalPayload = structuredClone(transition);
  delete approvalPayload.approvalFingerprint;
  delete approvalPayload.fingerprint;
  failUnless(transition.approvalFingerprint === sha256Json(approvalPayload),
    "production transition approval fingerprint is not self-consistent");
  const transitionPayload = structuredClone(transition);
  delete transitionPayload.fingerprint;
  failUnless(transition.fingerprint === sha256Json(transitionPayload),
    "production transition fingerprint is not self-consistent");
}

function validateProductionSubstep(substep) {
  failUnless(object(substep) && typeof substep.stepId === "string" && /^[A-Za-z0-9._:-]{3,128}$/u.test(substep.stepId) &&
    ["sent", "acknowledged", "uncertain", "observed"].includes(substep.status) &&
    SHA256.test(substep.requestFingerprint) && typeof substep.updatedAt === "string" && Number.isFinite(Date.parse(substep.updatedAt)),
  "production substep identity is invalid");
  if (substep.remoteId !== undefined && substep.remoteId !== null) failUnless(typeof substep.remoteId === "string" && substep.remoteId.length > 0,
    "production substep remote identity is invalid");
}

function applyTerminalPhase(platform, operation, remote) {
  if (operation.action === "release") {
    const identity = identityFromCandidate(operation.candidate);
    if (!platform.history.some((entry) => entry.storeBuildId === identity.storeBuildId)) platform.history.push(identity);
    platform.baseline = identity;
    platform.candidate = structuredClone(operation.candidate);
    platform.phase = remote?.phase ?? (operation.candidate.rollout.mode === "staged" ? "released" : "completed");
  } else if (operation.action === "submit") {
    platform.phase = "submitted";
  } else if (operation.action === "advance") {
    platform.phase = remote?.phase ?? "released";
  } else if (operation.action === "pause") {
    platform.phase = "paused";
  } else if (operation.action === "resume") {
    platform.phase = "released";
  } else if (operation.action === "prepare") {
    platform.phase = "prepared";
  }
}

function identityFromCandidate(candidate) {
  return {
    platform: candidate.platform,
    sourceSha: candidate.sourceSha,
    generation: candidate.generation,
    marketingVersion: candidate.marketingVersion,
    build: candidate.build,
    storeBuildId: candidate.storeBuildId,
    artifactSha256: candidate.artifactSha256,
    metadataHash: candidate.metadataHash
  };
}

function sanitizeObservation(observed) {
  return structuredClone(observed);
}

function requirePlatform(platform) {
  failUnless(PLATFORMS.has(platform), "production platform is invalid");
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function compareRelease(leftVersion, leftBuild, rightVersion, rightBuild) {
  const left = leftVersion.split(/[.-]/u).slice(0, 3).map(Number);
  const right = rightVersion.split(/[.-]/u).slice(0, 3).map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return leftBuild - rightBuild;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0 && value <= 2_147_483_647;
}

function failUnless(condition, message) {
  if (!condition) throw new Error(message);
}
