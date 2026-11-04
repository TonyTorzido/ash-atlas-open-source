import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ACTION_REQUIRED_PROVISION_ISOLATED_BUILD,
  assertBuildIdentity,
  assertOutsideRoots,
  executeExternalProvider,
  readJson,
  requireProvisionedBuildBoundary,
  scopedEnvironment,
  writeJsonAtomic
} from "./coordinated-build-boundary.mjs";
import { buildUnsignedRequest, runUnsignedBuild } from "./coordinated-unsigned-build.mjs";
import {
  runTrustedSigning,
  validateSignedArtifactResult,
  validateUnsignedManifest
} from "./coordinated-sign-artifacts.mjs";
import {
  buildCoordinatedChildReceipt,
  coordinatedCandidateIdentity,
  coordinatedChildOperationId,
  coordinatedApprovalFingerprint,
  verifyAuthenticatedCoordinatedServerEvidence
} from "./coordinated-receipts.mjs";
import { buildCoordinatedReleaseSeed, writeCoordinatedBootstrapArtifacts } from "./coordinated-bootstrap.mjs";
import { validateBootstrapPlan, releaseIdForOperation } from "./coordinated-mobile-bootstrap-provider.mjs";
import { operationHandoffRoot as buildOperationHandoffRoot } from "./coordinated-mobile-plan.mjs";
import { preflightMacIsolatedBuild } from "./coordinated-mac-isolated-build-supervisor.mjs";
import {
  DAILY_TESTER_MODE,
  readTesterDeliveryMode,
  readTesterDestination
} from "./coordinated-mobile-testers.mjs";

const PLATFORMS = ["ios", "android"];
const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const GENERATION = /^t\d{3,4}$/u;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const STORE_STEPS = ["upload", "prepare", "submit", "reconcile"];
const RELEASE_STEPS = ["release", "reconcile"];
const ACTION_REQUIRED_PERSISTED_ARTIFACT = "ACTION_REQUIRED_PERSISTED_ARTIFACT";
const ACTION_REQUIRED_TRUSTED_STORE = "ACTION_REQUIRED_PROVISION_TRUSTED_STORE";
const TRUSTED_STORE_ENV_NAMES = [
  "PATH", "HOME", "TMPDIR", "RUNNER_TEMP", "CI", "GITHUB_ACTIONS", "GITHUB_RUN_ID",
  "GITHUB_SERVER_URL", "GITHUB_ACTOR", "ASH_ATLAS_REGISTRY_TOKEN", "GITHUB_REPOSITORY",
  "APP_STORE_CONNECT_KEY_ID", "APP_STORE_CONNECT_ISSUER_ID", "APP_STORE_CONNECT_KEY_P8_BASE64",
  "APP_STORE_CONNECT_PRODUCTION_KEY_ID", "APP_STORE_CONNECT_PRODUCTION_ISSUER_ID",
  "APP_STORE_CONNECT_PRODUCTION_KEY_P8_BASE64", "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64",
  "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON", "GOOGLE_PLAY_PRODUCTION_SERVICE_ACCOUNT_JSON_BASE64",
  "GOOGLE_PLAY_PACKAGE_NAME", "ASH_ATLAS_TESTFLIGHT_INTERNAL_GROUP", "ASH_ATLAS_IOS_BUNDLE_ID",
  "ASH_ATLAS_ANDROID_PACKAGE", "ASH_ATLAS_BETA_NOTES", "ASH_ATLAS_PRODUCTION_MUTATION",
  "COORDINATED_FASTLANE_ROOT", "COORDINATED_BUNDLE_EXECUTABLE",
  "COORDINATED_PRODUCTION_RELEASE_APPROVAL_SHA256", "GOOGLE_PLAY_MANAGED_PUBLISHING_ATTESTATION_PATH",
  "MOBILE_COMPATIBILITY_SERVER_URL",
  "PRODUCTION_TOOL_SHA"
];
const BUILT_IN_TRUSTED_STORE_ADAPTER = join("tools", "mobile-release", "coordinated-trusted-store-adapter.mjs");

/**
 * Trusted private-control orchestration.  The source mirror is data only:
 * unsigned building, signing, and store work are delegated to explicitly
 * provisioned executables outside both checkouts.  Every external mutation
 * has a durable pending record before the process is launched.
 */
export function runCoordinatedControl(options) {
  const request = normalizeRequest(options);
  const state = loadOrCreateState(request);
  const actions = [];
  try {
    proveImmutableCheckouts(request);
    if (!request.unsignedRunner && !request.signerRunner) {
      requireProvisionedBuildBoundary({ env: request.env, operationId: request.operationId,
        generation: request.generation, sourceSha: request.serverSha,
        sourceRepositoryRoot: request.sourceRepositoryRoot, toolingRoot: request.toolingRoot,
        registryRemote: request.registryRemote });
      preflightMacIsolatedBuild({ env: request.env, sourceRepositoryRoot: request.sourceRepositoryRoot,
        toolingRoot: request.toolingRoot, handoffRoot: request.handoffRoot,
        builder: request.env.COORDINATED_ISOLATED_BUILDER });
    }
    if (!request.storeProviderRunner) {
      requireState(typeof request.trustedStoreProvider === "string" &&
        isAbsolute(request.trustedStoreProvider) && existsSync(request.trustedStoreProvider),
      `${ACTION_REQUIRED_TRUSTED_STORE}: a private trusted store adapter is required before reservation`);
    }
    ensureReservation(request, state);
    ensureUnsigned(request, state);
    ensureSigned(request, state);
    retryPendingRegistryReceipt(request, state);
    clearStaleActionRequired(request, state);

    if (request.action === "post-health") {
      for (const platform of PLATFORMS) {
        requireState(state.platforms[platform].receipt?.public_available !== true || state.server_evidence?.published === true,
          `${ACTION_REQUIRED_TRUSTED_STORE}: ${platform} became publicly available before authenticated server health`);
      }
      applyServerEvidence(request, state);
      for (const platform of PLATFORMS) {
        processPlatform(request, state, platform, RELEASE_STEPS, actions);
      }
    } else {
      for (const platform of PLATFORMS) {
        processPlatform(request, state, platform, STORE_STEPS, actions);
      }
    }

    const result = finalizeResult(request, state, actions);
    writeState(request, state);
    return result;
  } catch (error) {
    state.status = "ACTION_REQUIRED";
    state.action_required = {
      code: error.code ?? ACTION_REQUIRED_TRUSTED_STORE,
      reason: safeReason(error),
      observed_at_utc: request.now
    };
    writeState(request, state);
    return finalizeResult(request, state, actions);
  }
}

