import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  artifactSha256,
  quarantineFile,
  scopedEnvironment,
  writeJsonAtomic
} from "./coordinated-build-boundary.mjs";
import { createClients, verifyDailyTesterStore, verifyInternalStore } from "./store-api.mjs";
import { verifyLiveServerCompatibility } from "./live-server-compatibility.mjs";
import {
  coordinatedApprovalFingerprint,
  coordinatedCandidateIdentity
} from "./coordinated-receipts.mjs";
import { productionCandidateFingerprint } from "./production-registry.mjs";
import { DAILY_TESTER_MODE, normalizeTesterDestination, readTesterDestination } from "./coordinated-mobile-testers.mjs";

const PLATFORMS = ["ios", "android"];
const ACTIONS = ["upload", "prepare", "submit", "reconcile", "release", "advance", "pause", "resume"];
const PRODUCTION_APPROVAL_ACTIONS = new Set(["release", "advance", "pause", "resume"]);
const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const GENERATION = /^t\d{3,4}$/u;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const REGISTRY_REMOTE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const ACTION_REQUIRED = "ACTION_REQUIRED_PROVISION_TRUSTED_STORE";
const SAFE_ACTION_REQUIRED = "ACTION_REQUIRED_PROVISION_ISOLATED_BUILD";
const GOOGLE_ACTION_REQUIRED = "ACTION_REQUIRED_GOOGLE_PLAY";
const TRUSTED_ENV_NAMES = [
  "PATH", "HOME", "TMPDIR", "RUNNER_TEMP", "CI", "GITHUB_ACTIONS", "GITHUB_RUN_ID",
  "GITHUB_SERVER_URL", "GITHUB_REPOSITORY", "GITHUB_ACTOR", "ASH_ATLAS_REGISTRY_TOKEN",
  "APP_STORE_CONNECT_KEY_ID", "APP_STORE_CONNECT_ISSUER_ID", "APP_STORE_CONNECT_KEY_P8_BASE64",
  "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64", "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON", "ASH_ATLAS_TESTFLIGHT_INTERNAL_GROUP",
  "ASH_ATLAS_IOS_BUNDLE_ID", "ASH_ATLAS_ANDROID_PACKAGE", "ASH_ATLAS_BETA_NOTES",
  "APP_STORE_CONNECT_PRODUCTION_KEY_ID", "APP_STORE_CONNECT_PRODUCTION_ISSUER_ID",
  "APP_STORE_CONNECT_PRODUCTION_KEY_P8_BASE64", "GOOGLE_PLAY_PRODUCTION_SERVICE_ACCOUNT_JSON_BASE64",
  "ASH_ATLAS_PRODUCTION_MUTATION", "COORDINATED_PRODUCTION_RELEASE_APPROVAL_SHA256",
  "GOOGLE_PLAY_MANAGED_PUBLISHING_ATTESTATION_PATH",
  "COORDINATED_FASTLANE_ROOT", "COORDINATED_BUNDLE_EXECUTABLE", "MOBILE_COMPATIBILITY_SERVER_URL",
  "PRODUCTION_REGISTRY_FILE", "PRODUCTION_REGISTRY_REMOTE", "PRODUCTION_REGISTRY_BRANCH",
  "PRODUCTION_REGISTRY_SEED", "VITE_NATIVE_APP_VERSION", "ASH_ATLAS_STORE_BUILD", "RELEASE_ID",
  "SOURCE_SHA", "GENERATION", "STORE_PLATFORM", "PLATFORM_LIST", "DRY_RUN",
  "COORDINATED_DAILY_TESTERS"
];

/**
 * Trusted private-control adapter for the durable controller.  The adapter is
 * intentionally rooted in the immutable control checkout.  It can invoke
 * Fastlane only from an explicitly provisioned control-tooling root, and it
 * delegates production mutations to production.mjs so the existing registry,
 * store allowlist, CAS journal, and response-loss rules remain authoritative.
 */
export async function runTrustedStoreAdapter({
  request,
  env = process.env,
  now = new Date().toISOString(),
  commandRunner = defaultCommandRunner,
  registryRunner = null,
  internalVerifier = null,
  dailyVerifier = null,
  compatibilityVerifier = null,
  productionRunner = null,
  snapshotRunner = null
}) {
  try {
    validateRequest(request);
    const dependencies = { commandRunner, registryRunner, internalVerifier, dailyVerifier, compatibilityVerifier,
      productionRunner, snapshotRunner };
    if (request.delivery_mode === DAILY_TESTER_MODE) {
      if (request.action === "upload") return await handleUpload(request, env, now, dependencies);
      if (isUploadReconcile(request)) return await handleUploadReconcile(request, env, now, dependencies);
      if (request.action === "prepare" ||
        (request.action === "reconcile" && reconcileTargetAction(request) === "prepare")) {
        return await handleDailyPrepare(request, env, now, dependencies);
      }
      if (request.action === "submit" ||
        (request.action === "reconcile" && reconcileTargetAction(request) === "submit")) {
        return await handleDailySubmit(request, env, now, dependencies);
      }
      if (request.action === "release" ||
        (request.action === "reconcile" && reconcileTargetAction(request) === "release")) {
        return await handleDailyActivate(request, env, now, dependencies);
      }
      throw new Error(`${ACTION_REQUIRED}: daily tester mode does not support production transitions`);
    }
    if (request.action === "upload") return await handleUpload(request, env, now, dependencies);
    if (isUploadReconcile(request)) {
      return await handleUploadReconcile(request, env, now, dependencies);
    }
    if (request.action === "reconcile" && reconcileTargetAction(request) === "prepare") {
      return await handlePrepareReconcile(request, env, now, dependencies);
    }
    return await handleProductionAction(request, env, now, dependencies);
  } catch (error) {
    return actionRequired(error, request, now);
  }
}

