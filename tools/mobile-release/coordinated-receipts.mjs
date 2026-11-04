import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { validateRegistry } from "./registry.mjs";
import { readTesterDestination, normalizeTesterDestination, validateTesterObservation } from "./coordinated-mobile-testers.mjs";

export const COORDINATED_RELEASE_PHASES = [
  "manifest_created",
  "apps_submitted",
  "apps_ready",
  "server_published",
  "server_activated",
  "server_healthy",
  "apps_release_requested",
  "completed"
];

const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const GENERATION = /^t\d{3,4}$/u;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const COUNTRY = /^[A-Z]{2}$/u;
const PLATFORMS = new Set(["ios", "android"]);
const COORDINATED_SERVER_EVIDENCE_KIND = "ash-atlas-coordinated-server-evidence";
const COORDINATED_SERVER_EVIDENCE_HMAC_ALGORITHM = "HMAC-SHA256";
const APPLE_PUBLISHED_STATES = new Set(["READY_FOR_SALE", "READY_FOR_DISTRIBUTION"]);
const APPLE_SUBMITTED_STATES = new Set([
  "READY_FOR_REVIEW", "WAITING_FOR_REVIEW", "IN_REVIEW", "APPROVED", "COMPLETE",
  "PENDING_DEVELOPER_RELEASE", "READY_FOR_SALE", "READY_FOR_DISTRIBUTION"
]);
const GOOGLE_SUBMITTED_STATES = new Set([
  "RELEASE_LIFECYCLE_STATE_IN_REVIEW",
  "RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED",
  "RELEASE_LIFECYCLE_STATE_PUBLISHED"
]);

export function coordinatedChildOperationId(coordinatedOperationId, platform) {
  requireState(OPERATION_ID.test(String(coordinatedOperationId)),
    "coordinated operation ID is invalid");
  requireState(PLATFORMS.has(platform), "coordinated platform is invalid");
  const childId = `${coordinatedOperationId}:${platform}`;
  requireState(OPERATION_ID.test(childId), "coordinated child operation ID is invalid");
  return childId;
}

/**
 * Server progression is written to the protected mobile-release-state branch
 * by the server coordinator.  The mobile workflow never accepts phase or
 * health booleans from workflow_dispatch; it consumes this append-only proof.
 * Keep the identity fields in the proof so a stale proof for another release
 * cannot unlock the store actions for this operation.
 */
