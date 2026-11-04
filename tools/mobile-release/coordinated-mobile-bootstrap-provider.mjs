import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { validateProductionMetadataPacket } from "./production.mjs";
import {
  ACTION_REQUIRED_PROVISION_ISOLATED_BUILD,
  executeExternalProvider,
  readJson,
  requireProvisionedBuildBoundary,
  scopedEnvironment
} from "./coordinated-build-boundary.mjs";
import { DAILY_TESTER_MODE, readTesterDeliveryMode, readTesterDestination } from "./coordinated-mobile-testers.mjs";

const SHA = /^[0-9a-f]{40}$/u;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const GENERATION = /^t\d{3,4}$/u;
const REGISTRY_REMOTE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const PLATFORMS = ["ios", "android"];
const MAX_PLAN_BYTES = 2 * 1024 * 1024;

/**
 * Validate the operator packet without running any source or store code.  The
 * packet remains useful to the private control workflow, while this checkout
 * cannot use it to authorize a mutation.
 */
export function validateBootstrapPlan(plan, {
  operationId,
  generation,
  serverSha,
  acceptedMasterSha,
  currentServerSha,
  registryRemote = null,
  workspace = process.env.GITHUB_WORKSPACE ?? process.cwd()
}) {
  requireState(plan && typeof plan === "object" && !Array.isArray(plan),
    "coordinated bootstrap plan must be an object");
  requireState(plan.schemaVersion === 1 &&
    plan.kind === "ash-atlas-coordinated-mobile-bootstrap-plan",
  "coordinated bootstrap plan schema is unsupported");
  const plannedRegistryRemote = plan.pinned?.registry_remote;
  if (registryRemote !== null) requireState(REGISTRY_REMOTE.test(String(registryRemote)),
    "coordinated bootstrap registry remote is invalid");
  if (plannedRegistryRemote !== undefined) {
    requireState(REGISTRY_REMOTE.test(String(plannedRegistryRemote)),
      "coordinated bootstrap plan registry remote is invalid");
    if (registryRemote !== null) requireState(String(plannedRegistryRemote) === String(registryRemote),
      "coordinated bootstrap plan registry remote changed");
  }
  if (plan.operation_id !== undefined) requireState(plan.operation_id === operationId,
    "coordinated bootstrap plan operation does not match the controller");
  if (plan.pinned !== undefined) {
    requireState(plan.pinned.generation === generation && plan.pinned.server_sha === serverSha &&
      plan.pinned.accepted_master_sha === acceptedMasterSha &&
      plan.pinned.current_server_sha === currentServerSha,
    "coordinated bootstrap plan pinned tuple changed");
  }
  requireState(plan.apps && typeof plan.apps === "object" && !Array.isArray(plan.apps),
    "coordinated bootstrap plan must contain both app plans");
  requireState(Object.keys(plan.apps).sort().join(",") === "android,ios",
    "coordinated bootstrap plan must contain exactly ios and android");
  const deliveryMode = readTesterDeliveryMode(plan);
  requireState(deliveryMode === null || deliveryMode === DAILY_TESTER_MODE,
    "coordinated bootstrap delivery mode is unsupported");
  const normalized = { schemaVersion: 1, kind: plan.kind, operation_id: operationId,
    pinned: { generation, server_sha: serverSha, accepted_master_sha: acceptedMasterSha,
      current_server_sha: currentServerSha,
      ...((registryRemote ?? plannedRegistryRemote) ? { registry_remote: registryRemote ?? plannedRegistryRemote } : {}) }, apps: {} };
  if (deliveryMode) normalized.delivery_mode = deliveryMode;
  if (plan.version_plan !== undefined) {
    requireState(plan.version_plan && typeof plan.version_plan === "object" && !Array.isArray(plan.version_plan),
      "coordinated bootstrap version plan is invalid");
    for (const platform of PLATFORMS) {
      const entry = plan.version_plan[platform];
      requireState(entry && entry.marketingVersion === plan.apps[platform].marketing_version,
        `${platform} coordinated bootstrap version plan changed`);
    }
    normalized.version_plan = structuredClone(plan.version_plan);
  }
  for (const platform of PLATFORMS) {
    const app = plan.apps[platform];
    requireState(app && typeof app === "object" && !Array.isArray(app),
      `${platform} bootstrap plan is invalid`);
    const packetPath = app.metadata_packet_path;
    requireState(typeof packetPath === "string" && isAbsolute(packetPath),
      `${platform} metadata_packet_path must be an absolute protected path`);
    assertOutsideCheckout(packetPath, workspace, `${platform} metadata packet`);
    requireState(existsSync(packetPath) && statSync(packetPath).size <= MAX_PLAN_BYTES,
      `${platform} approved metadata packet is unavailable or too large`);
    const packetBytes = readFileSync(packetPath);
    let rawPacket;
    try { rawPacket = JSON.parse(packetBytes.toString("utf8")); } catch {
      throw new Error(`${platform} approved metadata packet is not UTF-8 JSON`);
    }
    const packet = validateProductionMetadataPacket(platform, rawPacket);
    const packetDeliveryMode = readTesterDeliveryMode(rawPacket);
    requireState(packetDeliveryMode === deliveryMode,
      `${platform} delivery mode changed between the plan and packet`);
    const testerDestination = readTesterDestination(platform, rawPacket);
    const packetHash = createHash("sha256").update(packetBytes).digest("hex");
    const countries = packet.policy.countries;
    const rollout = packet.policy.rollout;
    if (app.metadata_sha256 !== undefined) requireState(app.metadata_sha256 === packetHash,
      `${platform} metadata hash does not match the packet bytes`);
    if (app.marketing_version !== undefined) requireState(app.marketing_version === packet.marketingVersion,
      `${platform} marketing version does not match the packet`);
    if (app.countries !== undefined) requireState(sameJson(app.countries, countries),
      `${platform} country policy does not match the packet`);
    if (app.rollout !== undefined) requireState(sameJson(app.rollout, rollout),
      `${platform} rollout policy does not match the packet`);
    if (deliveryMode === DAILY_TESTER_MODE) {
      requireState(testerDestination,
        `${platform} daily tester destination is required`);
      requireState(JSON.stringify(readTesterDestination(platform, app, ["tester_destination", "testerDestination"])) ===
        JSON.stringify(testerDestination),
      `${platform} daily tester destination changed between the plan and packet`);
    } else {
      requireState(!testerDestination,
        `${platform} tester destination requires daily tester delivery mode`);
      if (platform === "android") {
        requireState(app.managed_publishing === true,
          "Google coordinated bootstrap requires managed publishing");
        if (rollout.kind === "first-publish") requireState(app.first_publication_bootstrap_verified === true,
          "Google first publication requires explicit bootstrap evidence");
      }
    }
    normalized.apps[platform] = {
      metadataPacketPath: packetPath,
      metadataHash: packetHash,
      marketingVersion: packet.marketingVersion,
      countries: [...countries],
      rollout: structuredClone(rollout),
      ...(testerDestination ? { testerDestination } : {}),
      managedPublishing: deliveryMode === DAILY_TESTER_MODE ? undefined : platform === "android" ? true : null,
      firstPublicationBootstrapVerified: deliveryMode === DAILY_TESTER_MODE ? false :
        platform === "android" && rollout.kind === "first-publish" ? true : false
    };
  }
  return normalized;
}