export function validateRequest(request) {
  requireState(request && request.schema_version === 1 &&
    request.kind === "ash-atlas-coordinated-store-step-request", "trusted store request schema is invalid");
  requireState(ACTIONS.includes(request.action), "trusted store action is invalid");
  requireState(OPERATION_ID.test(String(request.coordinated_operation_id)) &&
    OPERATION_ID.test(String(request.child_operation_id)) &&
    request.child_operation_id === `${request.coordinated_operation_id}:${request.platform}`,
  "trusted store operation identity is invalid");
  requireState(PLATFORMS.includes(request.platform), "trusted store platform is invalid");
  requireState(GENERATION.test(String(request.generation)) && SHA.test(String(request.source_sha)) &&
    SHA.test(String(request.accepted_master_sha)) && SHA.test(String(request.current_server_sha)) &&
    SHA.test(String(request.tooling_sha)), "trusted store pinned identity is invalid");
  requireState(REGISTRY_REMOTE.test(String(request.registry_remote)), "trusted store registry remote is invalid");
  requireState(typeof request.registry_branch === "string" && /^[A-Za-z0-9._/-]{1,200}$/u.test(request.registry_branch),
    "trusted store registry branch is invalid");
  for (const [name, value] of [["source_repository_root", request.source_repository_root],
    ["tooling_root", request.tooling_root], ["handoff_root", request.handoff_root],
    ["signed_manifest_path", request.signed_manifest_path]]) {
    requireState(typeof value === "string" && isAbsolute(value), `${name} must be an absolute path`);
  }
  requireState(resolve(request.source_repository_root) !== resolve(request.tooling_root),
    "trusted store source and tooling roots must be distinct");
  requireState(request.candidate && typeof request.candidate === "object",
    "trusted store candidate is required");
  const candidate = request.candidate;
  if (request.delivery_mode === DAILY_TESTER_MODE) {
    requireState(readTesterDestination(request.platform, candidate, ["tester_destination", "testerDestination"]),
      "daily tester destination is required");
  }
  requireState(candidate.platform === request.platform && candidate.release_id &&
    candidate.release_id === request.release_id && candidate.operation_id === request.child_operation_id &&
    candidate.source_sha === request.source_sha && candidate.generation === request.generation &&
    VERSION.test(String(candidate.marketing_version)) && Number.isInteger(Number(candidate.build)) &&
    Number(candidate.build) > 0 && SHA256.test(String(candidate.artifact_sha256)) &&
    SHA256.test(String(candidate.metadata_sha256)), "trusted store candidate identity is invalid");
  if (request.action !== "upload" && !isUploadReconcile(request)) {
    requireState(typeof candidate.store_build_id === "string" && candidate.store_build_id.length > 0,
      "trusted store production action requires the verified store build identity");
  }
  requireState(candidate.rollout && typeof candidate.rollout === "object" &&
    ["first-publish", "update"].includes(candidate.rollout.kind),
  "trusted store rollout identity is invalid");
  if (candidate.metadata_packet_path !== undefined) {
    requireState(isAbsolute(String(candidate.metadata_packet_path)),
      "trusted store metadata packet path must be absolute");
  }
  if (request.action === "reconcile" && request.target_action !== undefined) requireState(
    typeof request.target_action === "string" && ACTIONS.includes(request.target_action),
    "trusted store reconcile target action is invalid");
  return request;
}

export function fastlaneInvocation({ platform, artifactPath, env, sourceRepositoryRoot, request = null }) {
  requireState(typeof env.COORDINATED_FASTLANE_ROOT === "string" &&
    isAbsolute(env.COORDINATED_FASTLANE_ROOT),
    `${SAFE_ACTION_REQUIRED}: a trusted Fastlane root is required`);
  const root = resolve(env.COORDINATED_FASTLANE_ROOT);
  requireState(existsSync(root) && statSync(root).isDirectory(),
    `${SAFE_ACTION_REQUIRED}: a trusted Fastlane root is required`);
  requireState(!isDescendant(root, sourceRepositoryRoot) && root !== resolve(sourceRepositoryRoot),
    `${SAFE_ACTION_REQUIRED}: Fastlane must not execute from the game source mirror`);
  requireState(isAbsolute(artifactPath) && existsSync(artifactPath),
    `${SAFE_ACTION_REQUIRED}: signed ${platform} artifact is unavailable`);
  const executable = env.COORDINATED_BUNDLE_EXECUTABLE ?? "bundle";
  const args = ["exec", "fastlane", platform, "upload_internal"];
  const overrides = {
    STORE_PLATFORM: platform, VITE_NATIVE_APP_VERSION: request?.candidate?.marketing_version,
    ASH_ATLAS_STORE_BUILD: request?.candidate?.build, RELEASE_ID: request?.release_id,
    SOURCE_SHA: request?.source_sha, GENERATION: request?.generation,
    PRODUCTION_REGISTRY_FILE: request?.registry_file, PRODUCTION_REGISTRY_REMOTE: request?.registry_remote,
    PRODUCTION_REGISTRY_BRANCH: request?.registry_branch, PRODUCTION_REGISTRY_SEED: request?.registry_seed,
    COORDINATED_DAILY_TESTERS: request?.delivery_mode === DAILY_TESTER_MODE ? "true" : "false",
    ...(platform === "ios" ? { ASH_ATLAS_IPA_PATH: artifactPath } : { ASH_ATLAS_AAB_PATH: artifactPath })
  };
  return { command: executable, args, cwd: root,
    env: scopedEnvironment({ env, names: TRUSTED_ENV_NAMES, overrides }) };
}