export function validateStoreStepResult(result, request, platform, action, expected) {
  requireState(result && result.schema_version === 1 &&
    result.kind === "ash-atlas-coordinated-store-step-result",
  "trusted store result schema is invalid");
  requireState(result.status === "ok" || result.status === "pending" ||
    result.status === "ACTION_REQUIRED", "trusted store result status is invalid");
  requireState(result.coordinated_operation_id === request.operationId &&
    result.platform === platform && result.action === action,
  "trusted store result is not bound to the requested step");
  if (result.status === "ACTION_REQUIRED") return result;
  if (result.mutation_status === "not_mutated" && !result.candidate) {
    requireState(result.snapshot && typeof result.snapshot === "object",
      "trusted store no-mutation result is missing its snapshot");
    requireState(result.production && typeof result.production === "object",
      "trusted store no-mutation result is missing production journal state");
    return result;
  }
  requireState(result.candidate && typeof result.candidate === "object",
    "trusted store result is missing its candidate identity");
  const identity = coordinatedCandidateIdentity(result.candidate);
  requireState(identity.platform === platform && identity.source_sha === request.serverSha &&
    identity.generation === request.generation &&
    identity.release_id === expected.release_id &&
    identity.marketing_version === expected.marketing_version &&
    identity.build === expected.build &&
    identity.artifact_sha256 === expected.artifact_sha256 &&
    identity.tooling_sha === request.toolingSha &&
    identity.metadata_sha256 === expected.metadata_sha256 &&
    sameJson(identity.countries, expected.countries) &&
    sameJson(identity.rollout, expected.rollout) &&
    sameJson(identity.tester_destination ?? null, expected.tester_destination ?? null),
  "trusted store candidate changed its immutable identity");
  const expectedStoreBuildId = expected.store_build_id ?? expected.storeBuildId;
  if (expectedStoreBuildId !== undefined && expectedStoreBuildId !== null &&
    String(expectedStoreBuildId).length > 0) {
    requireState(identity.store_build_id === String(expectedStoreBuildId),
      "trusted store build identity changed after internal verification");
  }
  requireState(result.candidate.operationId === coordinatedChildOperationId(request.operationId, platform) ||
    result.candidate.operation_id === coordinatedChildOperationId(request.operationId, platform),
  "trusted store candidate operation ID is not bound to the child");
  requireState(result.snapshot && typeof result.snapshot === "object",
    "trusted store result is missing authoritative store snapshot");
  requireState(result.production && typeof result.production === "object",
    "trusted store result is missing production journal state");
  return { ...result, identity };
}

export function buildTrustedStoreRequest(request, state, platform, action, attemptId) {
  const platformState = state.platforms[platform];
  const reservation = state.reservation.reservations[platform];
  const artifact = state.signed.artifacts.find((entry) => entry.platform === platform);
  const policy = request.candidatePlan[platform];
  const priorStoreBuildId = platformState?.candidate?.store_build_id ??
    platformState?.candidate?.storeBuildId ?? reservation.storeBuildId;
  requireState(reservation.marketingVersion === policy.marketing_version,
    `${platform} reservation marketing version does not match the candidate plan`);
  return {
    schema_version: 1,
    kind: "ash-atlas-coordinated-store-step-request",
    platform,
    action,
    attempt_id: attemptId,
    coordinated_operation_id: request.operationId,
    child_operation_id: coordinatedChildOperationId(request.operationId, platform),
    generation: request.generation,
    source_sha: request.serverSha,
    accepted_master_sha: request.acceptedMasterSha,
    current_server_sha: request.currentServerSha,
    tooling_sha: request.toolingSha,
    protocol: structuredClone(request.protocol),
    registry_remote: request.registryRemote,
    registry_branch: request.registryBranch,
    registry_file: request.registryFile,
    registry_seed: request.registrySeed,
    delivery_mode: request.deliveryMode,
    source_repository_root: request.sourceRepositoryRoot,
    tooling_root: request.toolingRoot,
    handoff_root: request.handoffRoot,
    release_id: state.release_id,
    reservation: {
      reservation_id: reservation.reservationId,
      build: reservation.build,
      marketing_version: reservation.marketingVersion
    },
    candidate: {
      operation_id: coordinatedChildOperationId(request.operationId, platform),
      platform,
      release_id: state.release_id,
      source_sha: request.serverSha,
      generation: request.generation,
      marketing_version: policy.marketing_version,
      build: reservation.build,
      artifact_sha256: artifact.sha256,
      tooling_sha: request.toolingSha,
      metadata_sha256: policy.metadata_sha256,
      ...(priorStoreBuildId ? { store_build_id: String(priorStoreBuildId) } : {}),
      ...(policy.metadata_packet_path ? { metadata_packet_path: policy.metadata_packet_path } : {}),
      countries: [...policy.countries],
      rollout: structuredClone(policy.rollout),
      ...(policy.tester_destination ? { tester_destination: structuredClone(policy.tester_destination) } : {}),
      ...(policy.managed_publishing !== undefined ? { managed_publishing: policy.managed_publishing } : {}),
      ...(policy.first_publication_bootstrap_verified !== undefined
        ? { first_publication_bootstrap_verified: policy.first_publication_bootstrap_verified } : {})
    },
    signed_manifest_path: state.signed.path,
    signed_manifest_sha256: state.signed.manifest_sha256,
    previous_platform_state: platformState ? safePlatformState(platformState) : null,
    server_evidence: state.server_evidence ?? null
  };
}