export function validateCoordinatedServerEvidence(evidence) {
  requireState(evidence && evidence.schemaVersion === 1 &&
    evidence.kind === COORDINATED_SERVER_EVIDENCE_KIND,
  "coordinated server evidence schema is invalid");
  requireState(OPERATION_ID.test(String(evidence.coordinated_operation_id)),
    "coordinated server evidence operation ID is invalid");
  requireState(COORDINATED_RELEASE_PHASES.includes(evidence.phase),
    "coordinated server evidence phase is invalid");
  for (const [field, pattern] of [["source_sha", SHA], ["server_sha", SHA],
    ["accepted_master_sha", SHA]]) {
    requireState(typeof evidence[field] === "string" && pattern.test(evidence[field]),
      `coordinated server evidence ${field} is invalid`);
  }
  requireState(GENERATION.test(String(evidence.generation)),
    "coordinated server evidence generation is invalid");
  requireState(evidence.server_sha === evidence.source_sha,
    "coordinated server evidence server SHA must equal the candidate source SHA");
  requireState(evidence.authenticated === true && evidence.authoritative === true,
    "coordinated server evidence is not authenticated and authoritative");
  requireState(evidence.hmac_algorithm === COORDINATED_SERVER_EVIDENCE_HMAC_ALGORITHM &&
    typeof evidence.hmac_key_id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(evidence.hmac_key_id) &&
    SHA256.test(evidence.hmac_sha256) && /^[0-9a-f]{32}$/u.test(String(evidence.nonce)),
  "coordinated server evidence authentication envelope is invalid");
  for (const field of ["published", "activated", "healthy"]) {
    requireState(typeof evidence[field] === "boolean",
      `coordinated server evidence ${field} flag is invalid`);
  }
  const phase = COORDINATED_RELEASE_PHASES.indexOf(evidence.phase);
  requireState(!evidence.published || phase >= COORDINATED_RELEASE_PHASES.indexOf("server_published"),
    "coordinated server evidence published flag is ahead of its phase");
  requireState(!evidence.activated || phase >= COORDINATED_RELEASE_PHASES.indexOf("server_activated"),
    "coordinated server evidence activated flag is ahead of its phase");
  requireState(!evidence.healthy || phase >= COORDINATED_RELEASE_PHASES.indexOf("server_healthy"),
    "coordinated server evidence healthy flag is ahead of its phase");
  requireState(!evidence.activated || evidence.published,
    "coordinated server activation evidence requires publication evidence");
  requireState(!evidence.healthy || evidence.activated,
    "coordinated server health evidence requires activation evidence");
  requireState(SHA256.test(evidence.receipt_sha256) &&
    evidence.receipt_sha256 === coordinatedServerEvidenceFingerprint(evidence),
    "coordinated server evidence fingerprint is invalid");
  requireState(typeof evidence.observed_at_utc === "string" &&
    Number.isFinite(Date.parse(evidence.observed_at_utc)),
    "coordinated server evidence timestamp is invalid");

  const candidates = evidence.candidates ?? evidence.apps;
  requireState(candidates && typeof candidates === "object",
    "coordinated server evidence must carry exact mobile candidate identities");
  for (const platform of PLATFORMS) {
    const entry = candidates[platform];
    requireState(entry && typeof entry === "object",
      `coordinated server evidence is missing ${platform} candidate identity`);
    const candidate = entry.candidate ?? entry;
    const identity = coordinatedCandidateIdentity(candidate);
    requireState(identity.platform === platform,
      `coordinated server evidence ${platform} candidate platform is invalid`);
    const childId = entry.child_operation_id ?? entry.childOperationId ?? candidate.operation_id ?? candidate.operationId;
    requireState(childId === coordinatedChildOperationId(evidence.coordinated_operation_id, platform),
      `coordinated server evidence ${platform} child operation identity is invalid`);
  }
  return evidence;
}

export function recordCoordinatedServerEvidence(registry, evidence) {
  validateRegistry(registry);
  validateCoordinatedServerEvidence(evidence);
  const result = structuredClone(registry);
  const entries = Array.isArray(result.coordinatedServerEvidence)
    ? result.coordinatedServerEvidence : [];
  const matching = entries.filter((entry) =>
    entry.coordinated_operation_id === evidence.coordinated_operation_id);
  for (const prior of matching) {
    for (const field of ["source_sha", "server_sha", "accepted_master_sha", "generation"]) {
      requireState(prior[field] === evidence[field],
        `coordinated server evidence ${field} changed during reconciliation`);
    }
    requireState(!prior.published || evidence.published,
      "coordinated server evidence publication regressed");
    requireState(!prior.activated || evidence.activated,
      "coordinated server evidence activation regressed");
    requireState(!prior.healthy || evidence.healthy,
      "coordinated server evidence health regressed");
    requireState(prior.nonce === evidence.nonce && prior.hmac_key_id === evidence.hmac_key_id,
      "coordinated server evidence authentication identity changed during reconciliation");
    requireState(sameJson(serverCandidateBindings(prior), serverCandidateBindings(evidence)),
      "coordinated server evidence candidate identity changed during reconciliation");
  }
  if (entries.some((entry) => entry.receipt_sha256 === evidence.receipt_sha256)) return result;
  result.coordinatedServerEvidence = [...entries, structuredClone(evidence)];
  return result;
}

export function buildCoordinatedServerEvidence(evidence) {
  const result = structuredClone(evidence);
  requireState(result.authenticated === true && result.authoritative === true,
    "coordinated server evidence must be authenticated before recording");
  result.receipt_sha256 = coordinatedServerEvidenceFingerprint(result);
  return validateCoordinatedServerEvidence(result);
}

export function signCoordinatedServerEvidence(evidence, key, keyId = "coordinated-server-evidence-v1") {
  const result = structuredClone(evidence);
  result.authenticated = true;
  result.authoritative = true;
  result.hmac_algorithm = COORDINATED_SERVER_EVIDENCE_HMAC_ALGORITHM;
  result.hmac_key_id = keyId;
  result.hmac_sha256 = coordinatedServerEvidenceHmac(result, key);
  result.receipt_sha256 = coordinatedServerEvidenceFingerprint(result);
  return validateCoordinatedServerEvidence(result);
}