export function releaseIdForOperation(operationId) {
  requireState(OPERATION_ID.test(operationId), "coordinated operation ID is invalid");
  const readable = operationId.replace(/[^A-Za-z0-9._-]/gu, "-");
  const suffix = createHash("sha256").update(operationId).digest("hex").slice(0, 12);
  return `coord-${readable.slice(0, 105)}-${suffix}`;
}

export async function runCoordinatedBootstrap({
  action,
  operationId,
  generation,
  serverSha,
  acceptedMasterSha,
  currentServerSha,
  env = process.env,
  cwd = process.cwd()
}) {
  assertRequest({ action, operationId, generation, serverSha, acceptedMasterSha, currentServerSha });
  const fixturePath = env.COORDINATED_BOOTSTRAP_FIXTURE_RESULT;
  if (fixturePath) {
    const fixture = JSON.parse(readFileSync(resolve(fixturePath), "utf8"));
    requireState(fixture?.coordinated_operation_id === operationId &&
      fixture.kind === "ash-atlas-coordinated-mobile-result",
    "coordinated bootstrap fixture result is not bound to the request");
    return fixture;
  }

  // This is intentionally before every plan, registry, store, and build call.
  // The private control repository supplies these roots/providers; the game
  // checkout never turns this validation into a trusted executor.
  const sourceRepositoryRoot = env.COORDINATED_SOURCE_REPOSITORY ?? env.GITHUB_WORKSPACE ?? cwd;
  const toolingRoot = env.COORDINATED_TOOLING_ROOT ?? cwd;
  requireProvisionedBuildBoundary({ env, operationId, generation, sourceSha: serverSha,
    sourceRepositoryRoot, toolingRoot, registryRemote: env.ASH_ATLAS_REGISTRY_REPOSITORY });
  const provider = env.COORDINATED_MOBILE_CONTROL_PROVIDER;
  if (typeof provider !== "string" || !isAbsolute(provider)) {
    throw new Error(`${ACTION_REQUIRED_PROVISION_ISOLATED_BUILD}: the game-repository provider is disabled; invoke the private control-repository workflow`);
  }
  const temporary = mkdtempSync(join(tmpdir(), "ash-atlas-mobile-control-request-"));
  const requestPath = join(temporary, "request.json");
  const outputPath = join(temporary, "result.json");
  try {
    writeJson(requestPath, {
      schema_version: 1,
      kind: "ash-atlas-coordinated-mobile-control-request",
      action,
      operation_id: operationId,
      generation,
      server_sha: serverSha,
      accepted_master_sha: acceptedMasterSha,
      current_server_sha: currentServerSha,
      source_repository_root: resolve(sourceRepositoryRoot),
      tooling_root: resolve(toolingRoot),
      registry_remote: env.ASH_ATLAS_REGISTRY_REPOSITORY,
      registry_branch: env.ASH_ATLAS_REGISTRY_BRANCH ?? "mobile-release-state",
      handoff_root: env.COORDINATED_HANDOFF_ROOT ?? null,
      plan_path: env.COORDINATED_MOBILE_PLAN_PATH ?? null,
      reserved_versions_path: env.COORDINATED_RESERVED_VERSIONS_PATH ?? null
    });
    executeExternalProvider({ provider, args: ["--request", requestPath, "--output", outputPath],
      cwd: toolingRoot, forbiddenRoots: [sourceRepositoryRoot, toolingRoot],
      env: scopedEnvironment({ env, names: ["PATH", "HOME", "TMPDIR", "RUNNER_TEMP", "CI", "GITHUB_ACTIONS",
        "GITHUB_RUN_ID", "ASH_ATLAS_REGISTRY_TOKEN", "GITHUB_REPOSITORY", "APPLE_API_KEY_ID", "APPLE_ISSUER_ID",
        "APPLE_PRIVATE_KEY_PATH", "GOOGLE_APPLICATION_CREDENTIALS", "PRODUCTION_TOOL_SHA"],
        overrides: { COORDINATED_CONTROL_REQUEST: requestPath, COORDINATED_CONTROL_OUTPUT: outputPath } }) });
    const result = readJson(outputPath);
    requireState(result?.kind === "ash-atlas-coordinated-mobile-result" &&
      result.coordinated_operation_id === operationId && result.status === "ok",
    "private control provider returned an invalid or incomplete result");
    return result;
  } finally {
    try { rmSync(temporary, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

export function assertProductionCandidateCanBeReplaced(production, platform, childId) {
  const candidate = production?.candidate ?? null;
  if (!candidate || candidate.operationId === childId) return true;
  const terminal = ["released", "completed", "paused", "halted"].includes(production?.phase) &&
    production?.baseline?.storeBuildId !== undefined &&
    String(production.baseline.storeBuildId) === String(candidate.storeBuildId);
  requireState(terminal,
    `${platform} has an active production candidate for another coordinated operation`);
  return true;
}

export function internalUploadRecoveryAction(release, platform) {
  if (release?.uploadAttempted === true) return "verify";
  if (release?.availabilityPending) {
    throw new Error(`${platform} internal artifact upload outcome is unresolved; reconcile the availability-pending marker before retrying`);
  }
  return "upload";
}

export function safeProviderFailureReason(error) {
  if (error?.code === ACTION_REQUIRED_PROVISION_ISOLATED_BUILD ||
    String(error?.message).startsWith(ACTION_REQUIRED_PROVISION_ISOLATED_BUILD)) {
    return String(error?.message).slice(0, 1000);
  }
  return "trusted Mac provider failed during a protected step";
}

function assertRequest({ action, operationId, generation, serverSha, acceptedMasterSha, currentServerSha }) {
  requireState(["start", "resume"].includes(action), "coordinated bootstrap action must be start or resume");
  requireState(OPERATION_ID.test(operationId), "coordinated operation ID is invalid");
  requireState(GENERATION.test(generation), "coordinated generation is invalid");
  for (const [name, value] of [["server SHA", serverSha], ["accepted master SHA", acceptedMasterSha],
    ["current server SHA", currentServerSha]]) {
    requireState(SHA.test(value), `${name} is invalid`);
  }
}

function assertOutsideCheckout(path, workspace, label) {
  const candidate = resolve(path);
  const root = resolve(workspace);
  const child = relative(root, candidate);
  requireState(candidate !== root && (child === ".." || child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(child)),
    `${label} must be outside the checked-out repository`);
}

function sameJson(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) &&
    left.length === right.length && left.every((value, index) => sameJson(value, right[index]));
  if (left && typeof left === "object" || right && typeof right === "object") {
    if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && sameJson(left[key], right[key]));
  }
  return left === right;
}

function writeJson(path, value) {
  writeFileSync(resolve(path), `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const next = values[index + 1];
    result[value.slice(2)] = next && !next.startsWith("--") ? values[++index] : true;
  }
  return result;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const required = (name) => {
    const value = args[name];
    requireState(value !== undefined && value !== true && String(value).length > 0, `--${name} is required`);
    return String(value);
  };
  runCoordinatedBootstrap({ action: required("action"), operationId: required("operation-id"),
    generation: required("generation"), serverSha: required("server-sha"),
    acceptedMasterSha: required("accepted-master-sha"), currentServerSha: required("current-server-sha")
  }).then((result) => {
    const output = required("output");
    writeJson(output, result);
    process.stdout.write(`${JSON.stringify({ status: "ok", operation_id: result.coordinated_operation_id })}\n`);
  }).catch((error) => {
    const output = args.output;
    const requested = { action: args.action, operationId: args["operation-id"], generation: args.generation,
      serverSha: args["server-sha"], acceptedMasterSha: args["accepted-master-sha"], currentServerSha: args["current-server-sha"] };
    if (output && OPERATION_ID.test(String(requested.operationId ?? "")) && GENERATION.test(String(requested.generation ?? "")) &&
      SHA.test(String(requested.serverSha ?? "")) && SHA.test(String(requested.acceptedMasterSha ?? "")) &&
      SHA.test(String(requested.currentServerSha ?? ""))) {
      writeJson(String(output), { schemaVersion: 1, kind: "ash-atlas-coordinated-mobile-bootstrap-result",
        status: "ACTION_REQUIRED", code: ACTION_REQUIRED_PROVISION_ISOLATED_BUILD,
        coordinated_operation_id: requested.operationId,
        requested: { generation: requested.generation, server_sha: requested.serverSha,
          accepted_master_sha: requested.acceptedMasterSha, current_server_sha: requested.currentServerSha },
        reason: safeProviderFailureReason(error), observed_at_utc: new Date().toISOString() });
    }
    console.error(safeProviderFailureReason(error));
    process.exitCode = 1;
  });
}

function requireState(condition, message) {
  if (!condition) throw new Error(message);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