function normalizeRequest(options = {}) {
  const request = {
    action: options.action ?? "start",
    operationId: String(options.operationId ?? ""),
    generation: String(options.generation ?? ""),
    serverSha: String(options.serverSha ?? "").toLowerCase(),
    acceptedMasterSha: String(options.acceptedMasterSha ?? "").toLowerCase(),
    currentServerSha: String(options.currentServerSha ?? "").toLowerCase(),
    toolingSha: String(options.toolingSha ?? "").toLowerCase(),
    sourceRepositoryRoot: resolve(String(options.sourceRepositoryRoot ?? "")),
    toolingRoot: resolve(String(options.toolingRoot ?? "")),
    registryRemote: String(options.registryRemote ?? ""),
    registryBranch: String(options.registryBranch ?? "mobile-release-state"),
    registryFile: options.registryFile ? resolve(String(options.registryFile)) : null,
    registrySeed: options.registrySeed ? resolve(String(options.registrySeed)) : null,
    handoffRoot: resolve(String(options.handoffRoot ?? "")),
    statePath: resolve(String(options.statePath ?? "")),
    seedPath: options.seedPath ? resolve(String(options.seedPath)) : null,
    receiptPath: options.receiptPath ? resolve(String(options.receiptPath)) : null,
    plan: options.plan ?? null,
    reservedVersions: options.reservedVersions ?? null,
    protocol: options.protocol ?? { min: 3, max: 3 },
    sourceManifest: options.sourceManifest ?? null,
    trustedStoreProvider: options.trustedStoreProvider ?? process.env.COORDINATED_TRUSTED_STORE_PROVIDER,
    env: options.env ?? process.env,
    serverEvidence: options.serverEvidence ?? null,
    serverEvidencePath: options.serverEvidencePath ? resolve(String(options.serverEvidencePath)) : null,
    now: options.now ?? new Date().toISOString(),
    gitRunner: options.gitRunner ?? git,
    registryRunner: options.registryRunner ?? registryCommand,
    unsignedRunner: options.unsignedRunner ?? null,
    signerRunner: options.signerRunner ?? null,
    storeProviderRunner: options.storeProviderRunner ?? null
  };
  requireState(["start", "resume", "post-health"].includes(request.action),
    "coordinated control action must be start, resume, or post-health");
  requireState(OPERATION_ID.test(request.operationId), "coordinated operation ID is invalid");
  requireState(GENERATION.test(request.generation), "coordinated generation is invalid");
  for (const [label, value] of [["server SHA", request.serverSha], ["accepted master SHA", request.acceptedMasterSha],
    ["current server SHA", request.currentServerSha], ["tooling SHA", request.toolingSha]]) {
    requireState(SHA.test(value), `${label} is invalid`);
  }
  assertBuildIdentity({ operationId: request.operationId, generation: request.generation,
    sourceSha: request.serverSha, sourceRepositoryRoot: request.sourceRepositoryRoot,
    toolingRoot: request.toolingRoot, registryRemote: request.registryRemote });
  requireState(isAbsolute(request.handoffRoot) && isAbsolute(request.statePath),
    "durable control roots must be absolute");
  assertOutsideRoots(request.handoffRoot, [request.sourceRepositoryRoot, request.toolingRoot],
    "durable handoff root");
  assertOutsideRoots(request.statePath, [request.sourceRepositoryRoot, request.toolingRoot],
    "durable state path");
  requireState(Number.isFinite(Date.parse(request.now)), "control timestamp is invalid");
  requireState(request.reservedVersions && typeof request.reservedVersions === "object" &&
    !Array.isArray(request.reservedVersions), "reserved versions are required");
  requireState(request.plan && request.plan.apps && typeof request.plan.apps === "object",
    "validated mobile candidate plan is required");
  const deliveryMode = readTesterDeliveryMode(request.plan);
  requireState(deliveryMode === null || deliveryMode === DAILY_TESTER_MODE,
    "coordinated mobile delivery mode is unsupported");
  request.deliveryMode = deliveryMode;
  if (request.plan.pinned?.registry_remote !== undefined) {
    requireState(request.plan.pinned.registry_remote === request.registryRemote,
      "candidate plan registry remote does not match the controller");
  }
  request.candidatePlan = normalizeCandidatePlan(request.plan, deliveryMode);
  return request;
}

function normalizeCandidatePlan(plan, deliveryMode = null) {
  const apps = plan.apps;
  const result = {};
  for (const platform of PLATFORMS) {
    const app = apps[platform];
    requireState(app && typeof app === "object", `${platform} candidate plan is missing`);
    const marketingVersion = String(app.marketing_version ?? app.marketingVersion ?? "");
    const metadataHash = String(app.metadata_sha256 ?? app.metadataHash ?? "").toLowerCase();
    const countries = [...(app.countries ?? [])].map((entry) => String(entry)).sort();
    requireState(VERSION.test(marketingVersion) && SHA256.test(metadataHash),
      `${platform} candidate plan identity is invalid`);
    requireState(countries.every((country) => /^[A-Z]{2}$/u.test(country)) &&
      new Set(countries).size === countries.length, `${platform} candidate countries are invalid`);
    requireState(app.rollout && typeof app.rollout === "object",
      `${platform} candidate rollout is missing`);
    const metadataPacketPath = app.metadata_packet_path ?? app.metadataPacketPath;
    const testerDestination = readTesterDestination(platform, app, ["tester_destination", "testerDestination"]);
    if (deliveryMode === DAILY_TESTER_MODE) requireState(testerDestination,
      `${platform} daily tester destination is required`);
    else requireState(!testerDestination,
      `${platform} tester destination requires daily tester delivery mode`);
    result[platform] = {
      marketing_version: marketingVersion,
      metadata_sha256: metadataHash,
      ...(metadataPacketPath ? { metadata_packet_path: resolve(String(metadataPacketPath)) } : {}),
      countries,
      rollout: structuredClone(app.rollout),
      ...(testerDestination ? { tester_destination: testerDestination } : {}),
      ...(deliveryMode === DAILY_TESTER_MODE ? {} : {
        managed_publishing: app.managed_publishing ?? app.managedPublishing ?? (platform === "android" ? true : false),
        first_publication_bootstrap_verified: app.first_publication_bootstrap_verified ??
          app.firstPublicationBootstrapVerified ?? false
      })
    };
  }
  return result;
}