export function productionEnvironment(request, env, action, attemptId = null,
  productionCandidate = null, derivedApproval = null) {
  const candidate = request.candidate;
  const platform = request.platform;
  const metadataPath = candidate.metadata_packet_path;
  requireState(typeof metadataPath === "string" && isAbsolute(metadataPath),
    `${ACTION_REQUIRED}: approved ${platform} metadata packet is required`);
  const approvalAction = action === "reconcile" ? reconcileTargetAction(request) : action;
  const releaseApproval = PRODUCTION_APPROVAL_ACTIONS.has(approvalAction)
    ? productionCandidateApproval(request, env, productionCandidate, derivedApproval)
    : null;
  const result = scopedEnvironment({ env, names: TRUSTED_ENV_NAMES, overrides: {
    DRY_RUN: "false",
    PLATFORM_LIST: platform,
    PRODUCTION_REGISTRY_REMOTE: request.registry_remote,
    PRODUCTION_REGISTRY_BRANCH: request.registry_branch,
    ...(request.registry_file ? { PRODUCTION_REGISTRY_FILE: request.registry_file } : {}),
    ...(request.registry_seed ? { PRODUCTION_REGISTRY_SEED: request.registry_seed } : {}),
    PRODUCTION_SOURCE_REPOSITORY: request.source_repository_root,
    PRODUCTION_TOOL_SHA: request.tooling_sha,
    PRODUCTION_MASTER_SHA: request.accepted_master_sha,
    SOURCE_SHA: request.source_sha,
    GENERATION: request.generation,
    RELEASE_ID: request.release_id,
    PRODUCTION_METADATA_PACKET_PATH: metadataPath,
    [`${platform.toUpperCase()}_PRODUCTION_METADATA_PACKET_PATH`]: metadataPath,
    PRODUCTION_METADATA_SHA256: candidate.metadata_sha256,
    [`${platform.toUpperCase()}_PRODUCTION_METADATA_SHA256`]: candidate.metadata_sha256,
    PRODUCTION_COUNTRIES: (candidate.countries ?? []).join(","),
    [`${platform.toUpperCase()}_PRODUCTION_COUNTRIES`]: (candidate.countries ?? []).join(","),
    PRODUCTION_ROLLOUT: JSON.stringify(candidate.rollout),
    [`${platform.toUpperCase()}_PRODUCTION_ROLLOUT`]: JSON.stringify(candidate.rollout),
    ...(platform === "android" ? {
      GOOGLE_PLAY_MANAGED_PUBLISHING: String(candidate.managed_publishing === true),
      GOOGLE_PLAY_FIRST_PUBLICATION_BOOTSTRAP: String(candidate.first_publication_bootstrap_verified === true)
    } : {}),
    ...(attemptId ? { PRODUCTION_OPERATION_ID: attemptId } : {}),
    ...(releaseApproval
      ? { PRODUCTION_RELEASE_APPROVED: "true",
        PRODUCTION_RELEASE_APPROVAL_SHA256: releaseApproval }
      : {})
  } });
  if (releaseApproval) {
    requireState(result.PRODUCTION_RELEASE_APPROVAL_SHA256 === releaseApproval,
      `${ACTION_REQUIRED}: explicit production transition approval is missing or not candidate-bound`);
  }
  return result;
}

export function productionApprovalFingerprint(request) {
  const candidate = request.candidate;
  return coordinatedApprovalFingerprint({
    platform: candidate.platform,
    release_id: candidate.release_id,
    source_sha: candidate.source_sha,
    generation: candidate.generation,
    marketing_version: candidate.marketing_version,
    build: Number(candidate.build),
    store_build_id: String(candidate.store_build_id ?? ""),
    artifact_sha256: candidate.artifact_sha256,
    tooling_sha: candidate.tooling_sha,
    metadata_sha256: candidate.metadata_sha256,
    countries: [...(candidate.countries ?? [])].map(String).sort(),
    rollout: structuredClone(candidate.rollout)
  });
}

function reconcileTargetAction(request) {
  if (request.action !== "reconcile") return request.action;
  return request.target_action ?? request.previous_platform_state?.pending?.action ?? null;
}

function isUploadReconcile(request) {
  return request.action === "reconcile" && reconcileTargetAction(request) === "upload";
}

function requiresProductionApproval(request) {
  return PRODUCTION_APPROVAL_ACTIONS.has(reconcileTargetAction(request));
}

function deriveProductionApproval(request, productionCandidate) {
  requireState(productionCandidate && typeof productionCandidate === "object",
    `${ACTION_REQUIRED}: prepared production candidate is unavailable`);
  const requestIdentity = coordinatedCandidateIdentity(request.candidate);
  const preparedIdentity = coordinatedCandidateIdentity(productionCandidate);
  requireState(sameJson(preparedIdentity, requestIdentity),
    "prepared production candidate changed its coordinated identity");
  assertAuthenticatedReleaseAuthorization(request, requestIdentity);
  return productionCandidateFingerprint(productionCandidate);
}