export function verifyAuthenticatedCoordinatedServerEvidence(evidence, key, expectedKeyId = "coordinated-server-evidence-v1") {
  validateCoordinatedServerEvidence(evidence);
  requireState(evidence.hmac_key_id === expectedKeyId,
    "coordinated server evidence HMAC key ID is not trusted");
  const expected = Buffer.from(coordinatedServerEvidenceHmac(evidence, key), "hex");
  const actual = Buffer.from(evidence.hmac_sha256, "hex");
  requireState(actual.length === expected.length && timingSafeEqual(actual, expected),
    "coordinated server evidence HMAC is invalid");
  requireState(evidence.receipt_sha256 === coordinatedServerEvidenceFingerprint(evidence),
    "coordinated server evidence receipt fingerprint is invalid");
  return evidence;
}

export function coordinatedServerEvidenceHmac(evidence, key) {
  return createHmac("sha256", normalizeEvidenceKey(key))
    .update(canonicalJson(serverEvidenceHmacPayload(evidence)), "utf8").digest("hex");
}

export function coordinatedServerEvidenceFor(registry, coordinatedOperationId) {
  validateRegistry(registry);
  requireState(OPERATION_ID.test(String(coordinatedOperationId)),
    "coordinated server evidence lookup identity is invalid");
  const entries = (registry.coordinatedServerEvidence ?? [])
    .filter((entry) => entry.coordinated_operation_id === coordinatedOperationId)
    .sort((left, right) => Date.parse(right.observed_at_utc) - Date.parse(left.observed_at_utc));
  if (entries.length === 0) return null;
  return validateCoordinatedServerEvidence(entries[0]);
}

export function coordinatedServerEvidenceFingerprint(evidence) {
  const copy = structuredClone(evidence);
  delete copy.receipt_sha256;
  return createHash("sha256").update(canonicalJson(copy)).digest("hex");
}

function serverEvidenceHmacPayload(evidence) {
  const copy = structuredClone(evidence);
  delete copy.hmac_sha256;
  delete copy.receipt_sha256;
  return copy;
}

function normalizeEvidenceKey(key) {
  if (Buffer.isBuffer(key)) {
    requireState(key.length >= 32, "coordinated server evidence HMAC key is shorter than 256 bits");
    return key;
  }
  if (key instanceof Uint8Array) {
    requireState(key.length >= 32, "coordinated server evidence HMAC key is shorter than 256 bits");
    return Buffer.from(key);
  }
  requireState(typeof key === "string" && key.length > 0,
    "coordinated server evidence HMAC key is required");
  requireState(/^[A-Za-z0-9+/]+={0,2}$/u.test(key) && key.length % 4 === 0,
    "coordinated server evidence HMAC key must be base64 encoded");
  const decoded = Buffer.from(key, "base64");
  requireState(decoded.length >= 32, "coordinated server evidence HMAC key is shorter than 256 bits");
  return decoded;
}

function serverCandidateBindings(evidence) {
  const candidates = evidence.candidates ?? evidence.apps;
  return Object.fromEntries([...PLATFORMS].map((platform) => {
    const entry = candidates?.[platform];
    const candidate = entry?.candidate ?? entry;
    return [platform, {
      identity: coordinatedCandidateIdentity(candidate),
      child_operation_id: entry?.child_operation_id ?? entry?.childOperationId ??
        candidate?.operation_id ?? candidate?.operationId ?? null,
      managed_publishing: entry?.managed_publishing ?? entry?.managedPublishing ??
        candidate?.managed_publishing ?? candidate?.managedPublishing ?? null,
      first_publication_bootstrap_verified: entry?.first_publication_bootstrap_verified ??
        entry?.firstPublicationBootstrapVerified ?? candidate?.first_publication_bootstrap_verified ??
        candidate?.firstPublicationBootstrapVerified ?? false
    }];
  }));
}