function proveImmutableCheckouts(request) {
  requireState(existsSync(request.sourceRepositoryRoot) && existsSync(request.toolingRoot),
    "source and tooling checkouts are required");
  const sourceHead = request.gitRunner(request.sourceRepositoryRoot, ["rev-parse", "--verify", "HEAD"]);
  const toolingHead = request.gitRunner(request.toolingRoot, ["rev-parse", "--verify", "HEAD"]);
  requireState(sourceHead === request.serverSha, "source mirror HEAD does not match the accepted server SHA");
  requireState(toolingHead === request.toolingSha, "control tooling HEAD does not match the approved tooling SHA");
  requireState(request.gitRunner(request.sourceRepositoryRoot, ["status", "--porcelain"]) === "",
    "source mirror is not clean");
  requireState(request.gitRunner(request.toolingRoot, ["status", "--porcelain"]) === "",
    "control tooling checkout is not clean");
}

function loadOrCreateState(request) {
  const operationRoot = operationHandoffRoot(request);
  if (existsSync(request.statePath)) {
    const state = readJson(request.statePath);
    requireState(state.schema_version === 1 && state.kind === "ash-atlas-coordinated-mobile-control-state",
      "durable coordinated control state schema is unsupported");
    requireState(state.operation_id === request.operationId && state.pinned?.generation === request.generation &&
      state.pinned.server_sha === request.serverSha && state.tooling_sha === request.toolingSha,
    "durable control state identity changed");
    requireState(state.registry_remote === request.registryRemote,
      "durable control registry remote changed");
    requireState(state.handoff_root === operationRoot,
      `${ACTION_REQUIRED_PERSISTED_ARTIFACT}: durable operation handoff root changed or is missing`);
    requireState((state.delivery_mode ?? null) === request.deliveryMode,
      `${ACTION_REQUIRED_PERSISTED_ARTIFACT}: coordinated delivery mode changed for the active operation`);
    return state;
  }
  const state = {
    schema_version: 1,
    kind: "ash-atlas-coordinated-mobile-control-state",
    operation_id: request.operationId,
    pinned: { generation: request.generation, server_sha: request.serverSha,
      accepted_master_sha: request.acceptedMasterSha, current_server_sha: request.currentServerSha },
    tooling_sha: request.toolingSha,
    registry_remote: request.registryRemote,
    registry_branch: request.registryBranch,
    handoff_root: operationRoot,
    release_id: releaseIdForOperation(request.operationId),
    status: "running",
    phase: "manifest_created",
    unsigned: null,
    signed: null,
    reservation: null,
    reservation_pending: null,
    registry_receipt_pending: null,
    delivery_mode: request.deliveryMode,
    server_evidence: null,
    platforms: Object.fromEntries(PLATFORMS.map((platform) => [platform, {
      completed_steps: [], next_step: "upload", pending: null, candidate: null,
      production: null, snapshot: null, operation: null, receipt: null
    }])),
    action_required: null,
    updated_at_utc: request.now
  };
  writeJsonAtomic(request.statePath, state);
  return state;
}

function ensureUnsigned(request, state) {
  const operationRoot = operationHandoffRoot(request);
  const reservedVersions = reservationVersions(state);
  if (state.unsigned) {
    assertOperationPath(state.unsigned.path, operationRoot, "unsigned manifest");
    const manifest = readDurableManifest(state.unsigned.path, state.unsigned.manifest_sha256, operationRoot);
    validateUnsignedManifest(manifest);
    requireState(sameJson(manifest.reserved_versions, reservedVersions),
      `${ACTION_REQUIRED_PERSISTED_ARTIFACT}: unsigned manifest reservation identity changed`);
    state.unsigned.artifact_hashes = Object.fromEntries(manifest.artifacts.map((entry) => [entry.platform, entry.sha256]));
    return manifest;
  }
  mkdirSync(operationRoot, { recursive: true });
  const quarantineRoot = join(operationRoot, "unsigned");
  mkdirSync(quarantineRoot, { recursive: true });
  let result;
  if (request.sourceManifest) {
    result = validateUnsignedManifest(request.sourceManifest);
  } else {
    const buildRequest = buildUnsignedRequest({ operationId: request.operationId, generation: request.generation,
      sourceSha: request.serverSha, sourceRepositoryRoot: request.sourceRepositoryRoot,
      toolingRoot: request.toolingRoot, registryRemote: request.registryRemote,
      reservedVersions, protocol: request.protocol,
      quarantineRoot, handoffRoot: request.handoffRoot });
    result = request.unsignedRunner
      ? request.unsignedRunner({ request: buildRequest, env: request.env })
      : runUnsignedBuild({ request: buildRequest, env: request.env });
    requireState(result.status === "ok", result.reason ?? "isolated unsigned build requires operator action");
  }
  const path = join(operationRoot, "unsigned-manifest.json");
  writeJsonAtomic(path, result);
  const manifest = validateUnsignedManifest(result);
  requireState(sameJson(manifest.reserved_versions, reservedVersions),
    "unsigned manifest reservation identity does not match the registry allocation");
  state.unsigned = { path, manifest_sha256: manifest.manifest_sha256,
    artifact_hashes: Object.fromEntries(manifest.artifacts.map((entry) => [entry.platform, entry.sha256])) };
  writeState(request, state);
  return manifest;
}

function ensureReservation(request, state) {
  if (state.reservation) {
    validateReservationResult(request, state, state.reservation);
    return;
  }
  validateRequestedVersions(request);
  const args = ["reserve", "--remote", request.registryRemote, "--branch", request.registryBranch,
    "--release-id", state.release_id, "--platforms", "ios,android",
    "--ios-marketing-version", request.candidatePlan.ios.marketing_version,
    "--android-marketing-version", request.candidatePlan.android.marketing_version,
    "--generation", request.generation, "--source-sha", request.serverSha,
    "--protocol-min", String(request.protocol.min), "--protocol-max", String(request.protocol.max),
    "--release-mode", request.deliveryMode === DAILY_TESTER_MODE ? "internal" : "production"];
  if (request.registryFile) {
    args.splice(1, 4, "--file", request.registryFile);
  } else if (request.registrySeed) {
    args.push("--seed", request.registrySeed);
  }
  state.reservation_pending = { action: "reserve", release_id: state.release_id, requested_at_utc: request.now };
  writeState(request, state);
  let result;
  try { result = request.registryRunner(request, args); }
  catch (error) {
    throw Object.assign(new Error(`registry reservation remains unresolved: ${safeReason(error)}`),
      { code: "ACTION_REQUIRED_REGISTRY_RESERVATION" });
  }
  requireState(result.reservations?.ios && result.reservations?.android,
    "registry reservation did not return both platform allocations");
  validateReservationResult(request, state, result);
  state.reservation = { registry_sha256: result.registrySha256,
    allocations: result.allocations, reservations: result.reservations };
  state.reservation_pending = null;
  writeState(request, state);
}