function productionCandidateApproval(request, env, productionCandidate, derivedApproval) {
  if (productionCandidate) {
    const expected = productionCandidateFingerprint(productionCandidate);
    requireState(derivedApproval === null || derivedApproval === expected,
      "derived production approval changed its prepared candidate");
    return derivedApproval ?? deriveProductionApproval(request, productionCandidate);
  }
  const fallback = env.COORDINATED_PRODUCTION_RELEASE_APPROVAL_SHA256;
  requireState(SHA256.test(String(fallback ?? "")),
    `${ACTION_REQUIRED}: prepared production approval is unavailable`);
  return fallback;
}

function assertAuthenticatedReleaseAuthorization(request, requestIdentity) {
  const evidence = request.server_evidence;
  requireState(evidence?.authenticated === true && evidence.authoritative === true &&
    evidence.published === true && evidence.activated === true && evidence.healthy === true,
  `${ACTION_REQUIRED}: authenticated post-health release authorization is required`);
  const entry = evidence.candidates?.[request.platform] ?? evidence.apps?.[request.platform];
  const evidenceCandidate = entry?.candidate ?? entry;
  requireState(evidenceCandidate, `${ACTION_REQUIRED}: post-health candidate authorization is missing`);
  requireState(sameJson(coordinatedCandidateIdentity(evidenceCandidate), requestIdentity),
    `${ACTION_REQUIRED}: post-health candidate authorization changed`);
  requireState(entry.approval_fingerprint === coordinatedApprovalFingerprint(requestIdentity),
    `${ACTION_REQUIRED}: post-health candidate approval fingerprint changed`);
}

async function handleUpload(request, env, now, dependencies) {
  const releaseInfo = registryCall(request, env, "inspect", ["--release-id", request.release_id], dependencies);
  const release = releaseInfo.reservations?.[request.platform];
  assertReservation(request, release);
  const artifact = signedArtifact(request);
  if (release.artifactSha256) requireState(release.artifactSha256 === artifact.sha256,
    "registry artifact identity changed after signing");
  const pending = release.availabilityPending;
  if (pending) assertAvailabilityPending(request, release, pending, artifact.sha256);
  let verifiedStoreBuildId = release.storeBuildId;
  if (!release.uploadAttempted) {
    if (!pending) {
      const availabilityPending = {
        schemaVersion: 1, reservationId: release.reservationId, releaseId: release.releaseId,
        platform: release.platform, sourceSha: release.sourceSha, marketingVersion: release.marketingVersion,
        build: release.build, protocol: release.protocol, artifactSha256: artifact.sha256, preparedAt: now
      };
      registryCall(request, env, "transition", ["--reservation-id", release.reservationId,
        "--patch", JSON.stringify({ artifactSha256: artifact.sha256, availabilityPending })], dependencies);
    }
    registryCall(request, env, "transition", ["--reservation-id", release.reservationId,
      "--patch", JSON.stringify({ uploadAttempted: true })], dependencies);
    const invocation = fastlaneInvocation({ platform: request.platform, artifactPath: artifact.path,
      env, sourceRepositoryRoot: request.source_repository_root, request });
    dependencies.commandRunner(invocation.command, invocation.args, invocation);
  }
  const verifier = request.delivery_mode === DAILY_TESTER_MODE
    ? verifyDailyUploadedArtifact : (dependencies.internalVerifier ?? verifyInternalArtifact);
  const verification = await verifier({ request, env, release: {
    ...release, uploadAttempted: true, artifactSha256: artifact.sha256
  } });
  requireState(verification && typeof verification.storeBuildId === "string" && verification.storeBuildId.length > 0,
    "internal store verification did not return a store build identity");
  verifiedStoreBuildId = verification.storeBuildId;
  const compatibility = await (dependencies.compatibilityVerifier ?? verifyUploadCompatibility)({ request, env, release });
  requireState(compatibility?.status === "supported" || compatibility?.status === "recommended",
    "candidate is not compatible with the live server");
  if ((compatibility.serverReleaseSha ?? compatibility.serverSha) !== request.current_server_sha) {
    throw new Error("live compatibility proof changed its server identity");
  }
  const receiptUrl = release.receiptUrl ?? runReceiptUrl(env);
  registryCall(request, env, "transition", ["--reservation-id", release.reservationId,
    "--patch", JSON.stringify({ uploaded: true, processed: true, internal: true,
      compatibilityProtected: true, artifactSha256: artifact.sha256, storeBuildId: verifiedStoreBuildId,
      receiptUrl, availabilityPending: null, serverCompatibility: release.serverCompatibility ?? compatibility })], dependencies);
  const updated = registryCall(request, env, "inspect", ["--release-id", request.release_id], dependencies)
    .reservations?.[request.platform];
  assertReservation(request, updated);
  const candidate = controllerCandidate(request, updated);
  const snapshot = { internal_verified: internalEvidence(request, updated, artifact.sha256) };
  const resultAction = request.result_action ?? request.action;
  const mutation = request.action === "reconcile" ? { mutation_status: "confirmed" } : {};
  return storeResult(request, "ok", snapshot, emptyProduction(), null, candidate, now,
    mutation, resultAction);
}