export function coordinatedCandidateIdentity(candidate) {
  requireState(candidate && PLATFORMS.has(candidate.platform), "coordinated candidate platform is invalid");
  const toolSha = candidate.toolSha ?? candidate.toolingApproval?.toolSha ?? candidate.tooling_sha;
  const metadataHash = candidate.metadataHash ?? candidate.metadata_sha256;
  requireState(typeof toolSha === "string" && SHA.test(toolSha), "coordinated candidate tooling SHA is invalid");
  requireState(typeof metadataHash === "string" && SHA256.test(metadataHash),
    "coordinated candidate metadata SHA is invalid");
  const countries = [...(candidate.countries ?? [])].map(String).sort();
  requireState(countries.every((country) => COUNTRY.test(country)) &&
    new Set(countries).size === countries.length, "coordinated candidate countries are invalid");
  const identity = {
    platform: candidate.platform,
    release_id: String(candidate.releaseId ?? candidate.release_id ?? ""),
    source_sha: String(candidate.sourceSha ?? candidate.source_sha ?? ""),
    generation: String(candidate.generation ?? ""),
    marketing_version: String(candidate.marketingVersion ?? candidate.marketing_version ?? ""),
    build: candidate.build,
    store_build_id: String(candidate.storeBuildId ?? candidate.store_build_id ?? ""),
    artifact_sha256: String(candidate.artifactSha256 ?? candidate.artifact_sha256 ?? ""),
    tooling_sha: toolSha,
    metadata_sha256: metadataHash,
    countries,
    rollout: structuredClone(candidate.rollout)
  };
  const testerDestination = readTesterDestination(candidate.platform, candidate, ["tester_destination", "testerDestination"]);
  if (testerDestination) identity.tester_destination = testerDestination;
  requireState(OPERATION_ID.test(identity.release_id), "coordinated candidate release ID is invalid");
  requireState(SHA.test(identity.source_sha), "coordinated candidate source SHA is invalid");
  requireState(GENERATION.test(identity.generation), "coordinated candidate generation is invalid");
  requireState(VERSION.test(identity.marketing_version), "coordinated candidate marketing version is invalid");
  requireState(Number.isInteger(Number(identity.build)) && Number(identity.build) > 0,
    "coordinated candidate build is invalid");
  requireState(identity.store_build_id.length > 0, "coordinated candidate store build ID is invalid");
  requireState(SHA256.test(identity.artifact_sha256), "coordinated candidate artifact SHA is invalid");
  requireState(identity.rollout && typeof identity.rollout === "object" &&
    ["first-publish", "update"].includes(identity.rollout.kind) &&
    ["manual", "staged", "full"].includes(identity.rollout.mode),
  "coordinated candidate rollout is invalid");
  if (identity.rollout.mode === "staged") {
    requireState(Number.isFinite(identity.rollout.fraction) && identity.rollout.fraction > 0 &&
      identity.rollout.fraction < 1, "coordinated candidate rollout fraction is invalid");
  }
  return identity;
}

/**
 * This packet intentionally mirrors Get-CoordinatedReleaseExpectedApprovalFingerprint
 * in tools/release/coordinated-release.ps1. Keep the insertion order stable: the
 * PowerShell coordinator hashes ConvertTo-Json -Compress for this ordered packet.
 */
export function coordinatedApprovalFingerprint(candidateOrIdentity) {
  const identity = candidateOrIdentity.platform && candidateOrIdentity.release_id
    ? candidateOrIdentity
    : coordinatedCandidateIdentity(candidateOrIdentity);
  const packet = {
    platform: identity.platform,
    release_id: identity.release_id,
    source_sha: identity.source_sha,
    generation: identity.generation,
    marketing_version: identity.marketing_version,
    build: identity.build,
    store_build_id: identity.store_build_id,
    artifact_sha256: identity.artifact_sha256,
    tooling_sha: identity.tooling_sha,
    metadata_sha256: identity.metadata_sha256,
    countries: identity.countries,
    rollout: identity.rollout
  };
  return createHash("sha256").update(JSON.stringify(packet)).digest("hex");
}