function validateRequestedVersions(request) {
  for (const platform of PLATFORMS) {
    const supplied = request.reservedVersions?.[platform];
    if (!supplied || typeof supplied !== "object") continue;
    const requestedMarketingVersion = supplied.marketingVersion ?? supplied.marketing_version;
    if (requestedMarketingVersion !== undefined) {
      requireState(String(requestedMarketingVersion) === request.candidatePlan[platform].marketing_version,
        `${platform} requested marketing version does not match the candidate plan`);
    }
  }
}

function validateReservationResult(request, state, result) {
  const reservations = result.reservations;
  requireState(reservations && typeof reservations === "object", "registry reservation result is invalid");
  for (const platform of PLATFORMS) {
    const reservation = reservations[platform];
    const policy = request.candidatePlan[platform];
    requireState(reservation && reservation.platform === platform &&
      reservation.releaseId === state.release_id &&
      reservation.generation === request.generation && reservation.sourceSha === request.serverSha &&
      reservation.marketingVersion === policy.marketing_version &&
      Number.isInteger(Number(reservation.build)) && Number(reservation.build) > 0 &&
      reservation.protocol?.min === request.protocol.min && reservation.protocol?.max === request.protocol.max,
    `${platform} registry reservation is not bound to the exact candidate`);
    requireState(result.allocations?.[platform] === reservation.build,
      `${platform} registry allocation does not match its reservation`);
  }
}

function reservationVersions(state) {
  requireState(state.reservation?.reservations, "registry reservation is required before building");
  return Object.fromEntries(PLATFORMS.map((platform) => {
    const reservation = state.reservation.reservations[platform];
    requireState(reservation && Number.isInteger(Number(reservation.build)) && Number(reservation.build) > 0 &&
      typeof reservation.marketingVersion === "string" && reservation.marketingVersion.length > 0,
    `${platform} registry reservation identity is incomplete`);
    return [platform, { marketingVersion: reservation.marketingVersion, build: Number(reservation.build) }];
  }));
}

function ensureSigned(request, state) {
  const operationRoot = operationHandoffRoot(request);
  const reservedVersions = reservationVersions(state);
  const signedRoot = join(operationRoot, "signed");
  mkdirSync(signedRoot, { recursive: true });
  assertOperationPath(state.unsigned.path, operationRoot, "unsigned manifest");
  const unsigned = validateUnsignedManifest(readDurableManifest(state.unsigned.path,
    state.unsigned.manifest_sha256, operationRoot));
  if (state.signed) {
    assertOperationPath(state.signed.path, operationRoot, "signed manifest");
    const signed = readJson(state.signed.path);
    const normalized = validateSignedArtifactResult({ ...signed, status: "ok" }, {
      operation_id: request.operationId, generation: request.generation, source_sha: request.serverSha,
      tooling_root: request.toolingRoot, signed_quarantine_root: signedRoot,
      unsigned_manifest_sha256: unsigned.manifest_sha256, registry_remote: request.registryRemote,
      reserved_versions: reservedVersions, protocol: request.protocol
    }, unsigned);
    requireState(normalized.manifest_sha256 === state.signed.manifest_sha256,
      "persisted signed manifest fingerprint changed");
    state.signed.artifacts = normalized.artifacts;
    state.signed.artifact_hashes = Object.fromEntries(normalized.artifacts.map((entry) => [entry.platform, entry.sha256]));
    return normalized;
  }
  const signingRequest = { schema_version: 1, kind: "ash-atlas-coordinated-sign-request",
    operation_id: request.operationId, generation: request.generation, source_sha: request.serverSha,
      source_repository_root: request.sourceRepositoryRoot, tooling_root: request.toolingRoot,
      registry_remote: request.registryRemote, reserved_versions: reservedVersions,
      protocol: request.protocol, signed_quarantine_root: signedRoot };
  const result = request.signerRunner
    ? request.signerRunner({ request: signingRequest, unsignedManifest: unsigned, env: request.env })
    : runTrustedSigning({ request: signingRequest, unsignedManifest: unsigned,
      env: request.env, signer: request.env.COORDINATED_TRUSTED_SIGNER });
  requireState(result.status === "ok", result.reason ?? "trusted signing requires operator action");
  const path = join(operationRoot, "signed-manifest.json");
  writeJsonAtomic(path, result);
  state.signed = { path, manifest_sha256: result.manifest_sha256,
    unsigned_manifest_sha256: result.unsigned_manifest_sha256,
    artifacts: result.artifacts,
    artifact_hashes: Object.fromEntries(result.artifacts.map((entry) => [entry.platform, entry.sha256])) };
  writeState(request, state);
}

function processPlatform(request, state, platform, steps, actions) {
  const platformState = state.platforms[platform];
  const dailyTesters = request.deliveryMode === DAILY_TESTER_MODE;
  if (platformState.pending) {
    reconcilePendingStep(request, state, platform, actions);
    if (platformState.pending) return;
  }
  const releasing = steps.includes("release");
  for (const step of steps) {
    if (step === "reconcile" && (dailyTesters
      ? platformState.receipt?.tester_available === true
      : platformState.receipt?.public_available === true)) continue;
    if (step !== "reconcile" && platformState.completed_steps.includes(step)) continue;
    if (step === "reconcile" && platformState.completed_steps.includes(step) &&
      platformState.receipt && (releasing
        ? (dailyTesters ? platformState.receipt.tester_available === true :
          platformState.receipt.public_available === true)
        : isReady(platformState.receipt, false, dailyTesters))) continue;
    const attemptId = step === "reconcile" ? exactProductionOperationId(platformState) : null;
    const extra = step === "reconcile" ? {
      target_action: platformState.operation?.action ?? (releasing ? "release" : "submit")
    } : {};
    invokeStoreStep(request, state, platform, step, actions, attemptId, extra);
    if (platformState.pending) return;
  }
}