async function handleUploadReconcile(request, env, now, dependencies) {
  const releaseInfo = registryCall(request, env, "inspect", ["--release-id", request.release_id], dependencies);
  const release = releaseInfo.reservations?.[request.platform];
  assertReservation(request, release);
  const artifact = signedArtifact(request);
  if (release.artifactSha256) requireState(release.artifactSha256 === artifact.sha256,
    "registry artifact identity changed after signing");
  if (release.availabilityPending) assertAvailabilityPending(request, release,
    release.availabilityPending, artifact.sha256);
  if (!release.uploadAttempted) {
    return storeResult(request, "ok",
      { internal_verified: { platform: request.platform, artifact_sha256: artifact.sha256,
        status: "not_attempted" } }, emptyProduction(), null, null, now,
      { mutation_status: "not_mutated" }, "reconcile");
  }
  return handleUpload({ ...request, result_action: "reconcile" }, env, now, dependencies);
}

async function handlePrepareReconcile(request, env, now, dependencies) {
  const releaseInfo = registryCall(request, env, "inspect", ["--release-id", request.release_id], dependencies);
  const release = releaseInfo.reservations?.[request.platform];
  assertReservation(request, release);
  const status = registryCall(request, env, "production-status", ["--platform", request.platform], dependencies).production ??
    emptyProduction();
  const prepared = status.candidate ?? null;
  const snapshot = { internal_verified: { platform: request.platform,
    marketing_version: request.candidate.marketing_version, build: Number(request.candidate.build),
    store_build_id: String(request.candidate.store_build_id), artifact_sha256: request.candidate.artifact_sha256,
    status: "verified" } };
  if (!prepared) {
    return storeResult(request, "ok", { preparation: { status: "not_prepared" }, ...snapshot }, status,
      null, null, now, { mutation_status: "not_mutated" }, "reconcile");
  }
  requireState(sameJson(coordinatedCandidateIdentity(prepared), coordinatedCandidateIdentity(request.candidate)),
    "prepared production candidate changed during prepare recovery");
  return storeResult(request, "ok", { preparation: { status: "prepared",
    candidate_fingerprint: productionCandidateFingerprint(prepared) }, ...snapshot }, status, null,
    controllerCandidate(request, prepared), now, { mutation_status: "confirmed" }, "reconcile");
}

async function handleDailyPrepare(request, env, now, dependencies) {
  const releaseInfo = registryCall(request, env, "inspect", ["--release-id", request.release_id], dependencies);
  const release = releaseInfo.reservations?.[request.platform];
  assertReservation(request, release);
  requireState(String(release.storeBuildId ?? "").length > 0,
    "daily tester preparation requires the verified store build identity");
  const destination = normalizeTesterDestination(request.platform, request.candidate.tester_destination);
  const candidate = controllerCandidate(request, release);
  const snapshot = { internal_verified: internalEvidence(request, release, request.candidate.artifact_sha256),
    tester_destination: destination };
  const operation = { operationId: request.attempt_id, action: "prepare", status: "succeeded",
    candidate, receipt: { observed: { authoritative: true, matched: true, terminal: true } } };
  const mutation = request.action === "reconcile" ? { mutation_status: "confirmed" } : {};
  return storeResult(request, "ok", snapshot, emptyProduction(), operation, candidate, now, mutation,
    request.action === "reconcile" ? "reconcile" : "prepare");
}

async function handleDailySubmit(request, env, now, dependencies) {
  const releaseInfo = registryCall(request, env, "inspect", ["--release-id", request.release_id], dependencies);
  const release = releaseInfo.reservations?.[request.platform];
  assertReservation(request, release);
  requireState(String(release.storeBuildId ?? "").length > 0,
    "daily tester submit requires the verified store build identity");
  const destination = normalizeTesterDestination(request.platform, request.candidate.tester_destination);
  const verification = await (dependencies.dailyVerifier ?? verifyDailyTesterStoreAdapter)({
    request, env, release: {
    ...release, uploadAttempted: true, artifactSha256: request.candidate.artifact_sha256
    }, destination, options: { allowMutations: false, activate: false,
      allowReviewSubmission: destination.group_type === "external" } });
  const candidate = controllerCandidate(request, release);
  const snapshot = {
    internal_verified: internalEvidence(request, release, request.candidate.artifact_sha256),
    ...(verification.snapshot ?? {}),
    ...(verification.observation ? { tester: verification.observation } : {}), tester_destination: destination
  };
  const operation = { operationId: request.attempt_id, action: "submit",
    status: verification.pending ? "pending" : "succeeded", candidate,
    receipt: { observed: { authoritative: true, matched: !verification.pending,
      terminal: !verification.pending, partial: verification.pending } } };
  if (verification.actionRequired) return storeResult(request, "ACTION_REQUIRED", snapshot,
    emptyProduction(), operation, candidate, now,
    { code: "ACTION_REQUIRED_TESTER_REVIEW", reason: verification.actionRequired,
      mutation_status: "not_mutated" }, request.action === "reconcile" ? "reconcile" : "submit");
  if (verification.pending) return storeResult(request, "pending", snapshot, emptyProduction(), operation,
    candidate, now, {}, request.action === "reconcile" ? "reconcile" : "submit");
  const mutation = request.action === "reconcile" ? { mutation_status: "not_mutated" } : {};
  return storeResult(request, "ok", snapshot, emptyProduction(), operation, candidate, now, mutation,
    request.action === "reconcile" ? "reconcile" : "submit");
}