export function buildCoordinatedChildReceipt({
  coordinatedOperationId,
  candidate,
  production,
  snapshot,
  operation = null,
  observedAt = new Date().toISOString()
}) {
  const identity = coordinatedCandidateIdentity(candidate);
  const platform = identity.platform;
  const childOperationId = coordinatedChildOperationId(coordinatedOperationId, platform);
  const matchingOperations = (production?.operations ?? [])
    .filter((entry) => entry.candidate?.operationId === candidate.operationId)
    .sort((left, right) => Date.parse(right.updatedAt ?? 0) - Date.parse(left.updatedAt ?? 0));
  const storeOperation = operation ?? matchingOperations[0] ?? null;
  const remote = findCandidateRemote(platform, candidate, snapshot);
  const status = remote.storeStatus;
  const submitted = remote.submitted || operationReceiptHas(storeOperation, "submit");
  const publicAvailable = remote.publicAvailable;
  const testerAvailable = remote.testerAvailable === true;
  const testerPrepared = remote.testerPrepared === true || testerAvailable;
  const dailyTesters = identity.tester_destination !== undefined;
  const releaseRequested = publicAvailable || remote.releaseRequested ||
    operationReceiptHas(storeOperation, "release") || operationReceiptHas(storeOperation, "advance") ||
    operationReceiptHas(storeOperation, "resume");
  const effectiveReleaseRequested = dailyTesters ? testerAvailable : releaseRequested;
  const managedPublishing = platform === "android" &&
    (candidate.managedPublishing === true || snapshot?.managedPublishing === true);
  const firstPublicationBootstrapVerified = platform === "android" && candidate.firstLaunch === true &&
    candidate.firstPublicationBootstrapVerified === true;
  const receipt = {
    schemaVersion: 1,
    kind: "ash-atlas-mobile-child-receipt",
    coordinated_operation_id: String(coordinatedOperationId),
    operation_id: childOperationId,
    store_operation_id: storeOperation?.operationId ?? null,
    platform,
    candidate: identity,
    submitted: dailyTesters ? (submitted || testerPrepared) : submitted,
    store_status: status,
    managed_publishing: managedPublishing,
    first_publish: identity.rollout.kind === "first-publish",
    first_publication_bootstrap_verified: firstPublicationBootstrapVerified,
    approval: {
      approved: true,
      fingerprint: coordinatedApprovalFingerprint(identity),
      metadata_sha256: identity.metadata_sha256,
      countries: identity.countries,
      rollout: identity.rollout,
      ...(identity.tester_destination ? { tester_destination: identity.tester_destination } : {})
    },
    release_requested: effectiveReleaseRequested,
    public_available: publicAvailable,
    public_status: remote.publicStatus,
    ...(dailyTesters ? {
      tester_destination: identity.tester_destination,
      tester_available: testerAvailable,
      tester_prepared: testerPrepared,
      tester_status: remote.testerStatus ?? status
    } : {}),
    operation_status: storeOperation?.status ?? "not_started",
    operation_observed: storeOperation?.receipt?.observed ?? null,
    remote_baseline_fingerprint: candidate.remoteBaselineFingerprint ?? null,
    observed_at_utc: observedAt
  };
  receipt.receipt_sha256 = receiptFingerprint(receipt);
  validateCoordinatedChildReceipt(receipt);
  return receipt;
}