function exactProductionOperationId(platformState) {
  const operationId = platformState.operation?.operationId ?? platformState.operation?.operation_id;
  requireState(typeof operationId === "string" && operationId.length > 0,
    `${ACTION_REQUIRED_TRUSTED_STORE}: exact production operation is required before reconcile`);
  return operationId;
}

function reconcilePendingStep(request, state, platform, actions) {
  const platformState = state.platforms[platform];
  const pending = platformState.pending;
  const result = invokeStoreProvider(request, state, platform, "reconcile", pending.attempt_id,
    { target_action: pending.action, reconcile_attempt_id: pending.attempt_id });
  actions.push({ platform, action: "reconcile", attempt_id: pending.attempt_id });
  if (result.status === "ACTION_REQUIRED" || result.status === "pending" ||
    result.mutation_status === "unknown") {
    platformState.pending.last_result = summarizeStoreResult(result);
    state.status = "ACTION_REQUIRED";
    state.action_required = { code: result.code ?? ACTION_REQUIRED_TRUSTED_STORE,
      reason: result.reason ?? "trusted store reconciliation remains unresolved", observed_at_utc: request.now };
    return;
  }
  const mutationStatus = result.mutation_status;
  requireState(mutationStatus === "confirmed" || mutationStatus === "not_mutated",
    "store reconciliation omitted explicit mutation proof");
  if (mutationStatus === "confirmed") {
    platformState.pending = null;
    completeStoreResult(request, state, platform, pending.action, result);
    return;
  }
  requireState(mutationStatus === "not_mutated", "store reconciliation did not prove a safe retry");
  platformState.pending = null;
  invokeStoreStep(request, state, platform, pending.action, actions);
}

function invokeStoreStep(request, state, platform, action, actions, attemptIdOverride = null, extra = {}) {
  const platformState = state.platforms[platform];
  const attemptId = attemptIdOverride ?? `${coordinatedChildOperationId(request.operationId, platform)}:${action}`;
  platformState.pending = { action, attempt_id: attemptId, requested_at_utc: request.now };
  writeState(request, state);
  const result = invokeStoreProvider(request, state, platform, action, attemptId, extra);
  actions.push({ platform, action, attempt_id: attemptId, status: result.status });
  if (result.status === "ACTION_REQUIRED" || result.status === "pending" ||
    result.mutation_status === "unknown") {
    platformState.pending.last_result = summarizeStoreResult(result);
    state.status = "ACTION_REQUIRED";
    state.action_required = { code: result.code ?? ACTION_REQUIRED_TRUSTED_STORE,
      reason: result.reason ?? `trusted store ${action} remains unresolved`, observed_at_utc: request.now };
    return;
  }
  completeStoreResult(request, state, platform, action, result);
}

function invokeStoreProvider(request, state, platform, action, attemptId, extra = {}) {
  if (request.storeProviderRunner) {
    const result = request.storeProviderRunner({ request, state, platform, action, attemptId, extra });
    const expected = buildTrustedStoreRequest(request, state, platform, action, attemptId).candidate;
    return validateStoreStepResult(result, request, platform, action, expected);
  }
  const provider = request.trustedStoreProvider;
  requireState(typeof provider === "string" && isAbsolute(provider) && existsSync(provider),
    `${ACTION_REQUIRED_TRUSTED_STORE}: a private trusted store adapter is required`);
  const operationRoot = operationHandoffRoot(request);
  mkdirSync(operationRoot, { recursive: true });
  const requestPath = join(operationRoot, `${platform}-${action}-request.json`);
  const outputPath = join(operationRoot, `${platform}-${action}-result.json`);
  const payload = { ...buildTrustedStoreRequest(request, state, platform, action, attemptId), ...extra };
  writeJsonAtomic(requestPath, payload);
  try {
    const builtIn = isBuiltInTrustedStoreAdapter(provider, request.toolingRoot);
    executeExternalProvider({ provider, args: ["--request", requestPath, "--output", outputPath],
      cwd: request.toolingRoot, forbiddenRoots: builtIn ? [request.sourceRepositoryRoot] :
        [request.sourceRepositoryRoot, request.toolingRoot],
      env: scopedEnvironment({ env: request.env, names: TRUSTED_STORE_ENV_NAMES,
        overrides: { COORDINATED_STORE_REQUEST: requestPath, COORDINATED_STORE_OUTPUT: outputPath } }) });
  } catch (error) {
    throw Object.assign(new Error(`${ACTION_REQUIRED_TRUSTED_STORE}: store adapter execution is unresolved`),
      { code: ACTION_REQUIRED_TRUSTED_STORE, cause: error });
  }
  requireState(existsSync(outputPath) && statSync(outputPath).size > 0,
    `${ACTION_REQUIRED_TRUSTED_STORE}: store adapter omitted its result`);
  const result = readJson(outputPath);
  const expected = buildTrustedStoreRequest(request, state, platform, action, attemptId).candidate;
  return validateStoreStepResult(result, request, platform, action, expected);
}

function isBuiltInTrustedStoreAdapter(provider, toolingRoot) {
  const expected = join(toolingRoot, BUILT_IN_TRUSTED_STORE_ADAPTER);
  return existsSync(provider) && existsSync(expected) &&
    realpathSync(provider) === realpathSync(expected);
}

function completeStoreResult(request, state, platform, action, result) {
  const platformState = state.platforms[platform];
  platformState.pending = null;
  platformState.candidate = result.candidate;
  platformState.production = result.production;
  platformState.snapshot = result.snapshot;
  platformState.operation = result.operation ?? null;
  const receipt = buildCoordinatedChildReceipt({ coordinatedOperationId: request.operationId,
    candidate: result.candidate, production: result.production, snapshot: result.snapshot,
    operation: result.operation ?? null, observedAt: request.now });
  platformState.receipt = receipt;
  platformState.completed_steps = [...new Set([...platformState.completed_steps, action])]
    .filter((entry) => STORE_STEPS.includes(entry) || RELEASE_STEPS.includes(entry));
  // Persist the authoritative mutation and completed step before the registry
  // receipt CAS. A lost receipt response must never replay the store write.
  writeState(request, state);
  recordReceipt(request, state, platform, receipt);
  const unresolvedPlatform = Object.values(state.platforms).some((entry) => entry.pending);
  state.status = unresolvedPlatform ? "ACTION_REQUIRED" : "running";
  if (!unresolvedPlatform) state.action_required = null;
}