async function handleDailyActivate(request, env, now, dependencies) {
  const identity = coordinatedCandidateIdentity(request.candidate);
  assertAuthenticatedReleaseAuthorization(request, identity);
  const releaseInfo = registryCall(request, env, "inspect", ["--release-id", request.release_id], dependencies);
  const release = releaseInfo.reservations?.[request.platform];
  assertReservation(request, release);
  requireState(String(release.storeBuildId ?? "") === String(request.candidate.store_build_id),
    "daily tester activation store build identity changed");
  const destination = normalizeTesterDestination(request.platform, request.candidate.tester_destination);
  const verification = await (dependencies.dailyVerifier ?? verifyDailyTesterStoreAdapter)({
    request, env, release: { ...release, uploadAttempted: true,
      artifactSha256: request.candidate.artifact_sha256 }, destination,
    options: { allowMutations: true, activate: true }
  });
  const candidate = controllerCandidate(request, release);
  const snapshot = { internal_verified: internalEvidence(request, release, request.candidate.artifact_sha256),
    ...(verification.snapshot ?? {}),
    ...(verification.observation ? { tester: verification.observation } : {}), tester_destination: destination };
  const operation = { operationId: request.attempt_id, action: "release",
    status: verification.pending ? "pending" : "succeeded", candidate,
    receipt: { observed: { authoritative: true, matched: !verification.pending,
      terminal: !verification.pending, partial: verification.pending } } };
  if (verification.actionRequired) return storeResult(request, "ACTION_REQUIRED", snapshot,
    emptyProduction(), operation, candidate, now,
    { code: "ACTION_REQUIRED_TESTER_REVIEW", reason: verification.actionRequired,
      mutation_status: "unknown" }, request.action === "reconcile" ? "reconcile" : "release");
  if (verification.pending) return storeResult(request, "pending", snapshot, emptyProduction(), operation,
    candidate, now, {}, request.action === "reconcile" ? "reconcile" : "release");
  return storeResult(request, "ok", snapshot, emptyProduction(), operation, candidate, now,
    { mutation_status: "confirmed" }, request.action === "reconcile" ? "reconcile" : "release");
}

async function verifyDailyTesterStoreAdapter({ request, env, release, destination, options }) {
  const clients = await createClients({ mutable: options.allowMutations === true || options.allowReviewSubmission === true, env,
    platforms: [request.platform] });
  return verifyDailyTesterStore(clients, release, destination, options);
}

async function verifyDailyUploadedArtifact({ request, env, release }) {
  const destination = normalizeTesterDestination(request.platform, request.candidate.tester_destination);
  return verifyDailyTesterStoreAdapter({ request, env, release, destination,
    options: { allowMutations: false, activate: false } });
}

async function handleProductionAction(request, env, now, dependencies) {
  const attemptId = request.attempt_id;
  const action = request.action === "reconcile" ? "reconcile" : request.action;
  const release = registryCall(request, env, "inspect", ["--release-id", request.release_id], dependencies)
    .reservations?.[request.platform];
  assertReservation(request, release);
  requireState(String(release.storeBuildId ?? release.store_build_id ?? "") ===
    String(request.candidate.store_build_id),
  "registry store build identity is not bound to the requested production action");
  const productionStatus = registryCall(request, env, "production-status", ["--platform", request.platform], dependencies).production;
  const productionCandidate = productionStatus?.candidate ?? null;
  const productionAction = reconcileTargetAction(request);
  if (productionAction !== "prepare") {
    requireState(productionCandidate, `${ACTION_REQUIRED}: prepared production candidate is unavailable`);
    const requestIdentity = coordinatedCandidateIdentity(request.candidate);
    requireState(sameJson(coordinatedCandidateIdentity(productionCandidate), requestIdentity),
      "prepared production candidate changed its coordinated identity");
  }
  const approval = requiresProductionApproval(request)
    ? deriveProductionApproval(request, productionCandidate)
    : null;
  const actionEnv = productionEnvironment(request, env, action, attemptId, productionCandidate, approval);
  const run = dependencies.productionRunner ?? runProductionCli;
  const output = await run({ request, action, env: actionEnv, toolingRoot: request.tooling_root,
    commandRunner: dependencies.commandRunner });
  const status = registryCall(request, env, "production-status", ["--platform", request.platform], dependencies).production;
  const operation = (status?.operations ?? []).find((entry) => entry.operationId === attemptId) ??
    [...(status?.operations ?? [])].reverse().find((entry) => entry.candidate?.operationId === request.child_operation_id) ?? null;
  const inspect = dependencies.snapshotRunner
    ? await dependencies.snapshotRunner({ request, env, actionEnv, output })
    : await runProductionInspect({ request, env: actionEnv, toolingRoot: request.tooling_root, commandRunner: dependencies.commandRunner });
  const candidate = status?.candidate ? controllerCandidate(request, status.candidate) : controllerCandidate(request,
    registryCall(request, env, "inspect", ["--release-id", request.release_id], dependencies).reservations?.[request.platform]);
  const mutationStatus = request.action === "reconcile" ? reconciliationMutationStatus(output, request.platform, operation) : undefined;
  const resultStatus = operation && ["pending", "uncertain"].includes(operation.status) ? "pending" : "ok";
  return storeResult(request, resultStatus, inspect, status, operation, candidate, now,
    mutationStatus ? { mutation_status: mutationStatus } : {});
}