export function validateCoordinatedChildReceipt(receipt) {
  requireState(receipt && receipt.schemaVersion === 1 &&
    receipt.kind === "ash-atlas-mobile-child-receipt", "coordinated child receipt schema is invalid");
  requireState(OPERATION_ID.test(String(receipt.coordinated_operation_id)),
    "coordinated child receipt operation ID is invalid");
  requireState(PLATFORMS.has(receipt.platform), "coordinated child receipt platform is invalid");
  requireState(receipt.operation_id === coordinatedChildOperationId(receipt.coordinated_operation_id, receipt.platform),
    "coordinated child receipt child operation ID is invalid");
  const identity = coordinatedCandidateIdentity(receipt.candidate);
  requireState(receipt.approval?.approved === true &&
    receipt.approval.fingerprint === coordinatedApprovalFingerprint(identity),
  "coordinated child receipt approval is not bound to the exact candidate");
  requireState(receipt.approval.metadata_sha256 === identity.metadata_sha256 &&
    sameJson(receipt.approval.countries, identity.countries) &&
    sameJson(receipt.approval.rollout, identity.rollout),
  "coordinated child receipt approval policy changed");
  if (identity.tester_destination) requireState(
    sameJson(receipt.approval.tester_destination, identity.tester_destination),
    "coordinated child receipt tester destination changed");
  requireState(typeof receipt.submitted === "boolean" && typeof receipt.store_status === "string" &&
    receipt.store_status.length > 0 && typeof receipt.managed_publishing === "boolean" &&
    typeof receipt.first_publish === "boolean" &&
    typeof receipt.first_publication_bootstrap_verified === "boolean" &&
    typeof receipt.release_requested === "boolean" && typeof receipt.public_available === "boolean" &&
    typeof receipt.public_status === "string" && receipt.public_status.length > 0,
    "coordinated child receipt lifecycle evidence is incomplete");
  if (identity.tester_destination !== undefined) {
    requireState(receipt.tester_destination &&
      sameJson(receipt.tester_destination, identity.tester_destination) &&
      typeof receipt.tester_available === "boolean" &&
      (receipt.tester_prepared === undefined || typeof receipt.tester_prepared === "boolean") &&
      typeof receipt.tester_status === "string" && receipt.tester_status.length > 0,
    "daily tester receipt destination evidence is incomplete");
    if (receipt.tester_available) requireState(receipt.submitted && receipt.release_requested,
      "daily tester availability must be submitted and release-requested");
  }
  if (receipt.platform === "android" && receipt.store_status === "RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED") {
    requireState(receipt.managed_publishing === true, "Google readiness requires managed publishing");
  }
  if (receipt.first_publish && receipt.platform === "android") {
    requireState(receipt.first_publication_bootstrap_verified === true,
      "Google first publication requires an explicit bootstrap receipt");
  }
  requireState(!receipt.public_available || receipt.release_requested,
    "public availability requires a recorded release request");
  requireState(SHA256.test(receipt.receipt_sha256) && receipt.receipt_sha256 === receiptFingerprint(receipt),
    "coordinated child receipt fingerprint is invalid");
  requireState(typeof receipt.observed_at_utc === "string" && Number.isFinite(Date.parse(receipt.observed_at_utc)),
    "coordinated child receipt timestamp is invalid");
  return receipt;
}

export function recordCoordinatedMobileReceipt(registry, receipt) {
  validateRegistry(registry);
  validateCoordinatedChildReceipt(receipt);
  const result = structuredClone(registry);
  const receipts = Array.isArray(result.coordinatedMobileReceipts)
    ? result.coordinatedMobileReceipts : [];
  const existing = receipts.find((entry) => entry.coordinated_operation_id === receipt.coordinated_operation_id &&
    entry.platform === receipt.platform);
  const sameReceipt = receipts.find((entry) => entry.coordinated_operation_id === receipt.coordinated_operation_id &&
    entry.platform === receipt.platform && entry.receipt_sha256 === receipt.receipt_sha256);
  if (sameReceipt) {
    return result;
  }
  if (existing) {
    requireState(sameJson(existing.candidate, receipt.candidate) &&
      sameJson(existing.approval, receipt.approval),
    "coordinated child receipt candidate identity changed during retry");
    requireState(Date.parse(receipt.observed_at_utc) >= Date.parse(existing.observed_at_utc),
      "coordinated child receipt moved backwards in time");
  }
  result.coordinatedMobileReceipts = [...receipts, structuredClone(receipt)];
  return result;
}

export function coordinatedReceiptFor(registry, coordinatedOperationId, platform) {
  validateRegistry(registry);
  requireState(OPERATION_ID.test(String(coordinatedOperationId)) && PLATFORMS.has(platform),
    "coordinated receipt lookup identity is invalid");
  return (registry.coordinatedMobileReceipts ?? [])
    .filter((entry) => entry.coordinated_operation_id === coordinatedOperationId && entry.platform === platform)
    .sort((left, right) => Date.parse(right.observed_at_utc) - Date.parse(left.observed_at_utc))[0] ?? null;
}

