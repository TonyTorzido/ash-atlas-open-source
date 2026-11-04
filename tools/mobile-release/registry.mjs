import { createHash } from "node:crypto";

const PLATFORMS = new Set(["ios", "android"]);
const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const GENERATION = /^t\d{3,4}$/u;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
export const BETA_STATES = ["reserved", "built", "uploaded", "internal_verified", "google_open_submitted",
  "google_open_verified", "ios_beta_review_submitted", "ios_beta_review_pending", "ios_external_verified", "open_beta_complete"];
const EXTERNAL_STATES = ["google_open_submitted", "google_open_verified", "ios_beta_review_submitted",
  "ios_beta_review_pending", "ios_external_verified", "open_beta_complete"];
export const INTERNAL_SMOKE_CHECKS = ["store-install-update", "cold-start", "sign-in", "world-load",
  "movement-inventory", "background-resume", "network-reconnect"];

export const RETIREMENT_NOTE = "retired; replaced by web install; build 8 is beta/internal";
const RETIREABLE_BUILDS = { ios: [1, 2, 3, 5, 6, 7], android: [1, 2, 3, 4, 6, 7] };
const RETIREMENT_IDENTITY = ["reservationId", "releaseId", "platform", "marketingVersion", "build",
  "generation", "sourceSha", "artifactSha256", "storeBuildId"];

// Retirement changes compatibility policy only; allocation and store history stay intact.
export function retirementState(registry) {
  const audit = registry.retirementAudit === undefined ? [] : registry.retirementAudit;
  failUnless(Array.isArray(audit), "retirement audit must be an array");
  const retired = new Set();
  const ids = new Set();
  let previousTime = -Infinity;
  for (const entry of audit) {
    failUnless(object(entry) && entry.schemaVersion === 1 &&
      typeof entry.actionId === "string" && /^[A-Za-z0-9._:-]{3,128}$/u.test(entry.actionId) &&
      !ids.has(entry.actionId) && ["retire", "unretire"].includes(entry.action) &&
      typeof entry.actor === "string" && entry.actor.trim().length > 0 &&
      typeof entry.recordedAt === "string" && Number.isFinite(Date.parse(entry.recordedAt)) &&
      Date.parse(entry.recordedAt) >= previousTime && typeof entry.note === "string" &&
      entry.note.trim().length > 0 && (entry.action !== "retire" || entry.note === RETIREMENT_NOTE) &&
      object(entry.identity), "retirement audit evidence is invalid");
    const release = registry.releases.find((r) => r.reservationId === entry.identity.reservationId);
    failUnless(release && RETIREABLE_BUILDS[release.platform]?.includes(release.build) &&
      release.uploadAttempted === true &&
      registry.releases.filter((r) => r.reservationId === release.reservationId).length === 1 &&
      registry.releases.filter((r) => r.platform === release.platform && r.build === release.build).length === 1 &&
      typeof release.reservationId === "string" && release.reservationId.length > 0 &&
      typeof release.releaseId === "string" && release.releaseId.length > 0 &&
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(release.marketingVersion) &&
      /^t\d{3,4}$/u.test(release.generation) && /^[0-9a-f]{40}$/u.test(release.sourceSha) &&
      (release.artifactSha256 == null || /^[0-9a-f]{64}$/u.test(release.artifactSha256)) &&
      (release.storeBuildId == null || (typeof release.storeBuildId === "string" && release.storeBuildId.length > 0)) &&
      Object.keys(entry.identity).length === RETIREMENT_IDENTITY.length &&
      RETIREMENT_IDENTITY.every((key) => entry.identity[key] === (release[key] ?? null)),
    "retirement audit release identity is invalid or outside the legacy allowlist");
    const wasRetired = retired.has(release.reservationId);
    failUnless(entry.action === "retire" ? !wasRetired : wasRetired,
      "retirement audit must alternate retire and unretire");
    if (entry.action === "retire") retired.add(release.reservationId);
    else retired.delete(release.reservationId);
    ids.add(entry.actionId);
    previousTime = Date.parse(entry.recordedAt);
  }
  return retired;
}

export function changeReleaseRetirement(registry, request) {
  validateRegistry(registry);
  assertAvailabilityOpen(registry);
  failUnless(!registry.releases.some((r) => r.availabilityPending != null),
    "retirement is blocked by pending mobile availability");
  failUnless(!registry.production?.operations?.some((op) => ["pending", "uncertain"].includes(op.status)),
    "retirement is blocked by an unresolved production operation");
  const release = registry.releases.find((r) => r.reservationId === request.reservationId);
  failUnless(release, `unknown reservation: ${request.reservationId}`);
  const identity = Object.fromEntries(RETIREMENT_IDENTITY.map((key) => [key, release[key] ?? null]));
  const prior = (registry.retirementAudit ?? []).find((entry) => entry.actionId === request.actionId);
  if (prior) {
    failUnless(prior.action === request.action && prior.actor === request.actor && prior.note === request.note &&
      sameJson(prior.identity, identity) && (request.recordedAt === undefined || prior.recordedAt === request.recordedAt),
    "retirement action ID was already used with different evidence");
    return structuredClone(registry);
  }
  const result = structuredClone(registry);
  result.retirementAudit = [...(result.retirementAudit ?? []), { schemaVersion: 1,
    actionId: request.actionId, action: request.action, actor: request.actor,
    recordedAt: request.recordedAt ?? new Date().toISOString(), note: request.note, identity }];
  validateRegistry(result);
  return result;
}