async function verifyInternalArtifact({ request, env, release }) {
  const clients = await createClients({ mutable: false, env, platforms: [request.platform] });
  const group = env.ASH_ATLAS_TESTFLIGHT_INTERNAL_GROUP;
  const storeBuildId = await verifyInternalStore(clients, release, group);
  return { storeBuildId };
}

async function verifyUploadCompatibility({ request, env, release }) {
  return verifyLiveServerCompatibility({
    serverUrl: env.MOBILE_COMPATIBILITY_SERVER_URL,
    platform: request.platform, version: release.marketingVersion, build: release.build,
    sourceSha: request.source_sha, protocolMin: release.protocol.min, protocolMax: release.protocol.max,
    expectedReleaseSha: request.current_server_sha
  });
}

async function runProductionCli({ action, env, toolingRoot, commandRunner }) {
  const script = join(toolingRoot, "tools", "mobile-release", "production.mjs");
  const output = commandRunner(process.execPath, [script, action], {
    cwd: toolingRoot, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
  });
  return parseCommandJson(output, "production adapter");
}

async function runProductionInspect({ request, env, toolingRoot, commandRunner }) {
  const output = commandRunner(process.execPath, [join(toolingRoot, "tools", "mobile-release", "production.mjs"), "inspect"], {
    cwd: toolingRoot, env: { ...env, DRY_RUN: "true" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
  });
  const parsed = parseCommandJson(output, "production inspection");
  return parsed.snapshots?.[request.platform] ?? parsed.snapshot;
}

function registryCall(request, env, command, commandArgs, dependencies) {
  if (dependencies.registryRunner) return dependencies.registryRunner({ request, env, command, args: commandArgs });
  const script = join(request.tooling_root, "tools", "mobile-release", "registry-remote.mjs");
  const args = [script, command];
  if (request.registry_file) args.push("--file", request.registry_file);
  else {
    args.push("--remote", request.registry_remote, "--branch", request.registry_branch);
    if (request.registry_seed) args.push("--seed", request.registry_seed);
  }
  const output = dependencies.commandRunner(process.execPath, [...args, ...commandArgs], {
    cwd: request.tooling_root, env: scopedEnvironment({ env, names: TRUSTED_ENV_NAMES }),
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
  });
  return parseCommandJson(output, "registry adapter");
}

function signedArtifact(request) {
  const manifest = JSON.parse(readFileSync(resolve(request.signed_manifest_path), "utf8"));
  requireState(manifest.schema_version === 1 && manifest.operation_id === request.coordinated_operation_id &&
    manifest.source_sha === request.source_sha && Array.isArray(manifest.artifacts),
  "signed artifact manifest is not bound to this operation");
  requireState(SHA256.test(String(request.signed_manifest_sha256)) &&
    manifest.manifest_sha256 === request.signed_manifest_sha256,
  "signed artifact manifest fingerprint changed");
  const entry = manifest.artifacts.find((artifact) => artifact.platform === request.platform);
  requireState(entry, `signed ${request.platform} artifact is missing`);
  const path = quarantineFile(entry.signed_path, manifest.signed_quarantine_root, `${request.platform} signed artifact`,
    [request.source_repository_root, request.tooling_root]);
  const sha256 = artifactSha256(path);
  requireState(sha256 === entry.sha256 && sha256 === request.candidate.artifact_sha256,
    "signed artifact bytes do not match the reserved candidate");
  return { path, sha256 };
}

function assertReservation(request, release) {
  requireState(release && release.platform === request.platform && release.releaseId === request.release_id &&
    release.sourceSha === request.source_sha && release.generation === request.generation &&
    release.marketingVersion === request.candidate.marketing_version &&
    Number(release.build) === Number(request.candidate.build),
  "registry reservation is not bound to the exact trusted store request");
  const requestedStoreBuildId = request.candidate.store_build_id ?? request.candidate.storeBuildId;
  if (requestedStoreBuildId !== undefined && requestedStoreBuildId !== null &&
    String(requestedStoreBuildId).length > 0) {
    requireState(String(release.storeBuildId ?? release.store_build_id ?? "") === String(requestedStoreBuildId),
      "registry store build identity changed during upload recovery");
  }
}

function assertAvailabilityPending(request, release, pending, artifactSha256Value) {
  requireState(pending.schemaVersion === 1 && pending.reservationId === release.reservationId &&
    pending.releaseId === request.release_id && pending.platform === request.platform &&
    pending.sourceSha === request.source_sha && pending.marketingVersion === request.candidate.marketing_version &&
    Number(pending.build) === Number(request.candidate.build) &&
    pending.protocol?.min === request.protocol?.min && pending.protocol?.max === request.protocol?.max &&
    pending.artifactSha256 === artifactSha256Value,
  `${ACTION_REQUIRED}: internal upload outcome is unresolved; reconcile the exact availability marker`);
}

function controllerCandidate(request, releaseOrCandidate) {
  const value = releaseOrCandidate;
  requireState(value && typeof value === "object", "trusted store candidate is unavailable");
  return {
    schema_version: 1,
    operation_id: request.child_operation_id,
    platform: request.platform,
    release_id: request.release_id,
    source_sha: request.source_sha,
    generation: request.generation,
    marketing_version: request.candidate.marketing_version,
    build: Number(request.candidate.build),
    store_build_id: String(value.storeBuildId ?? value.store_build_id ?? request.candidate.store_build_id ?? ""),
    artifact_sha256: String(value.artifactSha256 ?? value.artifact_sha256 ?? request.candidate.artifact_sha256),
    tooling_sha: request.tooling_sha,
    metadata_sha256: request.candidate.metadata_sha256,
    metadata_packet_path: request.candidate.metadata_packet_path,
    countries: [...(request.candidate.countries ?? [])].map(String).sort(),
    rollout: structuredClone(request.candidate.rollout),
    ...(request.candidate.tester_destination ? {
      tester_destination: normalizeTesterDestination(request.platform, request.candidate.tester_destination)
    } : {}),
    managedPublishing: request.candidate.managed_publishing,
    firstPublicationBootstrapVerified: request.candidate.first_publication_bootstrap_verified,
    firstLaunch: request.candidate.rollout.kind === "first-publish"
  };
}

function storeResult(request, status, snapshot, production, operation, candidate, now, extra = {}, resultAction = request.action) {
  return { schema_version: 1, kind: "ash-atlas-coordinated-store-step-result", status,
    coordinated_operation_id: request.coordinated_operation_id, platform: request.platform,
    action: resultAction, candidate, snapshot: snapshot ?? {}, production: production ?? emptyProduction(),
    operation, observed_at_utc: now, ...extra };
}

function internalEvidence(request, release, artifactSha256Value) {
  return { platform: request.platform, marketing_version: release.marketingVersion, build: Number(release.build),
    store_build_id: String(release.storeBuildId), artifact_sha256: artifactSha256Value, status: "verified" };
}

function emptyProduction() {
  return { schemaVersion: 1, platforms: {
    ios: { baseline: null, candidate: null, phase: "idle", history: [] },
    android: { baseline: null, candidate: null, phase: "idle", history: [] }
  }, operations: [], cancellations: [] };
}

function reconciliationMutationStatus(output, platform, operation) {
  const observed = output?.platforms?.[platform]?.observed ??
    output?.observed ?? operation?.receipt?.observed;
  if (observed?.matched === true && observed?.terminal === true && observed?.authoritative === true) return "confirmed";
  if (observed?.noMutation === true && observed?.authoritative === true) return "not_mutated";
  return "unknown";
}

function actionRequired(error, request, now) {
  const message = String(error?.message ?? "trusted store action requires operator action");
  const prefix = [SAFE_ACTION_REQUIRED, GOOGLE_ACTION_REQUIRED, ACTION_REQUIRED].find((value) => message.startsWith(value));
  const code = prefix ?? ACTION_REQUIRED;
  const reason = prefix
    ? message.slice(0, 1000) : `${ACTION_REQUIRED}: trusted store action remains unresolved; reconcile before retrying`;
  return { schema_version: 1, kind: "ash-atlas-coordinated-store-step-result", status: "ACTION_REQUIRED",
    code, coordinated_operation_id: request?.coordinated_operation_id ?? null,
    platform: request?.platform ?? null, action: request?.action ?? null, reason,
    mutation_status: "unknown", observed_at_utc: now };
}

export function parseCommandJson(value, label) {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value ?? "");
  const trimmed = text.trim();
  requireState(trimmed, `${label} returned no JSON`);
  const lines = trimmed.split(/\r?\n/u);
  for (let start = 0; start < lines.length; start += 1) {
    try { return JSON.parse(lines.slice(start).join("\n")); } catch { /* try the next possible JSON start */ }
  }
  throw new Error(`${label} returned invalid JSON`);
}