function findCandidateRemote(platform, candidate, snapshot) {
  const tester = snapshot?.tester ?? snapshot?.tester_observation;
  if (candidate.tester_destination !== undefined && tester !== undefined) {
    const target = normalizeTesterDestination(platform, candidate.tester_destination);
    const available = tester.available === true;
    if (available) validateTesterObservation({ platform, candidate, destination: target, observation: tester });
    return {
      storeStatus: tester.status ?? (available ? "TESTER_AVAILABLE" : "TESTER_PENDING"),
      submitted: available || tester.prepared === true,
      releaseRequested: available,
      publicAvailable: false,
      publicStatus: tester.status ?? "TESTER_PENDING",
      testerAvailable: available,
      testerPrepared: tester.prepared === true || available,
      testerStatus: tester.status ?? "TESTER_PENDING"
    };
  }
  const internal = snapshot?.internal_verified;
  if (internal && internal.platform === platform &&
      String(internal.marketing_version ?? internal.marketingVersion) === String(candidate.marketing_version ?? candidate.marketingVersion) &&
      Number(internal.build) === Number(candidate.build) &&
      String(internal.store_build_id ?? internal.storeBuildId) === String(candidate.store_build_id ?? candidate.storeBuildId) &&
      String(internal.artifact_sha256 ?? internal.artifactSha256) === String(candidate.artifact_sha256 ?? candidate.artifactSha256)) {
    // Internal verification is deliberately represented separately from the
    // production store snapshot. It proves the signed artifact is available
    // for the next production step without pretending that a production
    // version or track assignment already exists.
    return {
      storeStatus: "INTERNAL_VERIFIED",
      submitted: false,
      releaseRequested: false,
      publicAvailable: false,
      publicStatus: "INTERNAL_VERIFIED",
      testerPrepared: false
    };
  }
  if (platform === "ios") {
    const versions = (snapshot?.versions ?? []).filter((entry) =>
      entry.versionString === candidate.marketingVersion &&
      (!entry.buildId || entry.buildId === candidate.storeBuildId));
    requireState(versions.length === 1, "Apple coordinated receipt requires one exact candidate version");
    const version = versions[0];
    const published = APPLE_PUBLISHED_STATES.has(version.state);
    const review = version.reviewSubmissionState ?? "";
    return {
      storeStatus: version.state ?? review ?? "NOT_SUBMITTED",
      submitted: APPLE_SUBMITTED_STATES.has(version.state) || APPLE_SUBMITTED_STATES.has(review),
      releaseRequested: published || version.state === "READY_FOR_SALE" || version.state === "READY_FOR_DISTRIBUTION",
      publicAvailable: published,
      publicStatus: version.state ?? "UNKNOWN"
    };
  }
  const releases = (snapshot?.productionTrack?.releases ?? []).filter((entry) =>
    entry.name === `${candidate.generation} (${candidate.build})` &&
    (entry.versionCodes ?? []).map(String).includes(String(candidate.build)));
  requireState(releases.length <= 1, "Google coordinated receipt has ambiguous candidate track releases");
  const release = releases[0] ?? null;
  const lifecycle = (snapshot?.productionLifecycle ?? []).filter((entry) =>
    entry.name === `${candidate.generation} (${candidate.build})` &&
    (entry.versionCodes ?? []).map(String).includes(String(candidate.build)));
  requireState(lifecycle.length <= 1, "Google coordinated receipt has ambiguous candidate lifecycle releases");
  const lifecycleState = lifecycle[0]?.lifecycleState ?? "";
  const published = lifecycleState === "RELEASE_LIFECYCLE_STATE_PUBLISHED" &&
    ["inProgress", "completed"].includes(release?.status);
  return {
    storeStatus: lifecycleState || release?.status || "NOT_SUBMITTED",
    submitted: GOOGLE_SUBMITTED_STATES.has(lifecycleState) ||
      ["inProgress", "halted", "completed"].includes(release?.status),
    // An approved assignment may already be visible in the track while
    // managed publishing still holds it. Only a journaled release action or
    // authoritative public availability counts as the post-health request.
    releaseRequested: published,
    publicAvailable: published,
    publicStatus: lifecycleState || release?.status || "UNKNOWN"
  };
}

function operationReceiptHas(operation, action) {
  if (!operation || operation.action !== action) return false;
  if (operation.status === "succeeded") return true;
  const observed = operation.receipt?.observed;
  return observed?.authoritative === true &&
    (observed.matched === true || observed.assignmentConfirmed === true || observed.partial === true);
}

function receiptFingerprint(receipt) {
  const copy = structuredClone(receipt);
  delete copy.receipt_sha256;
  return createHash("sha256").update(canonicalJson(copy)).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function requireState(condition, message) {
  if (!condition) throw new Error(message);
}