function recordReceipt(request, state, platform, receipt) {
  state.registry_receipt_pending = { platform, receipt };
  writeState(request, state);
  retryPendingRegistryReceipt(request, state);
}

function retryPendingRegistryReceipt(request, state) {
  const pending = state.registry_receipt_pending;
  if (!pending) return;
  const { platform, receipt } = pending;
  const args = ["coordinated-mobile-receipt", "--remote", request.registryRemote,
    "--branch", request.registryBranch, "--receipt-file", join(operationHandoffRoot(request), `${platform}-receipt.json`)];
  mkdirSync(operationHandoffRoot(request), { recursive: true });
  writeJsonAtomic(join(operationHandoffRoot(request), `${platform}-receipt.json`), receipt);
  if (request.registryFile) args.splice(1, 4, "--file", request.registryFile);
  try {
    const result = request.registryRunner(request, args);
    state.registry_sha256 = result.registrySha256;
    state.registry_receipt_pending = null;
    if (!Object.values(state.platforms).some((entry) => entry.pending)) {
      state.status = "running";
      state.action_required = null;
    }
    writeState(request, state);
  } catch (error) {
    throw Object.assign(new Error(`registry receipt remains unresolved: ${safeReason(error)}`),
      { code: "ACTION_REQUIRED_REGISTRY_RECEIPT" });
  }
}

function clearStaleActionRequired(request, state) {
  const unresolved = state.reservation_pending || state.registry_receipt_pending ||
    Object.values(state.platforms).some((entry) => entry.pending);
  if (!unresolved && state.status === "ACTION_REQUIRED") {
    state.status = "running";
    state.action_required = null;
    writeState(request, state);
  }
}

function applyServerEvidence(request, state) {
  const evidence = request.serverEvidence ?? (request.serverEvidencePath ? readJson(request.serverEvidencePath) : null);
  requireState(evidence, "post-health requires authenticated server evidence");
  verifyAuthenticatedCoordinatedServerEvidence(evidence,
    request.env.COORDINATED_SERVER_EVIDENCE_HMAC_KEY,
    request.env.COORDINATED_SERVER_EVIDENCE_HMAC_KEY_ID ?? "coordinated-server-evidence-v1");
  requireState(evidence.coordinated_operation_id === request.operationId &&
    evidence.generation === request.generation && evidence.source_sha === request.serverSha &&
    evidence.accepted_master_sha === request.acceptedMasterSha && evidence.healthy === true,
  "post-health evidence is not bound to the exact operation");
  for (const platform of PLATFORMS) {
    const expected = evidence.candidates?.[platform]?.candidate ?? evidence.apps?.[platform]?.candidate;
    const actual = state.platforms[platform].candidate;
    requireState(actual && expected && sameJson(coordinatedCandidateIdentity(actual), coordinatedCandidateIdentity(expected)),
      `${platform} post-health candidate differs from authenticated server evidence`);
    requireState(evidence.candidates[platform].approval_fingerprint ===
      coordinatedApprovalFingerprint(coordinatedCandidateIdentity(actual)),
    `${platform} post-health approval fingerprint changed`);
  }
  state.server_evidence = evidence;
}

function finalizeResult(request, state, actions) {
  const receipts = PLATFORMS.map((platform) => state.platforms[platform].receipt).filter(Boolean);
  const byPlatform = Object.fromEntries(receipts.map((receipt) => [receipt.platform, receipt]));
  const submitted = PLATFORMS.every((platform) => byPlatform[platform]?.submitted === true);
  const dailyTesters = request.deliveryMode === DAILY_TESTER_MODE;
  const healthy = state.server_evidence?.healthy === true;
  const prepared = PLATFORMS.every((platform) => byPlatform[platform] &&
    isReady(byPlatform[platform], state.server_evidence?.published === true, dailyTesters));
  const testerReady = dailyTesters && PLATFORMS.every((platform) => byPlatform[platform]?.tester_available === true);
  const ready = dailyTesters && healthy ? testerReady : prepared;
  const publicAvailable = PLATFORMS.every((platform) => byPlatform[platform]?.public_available === true);
  const released = dailyTesters
    ? testerReady
    : PLATFORMS.every((platform) => byPlatform[platform]?.release_requested === true);
  const phase = receipts.length < 2 ? "manifest_created" : !submitted ? "manifest_created" :
    !prepared ? "apps_submitted" : !state.server_evidence?.published ? "apps_ready" :
      !state.server_evidence?.activated ? "server_activated" : !healthy ? "server_healthy" :
        dailyTesters && !testerReady ? "apps_release_requested" : dailyTesters ? "completed" :
          !released ? "apps_release_requested" : !publicAvailable ? "apps_release_requested" : "completed";
  state.phase = phase;
  const result = {
    schemaVersion: 1,
    kind: "ash-atlas-coordinated-mobile-result",
    status: state.status === "ACTION_REQUIRED" ? "ACTION_REQUIRED" : "ok",
    coordinated_operation_id: request.operationId,
    phase,
    next_phase: phase === "completed" ? "completed" : phase,
    receipts,
    platforms: byPlatform,
    ios: byPlatform.ios ?? null,
    android: byPlatform.android ?? null,
    actions,
    registry_sha256: state.registry_sha256 ?? null,
    unsigned_manifest_sha256: state.unsigned?.manifest_sha256 ?? null,
    signed_manifest_sha256: state.signed?.manifest_sha256 ?? null,
    ...(state.action_required ? { action_required: state.action_required } : {}),
    observed_at_utc: request.now
  };
  if (phase === "completed") state.status = "completed";
  if (request.seedPath && ready && receipts.length === 2 && !state.action_required && state.status !== "ACTION_REQUIRED") {
    const artifacts = buildCoordinatedReleaseSeed({ operationId: request.operationId,
      generation: request.generation, serverSha: request.serverSha,
      acceptedMasterSha: request.acceptedMasterSha, currentServerSha: request.currentServerSha,
      result, now: request.now });
    writeCoordinatedBootstrapArtifacts({ seedPath: request.seedPath,
      receiptPath: request.receiptPath ?? join(operationHandoffRoot(request), "coordinated-mobile-receipt.json"),
      seed: artifacts.seed, receipt: artifacts.receipt });
  }
  return result;
}