// Additive to schema v1: historical records remain readable, but absence is never proof.
export function validateInternalSmokeEvidence(release) {
  const proof = release.internalSmokeEvidence;
  failUnless(object(proof) && proof.schemaVersion === 1 && proof.checklistVersion === 1,
    "versioned internal smoke evidence is required");
  failUnless(release.internal && proof.platform === release.platform && proof.sourceSha === release.sourceSha &&
    proof.artifactSha256 === release.artifactSha256 && proof.storeBuildId === release.storeBuildId &&
    proof.marketingVersion === release.marketingVersion && proof.build === release.build,
  "internal smoke evidence identity mismatch");
  failUnless(proof.result === "passed" && typeof proof.testedAt === "string" && Number.isFinite(Date.parse(proof.testedAt)),
    "internal smoke evidence requires a passed dated result");
  for (const field of ["tester", "device", "osVersion"]) failUnless(typeof proof[field] === "string" && proof[field].trim().length > 0,
    `internal smoke evidence requires ${field}`);
  failUnless(typeof proof.evidenceUrl === "string" && /^https:\/\//u.test(proof.evidenceUrl), "internal smoke evidence requires an HTTPS receipt");
  failUnless(["enabled", "disabled"].includes(proof.pushMode), "internal smoke evidence must attest the artifact push mode");
  validateArtifactEvidence(release);
  failUnless(proof.pushMode === release.artifactValidation.pushMode, "internal smoke push mode must match the validated artifact");
  const checks = [...INTERNAL_SMOKE_CHECKS, ...(proof.pushMode === "enabled"
    ? ["notification-permission", "notification-receive-background", "notification-tap"] : ["notification-disabled"])];
  failUnless(object(proof.checks) && checks.every((key) => proof.checks[key] === "passed") &&
    Object.keys(proof.checks).every((key) => checks.includes(key)), "internal smoke checklist must pass in full");
  return proof;
}

export function validateServerCompatibilityEvidence(release) {
  const proof = release.serverCompatibility;
  failUnless(object(proof) && proof.schemaVersion === 1 &&
    proof.platform === release.platform && proof.sourceSha === release.sourceSha &&
    proof.marketingVersion === release.marketingVersion && proof.build === release.build &&
    object(proof.protocol) && proof.protocol.min === release.protocol.min &&
    proof.protocol.max === release.protocol.max && /^https:\/\//u.test(proof.serverUrl) &&
    SHA.test(proof.serverSha) && typeof proof.observedAt === "string" &&
    Number.isFinite(Date.parse(proof.observedAt)),
  "server compatibility evidence identity is invalid");
  failUnless(object(proof.serverProtocol) && positiveInteger(proof.serverProtocol.min) &&
    positiveInteger(proof.serverProtocol.max) && proof.serverProtocol.min <= proof.serverProtocol.max,
  "server compatibility protocol range is invalid");
  failUnless(object(proof.hardMinimum) && VERSION.test(proof.hardMinimum.version) &&
    Number.isInteger(proof.hardMinimum.build) && proof.hardMinimum.build >= 0,
  "server compatibility hard minimum is invalid");
  failUnless(["supported", "recommended"].includes(proof.status),
    "server compatibility evidence must prove a compatible candidate");
  failUnless(proof.protocol.max >= proof.serverProtocol.min &&
    proof.protocol.min <= proof.serverProtocol.max,
  "server compatibility evidence has no protocol overlap");
  failUnless(compareRelease(release.marketingVersion, release.build,
    proof.hardMinimum.version, proof.hardMinimum.build) >= 0,
  "server compatibility evidence is below the live hard minimum");
  return proof;
}

export function validateActivationIntent(intent) {
  failUnless(object(intent) && intent.schemaVersion === 1 &&
    typeof intent.intentId === "string" && /^[A-Za-z0-9._:-]{3,128}$/u.test(intent.intentId) &&
    SHA.test(intent.serverSha) && SHA.test(intent.candidateComponentSha) &&
    SHA256.test(intent.preparedReceiptSha) && SHA256.test(intent.preSwitchEnvSha) &&
    object(intent.serverProtocol) &&
    positiveInteger(intent.serverProtocol.min) && positiveInteger(intent.serverProtocol.max) &&
    intent.serverProtocol.min <= intent.serverProtocol.max && object(intent.hardMinimum) &&
    typeof intent.createdAt === "string" && Number.isFinite(Date.parse(intent.createdAt)),
  "activation intent identity is invalid");
  for (const platform of PLATFORMS) {
    const minimum = intent.hardMinimum[platform];
    failUnless(object(minimum) && VERSION.test(minimum.version) && Number.isInteger(minimum.build) && minimum.build >= 0,
      `activation intent ${platform} hard minimum is invalid`);
  }
  return intent;
}

function validateResolvedIntent(receipt) {
  failUnless(object(receipt) && receipt.schemaVersion === 1 && object(receipt.intent) &&
    typeof receipt.resolvedAt === "string" && Number.isFinite(Date.parse(receipt.resolvedAt)),
  "resolved activation intent receipt is invalid");
  validateActivationIntent(receipt.intent);
  if (receipt.terminalAudit !== undefined) validateTerminalActivationAudit(receipt.terminalAudit, receipt.intent);
  return receipt;
}

function validateTerminalActivationAudit(audit, intent) {
  failUnless(object(audit) && audit.schemaVersion === 1 && audit.version === "terminal-reconciliation-v1" &&
    typeof audit.actor === "string" && audit.actor.trim().length > 0 && SHA256.test(audit.toolSha256) &&
    SHA256.test(audit.registrySha256) && typeof audit.originalIntentJson === "string" &&
    SHA256.test(audit.originalIntentSha256) &&
    createHash("sha256").update(audit.originalIntentJson).digest("hex") === audit.originalIntentSha256 &&
    sameJson(JSON.parse(audit.originalIntentJson), intent) && sameJson(audit.normalizedIntent, intent),
  "terminal activation audit identity is invalid");
  const proof = audit.serverProof;
  const receipt = proof?.receipt;
  const target = receipt?.requested_target_sha || receipt?.target_sha;
  const receiptFields = new Set(["operation_id", "requested_target_sha", "target_sha", "result",
    "active_public_sha", "active_game_sha", "mutation_evidence_complete", "activation_started",
    "activation_completed", "migration_started", "migration_completed", "migration_outcome_uncertain",
    "rollback_result", "prepared_remote_receipt_sha256", "activation_intent_id", "prepared_env_sha256"]);
  failUnless(object(proof) && proof.provenance === "authoritative-deployment-controller" && object(receipt) &&
    Object.keys(receipt).every((key) => receiptFields.has(key)) &&
    receipt.operation_id === intent.intentId && target === intent.serverSha && receipt.result === "completed" &&
    (receipt.requested_target_sha === undefined || receipt.requested_target_sha === intent.serverSha) &&
    (receipt.target_sha === undefined || receipt.target_sha === intent.serverSha) &&
    (receipt.prepared_remote_receipt_sha256 === undefined || receipt.prepared_remote_receipt_sha256 === intent.preparedReceiptSha) &&
    (receipt.activation_intent_id === undefined || receipt.activation_intent_id === intent.intentId) &&
    (receipt.prepared_env_sha256 === undefined || receipt.prepared_env_sha256 === intent.preSwitchEnvSha) &&
    receipt.active_public_sha === intent.serverSha && receipt.active_game_sha === intent.candidateComponentSha &&
    receipt.mutation_evidence_complete === true && receipt.activation_started === true &&
    receipt.activation_completed === true && receipt.migration_outcome_uncertain === false &&
    typeof receipt.migration_started === "boolean" && typeof receipt.migration_completed === "boolean" &&
    receipt.migration_started === receipt.migration_completed && receipt.rollback_result === "not_required" &&
    proof.liveIdentity?.publicSha === receipt.active_public_sha && proof.liveIdentity?.gameSha === receipt.active_game_sha,
  "terminal activation audit requires exact completed server proof");
  return audit;
}

function resolvedIntentReceipts(registry) {
  return registry.resolvedIntents ?? [];
}

// Older registry snapshots stored one resolution receipt in resolvedIntent. Keep that
// receipt readable, but move it into the append-only history before a caller writes state.
export function migrateLegacyResolvedIntent(registry) {
  validateRegistry(registry);
  if (registry.resolvedIntent === undefined) return structuredClone(registry);
  const result = structuredClone(registry);
  const legacy = result.resolvedIntent;
  const receipts = result.resolvedIntents ?? [];
  const duplicate = receipts.find((receipt) => receipt.intent.intentId === legacy.intent.intentId);
  if (duplicate !== undefined) {
    failUnless(sameJson(duplicate, legacy),
      "legacy resolved intent conflicts with resolved intent history");
  } else {
    result.resolvedIntents = [...receipts, legacy];
  }
  delete result.resolvedIntent;
  validateRegistry(result);
  return result;
}

export function setActivationIntent(registry, intent) {
  registry = migrateLegacyResolvedIntent(registry);
  validateActivationIntent(intent);
  const result = structuredClone(registry);
  const priorResolution = resolvedIntentReceipts(result).find((receipt) => receipt.intent.intentId === intent.intentId);
  failUnless(priorResolution === undefined,
    "activation intent was already resolved; retry resolve-activation-intent instead");
  if (result.activationIntent !== undefined) {
    failUnless(sameActivationIntent(result.activationIntent, intent),
      "a different activation intent is already active");
    return result;
  }
  result.activationIntent = structuredClone(intent);
  validateRegistry(result);
  return result;
}

export function resolveActivationIntent(registry, expected, resolvedAt = new Date().toISOString(), terminalAudit) {
  registry = migrateLegacyResolvedIntent(registry);
  const expectedIntent = object(expected) ? expected : { intentId: String(expected) };
  if (terminalAudit !== undefined) {
    validateActivationIntent(expectedIntent);
    validateTerminalActivationAudit(terminalAudit, expectedIntent);
  }
  const matches = (intent) => typeof expectedIntent.intentId === "string" &&
    intent.intentId === expectedIntent.intentId &&
    (!object(expected) || sameActivationIntent(intent, expectedIntent));
  const priorResolution = resolvedIntentReceipts(registry).find((receipt) => receipt.intent.intentId === expectedIntent.intentId);
  if (priorResolution !== undefined) {
    failUnless(matches(priorResolution.intent),
      "activation intent resolution does not match a resolved intent receipt");
    if (terminalAudit !== undefined) {
      failUnless(priorResolution.terminalAudit !== undefined,
        "terminal activation retry requires an existing immutable audit");
      failUnless(sameJson(terminalAudit.serverProof, priorResolution.terminalAudit.serverProof),
        "terminal activation retry conflicts with the immutable server proof");
    }
    return structuredClone(registry);
  }
  failUnless(registry.activationIntent !== undefined,
    "activation intent resolution does not match an active or resolved intent");
  failUnless(matches(registry.activationIntent),
    "activation intent resolution does not match the active intent");
  const result = structuredClone(registry);
  const intent = structuredClone(result.activationIntent);
  delete result.activationIntent;
  result.resolvedIntents = [...resolvedIntentReceipts(result), { schemaVersion: 1, intent, resolvedAt,
    ...(terminalAudit === undefined ? {} : { terminalAudit: structuredClone(terminalAudit) }) }];
  validateRegistry(result);
  return result;
}

function validateArtifactEvidence(release) {
  const artifact = release.artifactValidation;
  failUnless(object(artifact) && artifact.schemaVersion === 1 && artifact.validated === true &&
    artifact.platform === release.platform && artifact.sourceSha === release.sourceSha &&
    artifact.artifactSha256 === release.artifactSha256 && artifact.marketingVersion === release.marketingVersion &&
    artifact.build === release.build && ["enabled", "disabled"].includes(artifact.pushMode), "validated artifact identity and push mode are required");
}

export function validateRegistry(registry) {
  failUnless(object(registry), "registry must be an object");
  failUnless(registry.schemaVersion === 1, "registry schemaVersion must be 1");
  failUnless(object(registry.buildFloor), "registry buildFloor is required");
  failUnless(object(registry.nextBuild), "registry nextBuild is required");
  for (const platform of PLATFORMS) {
    failUnless(positiveInteger(registry.buildFloor[platform]), `${platform} buildFloor must be positive`);
    failUnless(positiveInteger(registry.nextBuild[platform]), `${platform} nextBuild must be positive`);
    failUnless(registry.nextBuild[platform] >= registry.buildFloor[platform],
      `${platform} nextBuild must not be below buildFloor`);
  }
  failUnless(Array.isArray(registry.releases), "registry releases must be an array");
  if (registry.activationIntent !== undefined) validateActivationIntent(registry.activationIntent);
  if (registry.resolvedIntent !== undefined) {
    validateResolvedIntent(registry.resolvedIntent);
  }
  if (registry.resolvedIntents !== undefined) {
    failUnless(Array.isArray(registry.resolvedIntents), "resolved intent history must be an array");
    const resolvedIds = new Set();
    for (const receipt of registry.resolvedIntents) {
      validateResolvedIntent(receipt);
      failUnless(!resolvedIds.has(receipt.intent.intentId),
        "resolved intent history must contain unique intent IDs");
      resolvedIds.add(receipt.intent.intentId);
      failUnless(registry.activationIntent?.intentId !== receipt.intent.intentId,
        "an activation intent cannot also be resolved");
    }
  }
  if (registry.resolvedIntent !== undefined) {
    failUnless(registry.activationIntent?.intentId !== registry.resolvedIntent.intent.intentId,
      "an activation intent cannot also be resolved");
    const duplicate = (registry.resolvedIntents ?? [])
      .find((receipt) => receipt.intent.intentId === registry.resolvedIntent.intent.intentId);
    if (duplicate !== undefined) {
      failUnless(sameJson(duplicate, registry.resolvedIntent),
        "legacy resolved intent conflicts with resolved intent history");
    }
  }
  const reservations = new Set();
  const builds = new Set();
  for (const release of registry.releases) {
    validateRelease(release);
    failUnless(!reservations.has(release.reservationId), "reservationId must be unique");
    reservations.add(release.reservationId);
    const buildKey = `${release.platform}:${release.build}`;
    failUnless(!builds.has(buildKey), `${buildKey} is allocated more than once`);
    builds.add(buildKey);
    failUnless(release.build < registry.nextBuild[release.platform],
      `${buildKey} must be below nextBuild`);
  }
  retirementState(registry);
  return registry;
}

export function reserveBuilds(registry, request) {
  validateRegistry(registry);
  assertAvailabilityOpen(registry);
  validateReservationRequest(request);
  const result = structuredClone(registry);
  const allocations = {};
  for (const platform of request.platforms) {
    const reservationId = `${request.releaseId}:${platform}`;
    const existing = result.releases.find((release) => release.reservationId === reservationId);
    if (existing) {
      assertReservationMatches(existing, request, platform);
      allocations[platform] = existing.build;
      continue;
    }
    if (request.remoteMaximum) {
      const maximum = request.remoteMaximum[platform];
      failUnless(Number.isInteger(maximum) && maximum >= 0 && maximum < 2_100_000_000,
        "remote maximum is invalid");
      result.buildFloor[platform] = Math.max(result.buildFloor[platform], maximum + 1);
      result.nextBuild[platform] = Math.max(result.nextBuild[platform], result.buildFloor[platform]);
    }
    const build = result.nextBuild[platform];
    result.nextBuild[platform] += 1;
    result.releases.push({
      reservationId,
      releaseId: request.releaseId,
      platform,
      marketingVersion: request.marketingVersions[platform],
      build,
      generation: request.generation,
      sourceSha: request.sourceSha,
      protocol: { min: request.protocolMin, max: request.protocolMax },
      reservedAt: request.now,
      uploadAttempted: false,
      uploaded: false,
      processed: false,
      internal: false,
      externalApproved: false,
      open: false,
      downloadTested: false,
      supported: false,
      compatibilityProtected: false,
      artifactSha256: null,
      storeBuildId: null,
      receiptUrl: null,
      releaseMode: request.releaseMode ?? "internal",
      availabilityPending: null,
      milestones: { reserved: true }
    });
    allocations[platform] = build;
  }
  validateRegistry(result);
  return {
    registry: result,
    allocations,
    reservations: Object.fromEntries(request.platforms.map((platform) => [
      platform,
      result.releases.find((release) => release.reservationId === `${request.releaseId}:${platform}`)
    ]))
  };
}

export function transitionRelease(registry, reservationId, patch) {
  validateRegistry(registry);
  assertAvailabilityOpen(registry);
  failUnless(object(patch), "transition patch must be an object");
  const allowed = new Set([
    "uploadAttempted", "uploaded", "processed", "internal", "externalApproved", "open",
    "downloadTested", "supported", "compatibilityProtected", "artifactSha256", "storeBuildId",
    "receiptUrl", "milestones", "externalGroupId", "publicLink", "artifactValidation", "internalSmokeEvidence",
    "serverCompatibility", "promotionApproval", "promotionExecutions", "availabilityPending"
  ]);
  for (const key of Object.keys(patch)) failUnless(allowed.has(key), `transition field is not allowed: ${key}`);
  const result = structuredClone(registry);
  const release = result.releases.find((entry) => entry.reservationId === reservationId);
  failUnless(release, `unknown reservation: ${reservationId}`);
  for (const field of ["uploadAttempted", "uploaded", "processed", "internal",
    "externalApproved", "open", "downloadTested", "supported", "compatibilityProtected"]) {
    failUnless(!(release[field] && patch[field] === false), `${field} cannot move backward`);
  }
  for (const field of ["artifactSha256", "storeBuildId", "receiptUrl"]) {
    failUnless(release[field] === null || patch[field] === undefined || patch[field] === release[field],
      `${field} cannot change after it is recorded`);
  }
  for (const field of ["externalGroupId", "publicLink"]) {
    failUnless(!release[field] || patch[field] === undefined || patch[field] === release[field], `${field} is immutable`);
  }
  for (const field of ["artifactValidation", "internalSmokeEvidence", "serverCompatibility", "promotionApproval"]) {
    failUnless(release[field] === undefined || patch[field] === undefined ||
      JSON.stringify(release[field]) === JSON.stringify(patch[field]), `${field} is immutable`);
  }
  if (patch.availabilityPending !== undefined) {
    if (release.availabilityPending && patch.availabilityPending !== null) {
      failUnless(sameJson(release.availabilityPending, patch.availabilityPending),
        "availability pending identity is immutable");
    } else if (patch.availabilityPending !== null) {
      failUnless(patch.uploadAttempted !== true,
        "availability pending must be committed before uploadAttempted");
    } else if (patch.availabilityPending === null) {
      failUnless(release.availabilityPending === undefined || release.availabilityPending === null ||
        (patch.uploaded === true && patch.processed === true && patch.internal === true && patch.compatibilityProtected === true),
      "availability pending can only be cleared with verified internal availability");
    }
  }
  if (patch.promotionExecutions !== undefined) failUnless(Array.isArray(patch.promotionExecutions) &&
    (release.promotionExecutions ?? []).every((entry, i) => JSON.stringify(entry) === JSON.stringify(patch.promotionExecutions[i])),
  "promotion executions must be append-only");
  if (patch.milestones) {
    for (const [key, value] of Object.entries(patch.milestones)) {
      failUnless(BETA_STATES.includes(key) && value === true, "invalid milestone");
    }
    patch = { ...patch, milestones: { ...release.milestones, ...patch.milestones } };
  }
  Object.assign(release, patch);
  if (patch.open || patch.externalApproved || EXTERNAL_STATES.some((key) => patch.milestones?.[key])) {
    validateInternalSmokeEvidence(release);
    failUnless(release.promotionApproval && release.promotionExecutions?.length > 0, "external transition requires explicit promotion approval and execution receipt");
  }
  validateRegistry(result);
  return result;
}

export function releaseUnusedReservation(registry, reservationId) {
  validateRegistry(registry);
  assertAvailabilityOpen(registry);
  const result = structuredClone(registry);
  const index = result.releases.findIndex((entry) => entry.reservationId === reservationId);
  failUnless(index >= 0, `unknown reservation: ${reservationId}`);
  const release = result.releases[index];
  failUnless(!release.uploadAttempted, "an upload-attempted build number is permanently consumed");
  result.releases.splice(index, 1);
  while (result.nextBuild[release.platform] > result.buildFloor[release.platform] &&
      !result.releases.some((entry) => entry.platform === release.platform &&
        entry.build === result.nextBuild[release.platform] - 1)) {
    result.nextBuild[release.platform] -= 1;
  }
  validateRegistry(result);
  return result;
}

export function supportedReleases(registry) {
  validateRegistry(registry);
  const retired = retirementState(registry);
  return registry.releases.filter((release) => !retired.has(release.reservationId) && (release.supported || release.compatibilityProtected ||
    (release.availabilityPending !== undefined && release.availabilityPending !== null) ||
    (release.uploadAttempted && !release.supported && !release.compatibilityProtected)));
}

export function distributedSourceByPlatform(registry) {
  validateRegistry(registry);
  const result = {};
  for (const platform of PLATFORMS) {
    const candidates = registry.releases
      .filter((release) => release.platform === platform &&
        (release.internal || release.compatibilityProtected || release.supported ||
          release.externalApproved || release.open))
      .sort((left, right) => right.build - left.build);
    failUnless(candidates.length > 0, `${platform} has no distributed source baseline`);
    const release = candidates[0];
    result[platform] = {
      platform,
      sourceSha: release.sourceSha,
      releaseId: release.releaseId,
      reservationId: release.reservationId,
      generation: release.generation,
      marketingVersion: release.marketingVersion,
      build: release.build
    };
  }
  return result;
}

function validateRelease(release) {
  failUnless(object(release), "release must be an object");
  failUnless(typeof release.reservationId === "string" && release.reservationId.length > 2,
    "release reservationId is required");
  failUnless(typeof release.releaseId === "string" && release.releaseId.length > 0,
    "release releaseId is required");
  failUnless(PLATFORMS.has(release.platform), "release platform is invalid");
  failUnless(VERSION.test(release.marketingVersion), "release marketingVersion is invalid");
  failUnless(positiveInteger(release.build), "release build must be positive");
  failUnless(GENERATION.test(release.generation), "release generation is invalid");
  failUnless(SHA.test(release.sourceSha), "release sourceSha is invalid");
  failUnless(typeof release.reservedAt === "string" && !Number.isNaN(Date.parse(release.reservedAt)),
    "release reservedAt is invalid");
  failUnless(object(release.protocol) && positiveInteger(release.protocol.min) &&
    positiveInteger(release.protocol.max) && release.protocol.min <= release.protocol.max,
  "release protocol range is invalid");
  for (const field of ["uploadAttempted", "uploaded", "processed", "internal",
    "externalApproved", "open", "downloadTested", "supported", "compatibilityProtected"]) {
    failUnless(typeof release[field] === "boolean", `release ${field} must be boolean`);
  }
  failUnless(!release.uploaded || release.uploadAttempted, "uploaded requires uploadAttempted");
  failUnless(!release.processed || release.uploaded, "processed requires uploaded");
  failUnless(!release.internal || release.processed, "internal requires processed");
  failUnless(!release.externalApproved || release.platform === "ios", "externalApproved is iOS-only");
  failUnless(!release.open || release.platform === "android", "open is Android-only");
  failUnless(!release.externalApproved || release.internal, "externalApproved requires internal");
  failUnless(!release.open || release.internal, "open requires internal");
  failUnless(!release.downloadTested || (release.platform === "ios"
    ? release.externalApproved
    : release.open), "downloadTested requires relevant external availability");
  failUnless(!release.supported || (release.downloadTested &&
    (release.externalApproved || release.open)),
  "supported requires externally available and download-tested");
  failUnless(!release.compatibilityProtected || release.internal ||
    (release.build === 1 && release.uploadAttempted),
  "compatibilityProtected requires verified internal availability except legacy build 1");
  if (release.artifactSha256 !== null) {
    failUnless(/^[0-9a-f]{64}$/u.test(release.artifactSha256), "artifactSha256 is invalid");
  }
  for (const field of ["storeBuildId", "receiptUrl"]) {
    failUnless(release[field] === null || typeof release[field] === "string", `${field} is invalid`);
  }
  if (release.uploaded || release.internal) {
    failUnless(typeof release.artifactSha256 === "string", "uploaded/internal requires artifactSha256");
    failUnless(typeof release.storeBuildId === "string" && release.storeBuildId.length > 0,
      "uploaded/internal requires storeBuildId");
    failUnless(typeof release.receiptUrl === "string" && /^https:\/\//u.test(release.receiptUrl),
      "uploaded/internal requires receiptUrl evidence");
  }
  failUnless(release.releaseMode === undefined || ["internal", "open-beta"].includes(release.releaseMode), "invalid release mode");
  if (release.artifactValidation !== undefined) validateArtifactEvidence(release);
  if (release.internalSmokeEvidence !== undefined) validateInternalSmokeEvidence(release);
  if (release.serverCompatibility !== undefined) validateServerCompatibilityEvidence(release);
  if (release.availabilityPending !== undefined && release.availabilityPending !== null) {
    validateAvailabilityPending(release);
    failUnless(!release.compatibilityProtected && !release.supported && !release.uploaded && !release.processed && !release.internal,
      "availability pending cannot coexist with verified availability");
  }
  if (release.promotionApproval !== undefined) {
    validateInternalSmokeEvidence(release);
    const approval = release.promotionApproval;
    failUnless(object(approval) && approval.schemaVersion === 1 && approval.intent === "promote-existing" &&
      release.releaseMode === "open-beta" && SHA.test(approval.toolSha) &&
      typeof approval.actor === "string" && approval.actor.trim() &&
      /^https:\/\/github\.com\/.+\/actions\/runs\/\d+$/u.test(approval.receiptUrl) &&
      Number.isFinite(Date.parse(approval.approvedAt)), "invalid promotion approval receipt");
  }
  if (release.promotionExecutions !== undefined) {
    failUnless(release.promotionApproval && Array.isArray(release.promotionExecutions), "execution requires promotion approval");
    for (const execution of release.promotionExecutions) failUnless(object(execution) && execution.schemaVersion === 1 &&
      SHA.test(execution.toolSha) && typeof execution.actor === "string" && execution.actor.trim() &&
      /^https:\/\/github\.com\/.+\/actions\/runs\/\d+$/u.test(execution.receiptUrl) && Number.isFinite(Date.parse(execution.startedAt)),
    "invalid promotion execution receipt");
  }
  failUnless(release.externalGroupId === undefined || (release.platform === "ios" && /^[A-Za-z0-9-]+$/u.test(release.externalGroupId)), "invalid external group identity");
  failUnless(release.publicLink === undefined || (release.platform === "ios" && /^https:\/\/testflight\.apple\.com\/join\/[A-Za-z0-9]+$/u.test(release.publicLink)), "invalid public link");
  if (release.milestones !== undefined) {
    failUnless(object(release.milestones), "milestones must be an object");
    for (const [key, value] of Object.entries(release.milestones)) failUnless(BETA_STATES.includes(key) && value === true, "invalid milestone");
    const m = release.milestones;
    failUnless(!m.built || typeof release.artifactSha256 === "string", "built requires artifact fingerprint");
    failUnless(!m.uploaded || release.uploaded, "uploaded milestone requires uploaded receipt");
    failUnless(!m.internal_verified || release.internal, "internal_verified requires internal");
    for (const key of EXTERNAL_STATES) failUnless(!m[key] || (release.releaseMode === "open-beta" && release.internal), "external milestone requires open-beta internal verification");
    for (const key of ["google_open_submitted", "google_open_verified"]) failUnless(!m[key] || release.platform === "android", "Google milestone requires Android");
    for (const key of ["ios_beta_review_submitted", "ios_beta_review_pending", "ios_external_verified"]) failUnless(!m[key] || release.platform === "ios", "Apple milestone requires iOS");
    failUnless(!m.google_open_verified || (m.google_open_submitted && release.open), "Google verification requires submitted/open");
    failUnless(!m.ios_beta_review_pending || m.ios_beta_review_submitted, "pending requires review submission");
    failUnless(!m.ios_external_verified || (release.externalApproved && release.externalGroupId && release.publicLink), "Apple verification requires external group evidence");
    failUnless(!m.open_beta_complete || (release.platform === "ios" ? m.ios_external_verified : m.google_open_verified), "completion requires store verification");
  }
}

function validateAvailabilityPending(release) {
  const pending = release.availabilityPending;
  failUnless(object(pending) && pending.schemaVersion === 1 &&
    pending.reservationId === release.reservationId && pending.releaseId === release.releaseId &&
    pending.platform === release.platform && pending.sourceSha === release.sourceSha &&
    pending.marketingVersion === release.marketingVersion && pending.build === release.build &&
    object(pending.protocol) && pending.protocol.min === release.protocol.min &&
    pending.protocol.max === release.protocol.max && /^[0-9a-f]{64}$/u.test(pending.artifactSha256) &&
    pending.artifactSha256 === release.artifactSha256 && typeof pending.preparedAt === "string" &&
    Number.isFinite(Date.parse(pending.preparedAt)),
  "availability pending identity is invalid");
}

function validateReservationRequest(request) {
  failUnless(object(request), "reservation request must be an object");
  failUnless(typeof request.releaseId === "string" && /^[A-Za-z0-9._-]{3,128}$/u.test(request.releaseId),
    "releaseId is invalid");
  failUnless(Array.isArray(request.platforms) && request.platforms.length > 0,
    "at least one platform is required");
  failUnless(new Set(request.platforms).size === request.platforms.length &&
    request.platforms.every((platform) => PLATFORMS.has(platform)), "platforms are invalid");
  failUnless(object(request.marketingVersions), "marketingVersions is required");
  for (const platform of request.platforms) {
    failUnless(VERSION.test(request.marketingVersions[platform]),
      `${platform} marketingVersion is invalid`);
    failUnless(platform !== "ios" || /^\d+\.\d+\.\d+$/u.test(request.marketingVersions[platform]),
      "iOS marketingVersion must contain three numeric components before reservation");
  }
  failUnless(GENERATION.test(request.generation), "generation is invalid");
  failUnless(SHA.test(request.sourceSha), "sourceSha is invalid");
  failUnless(positiveInteger(request.protocolMin) && positiveInteger(request.protocolMax) &&
    request.protocolMin <= request.protocolMax, "protocol range is invalid");
  failUnless(typeof request.now === "string" && !Number.isNaN(Date.parse(request.now)), "now is invalid");
  failUnless(["internal", "open-beta"].includes(request.releaseMode ?? "internal"), "invalid release mode");
  failUnless(request.releaseMode !== "open-beta" || (request.remoteMaximum && request.platforms.length === 2), "open-beta requires both platforms and remote history");
}

function assertReservationMatches(existing, request, platform) {
  failUnless(existing.platform === platform && existing.releaseId === request.releaseId &&
    existing.marketingVersion === request.marketingVersions[platform] &&
    existing.generation === request.generation &&
    existing.sourceSha === request.sourceSha && existing.protocol.min === request.protocolMin &&
    existing.protocol.max === request.protocolMax && (existing.releaseMode ?? "internal") === (request.releaseMode ?? "internal"),
  `reservation ${existing.reservationId} cannot be reused for different source or release metadata`);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameJson(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => sameJson(value, right[index]));
  }
  if (object(left) || object(right)) {
    if (!object(left) || !object(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && sameJson(left[key], right[key]));
  }
  return left === right;
}

// PowerShell's round-trip format writes 7 fraction digits, while other
// serializers drop trailing zeros; treat those spellings as the same instant.
function canonicalTimestamp(value) {
  return typeof value === "string" ? value.replace(/(\.\d*?)0+Z$/u, "$1Z").replace(/\.Z$/u, "Z") : value;
}

function sameActivationIntent(left, right) {
  if (!object(left) || !object(right)) return sameJson(left, right);
  return sameJson({ ...left, createdAt: canonicalTimestamp(left.createdAt) },
    { ...right, createdAt: canonicalTimestamp(right.createdAt) });
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0 && value <= 2_147_483_647;
}

function compareRelease(leftVersion, leftBuild, rightVersion, rightBuild) {
  const left = leftVersion.split(/[.-]/u).slice(0, 3).map(Number);
  const right = rightVersion.split(/[.-]/u).slice(0, 3).map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return leftBuild - rightBuild;
}

function failUnless(condition, message) {
  if (!condition) throw new Error(message);
}

function assertAvailabilityOpen(registry) {
  failUnless(registry.activationIntent === undefined,
    `mobile availability is frozen by activation intent ${registry.activationIntent?.intentId ?? "active"}`);
}