function defaultCommandRunner(command, args, options) {
  return execFileSync(command, args, options);
}

function runReceiptUrl(env) {
  const server = env.GITHUB_SERVER_URL ?? "https://github.com";
  const repository = env.GITHUB_REPOSITORY ?? "local/ash-atlas";
  const runId = env.GITHUB_RUN_ID ?? "1";
  requireState(/^https:\/\/[A-Za-z0-9.-]+$/u.test(server) && REGISTRY_REMOTE.test(repository) && /^[0-9]+$/u.test(String(runId)),
    "trusted store receipt URL identity is invalid");
  return `${server}/${repository}/actions/runs/${runId}`;
}

function isDescendant(candidate, root) {
  const child = relative(resolve(root), resolve(candidate));
  return child !== "" && child !== ".." && !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(child);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requireState(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const requestPath = required(args, "request");
  const outputPath = required(args, "output");
  const request = JSON.parse(readFileSync(resolve(requestPath), "utf8"));
  const result = await runTrustedStoreAdapter({ request });
  writeJsonAtomic(resolve(outputPath), result);
  process.stdout.write(`${JSON.stringify({ status: result.status, action: request.action,
    coordinated_operation_id: request.coordinated_operation_id })}\n`);
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    requireState(value.startsWith("--"), `unexpected argument ${value}`);
    const next = values[index + 1];
    requireState(next !== undefined && !next.startsWith("--"), `${value} requires a value`);
    result[value.slice(2)] = next;
    index += 1;
  }
  return result;
}

function required(args, name) {
  requireState(typeof args[name] === "string" && args[name].length > 0, `--${name} is required`);
  return args[name];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(() => { console.error(`${ACTION_REQUIRED}: trusted store adapter failed`); process.exitCode = 1; });
}