function readDurableManifest(path, expectedHash, operationRoot) {
  requireState(typeof path === "string" && isAbsolute(path) && existsSync(path),
    `${ACTION_REQUIRED_PERSISTED_ARTIFACT}: persisted manifest is unavailable`);
  if (operationRoot) assertOperationPath(path, operationRoot, "persisted manifest");
  const manifest = readJson(path);
  requireState(SHA256.test(String(expectedHash ?? "")), "persisted manifest hash is invalid");
  requireState(manifest.manifest_sha256 === expectedHash, `${ACTION_REQUIRED_PERSISTED_ARTIFACT}: manifest hash changed`);
  return manifest;
}

function operationHandoffRoot(request) {
  return buildOperationHandoffRoot(request.handoffRoot, request.operationId);
}

function assertOperationPath(path, operationRoot, label) {
  const candidate = resolve(path);
  const root = resolve(operationRoot);
  const child = relative(root, candidate);
  requireState(candidate !== root && child !== ".." &&
    !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(child),
  `${ACTION_REQUIRED_PERSISTED_ARTIFACT}: ${label} must stay inside the exact operation handoff root`);
}

function registryCommand(request, args) {
  const script = join(request.toolingRoot, "tools", "mobile-release", "registry-remote.mjs");
  const env = scopedEnvironment({ env: request.env, names: ["PATH", "HOME", "TMPDIR", "RUNNER_TEMP", "CI",
    "GITHUB_ACTIONS", "GITHUB_RUN_ID", "ASH_ATLAS_REGISTRY_TOKEN", "GITHUB_REPOSITORY"] });
  const output = execFileSync(process.execPath, [script, ...args], {
    cwd: request.toolingRoot, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
  });
  return JSON.parse(output.trim());
}

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim().toLowerCase();
}

function writeState(request, state) {
  state.updated_at_utc = request.now;
  writeJsonAtomic(request.statePath, state);
}

function safePlatformState(state) {
  return { completed_steps: [...state.completed_steps], pending: state.pending,
    candidate: state.candidate, receipt_sha256: state.receipt?.receipt_sha256 ?? null };
}

function summarizeStoreResult(result) {
  return {
    status: result.status,
    action: result.action,
    mutation_status: result.mutation_status ?? result.mutation?.status ?? "unknown",
    remote_operation_id: result.remote_operation_id ?? result.operation?.operationId ?? null,
    candidate_fingerprint: result.candidate
      ? coordinatedApprovalFingerprint(coordinatedCandidateIdentity(result.candidate)) : null,
    observed_at_utc: result.observed_at_utc ?? null
  };
}

function isReady(receipt, allowPublic = false, dailyTesters = false) {
  if (dailyTesters) return receipt.tester_prepared === true || receipt.tester_available === true;
  if (allowPublic && receipt.public_available === true) return true;
  return receipt.platform === "ios"
    ? receipt.store_status === "PENDING_DEVELOPER_RELEASE" && receipt.public_available === false
    : receipt.store_status === "RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED" &&
      receipt.managed_publishing === true && receipt.public_available === false;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function safeReason(error) {
  if (error?.code === ACTION_REQUIRED_PROVISION_ISOLATED_BUILD ||
    String(error?.message).includes(ACTION_REQUIRED_PROVISION_ISOLATED_BUILD)) return String(error.message).slice(0, 1000);
  if (error?.code === ACTION_REQUIRED_TRUSTED_STORE) return String(error.message).slice(0, 1000);
  return String(error?.message ?? "trusted coordinated mobile operation requires operator action").slice(0, 1000);
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const plan = JSON.parse(readFileSync(resolve(required(args, "plan-file")), "utf8"));
  const sourceRoot = resolve(required(args, "source-repository-root"));
  const validatedPlan = plan.kind === "ash-atlas-coordinated-mobile-bootstrap-plan"
    ? validateBootstrapPlan(plan, { operationId: required(args, "operation-id"), generation: required(args, "generation"),
      serverSha: required(args, "server-sha"), acceptedMasterSha: required(args, "accepted-master-sha"),
      currentServerSha: required(args, "current-server-sha"), registryRemote: required(args, "registry-remote"),
      workspace: sourceRoot })
    : plan;
  const result = runCoordinatedControl({
    action: args.action ?? "start", operationId: required(args, "operation-id"), generation: required(args, "generation"),
    serverSha: required(args, "server-sha"), acceptedMasterSha: required(args, "accepted-master-sha"),
    currentServerSha: required(args, "current-server-sha"), toolingSha: required(args, "tooling-sha"),
    sourceRepositoryRoot: sourceRoot, toolingRoot: required(args, "tooling-root"),
    registryRemote: required(args, "registry-remote"), registryBranch: args["registry-branch"] ?? "mobile-release-state",
    registryFile: args["registry-file"], registrySeed: args["registry-seed"], handoffRoot: required(args, "handoff-root"),
    statePath: required(args, "state-file"), seedPath: args["seed-path"], receiptPath: args["receipt-path"],
    plan: validatedPlan, reservedVersions: JSON.parse(readFileSync(resolve(required(args, "reserved-versions-file")), "utf8")),
    protocol: { min: Number(args["protocol-min"] ?? 3), max: Number(args["protocol-max"] ?? 3) },
    trustedStoreProvider: args["trusted-store-provider"] ?? process.env.COORDINATED_TRUSTED_STORE_PROVIDER,
    serverEvidencePath: args["server-evidence-file"]
  });
  const outputPath = assertOutsideRoots(required(args, "output"), [sourceRoot, resolve(required(args, "tooling-root"))]);
  writeJsonAtomic(outputPath, result);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === "ACTION_REQUIRED") process.exitCode = 1;
}

function requireState(condition, message) {
  if (!condition) throw new Error(message);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(); } catch (error) {
    console.error(safeReason(error));
    process.exitCode = 1;
  }
}
