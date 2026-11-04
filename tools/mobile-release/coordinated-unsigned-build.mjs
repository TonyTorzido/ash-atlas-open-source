import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ACTION_REQUIRED_PROVISION_ISOLATED_BUILD,
  assertOutsideRoots,
  BUILD_BOUNDARY_PATTERNS,
  executeExternalProvider,
  positiveEnvironment,
  quarantineArtifact,
  artifactSha256,
  readJson,
  safeProvisioningReason,
  writeJsonAtomic
} from "./coordinated-build-boundary.mjs";

const { SHA, GENERATION, OPERATION_ID } = BUILD_BOUNDARY_PATTERNS;
const PLATFORMS = ["ios", "android"];

/**
 * Contract between the Windows coordinator and a private control-repository
 * builder.  This file only validates the request and launches an external
 * unsigned builder.  It never receives store credentials and never executes a
 * command from the game checkout.
 */
export function buildUnsignedRequest({
  operationId,
  generation,
  sourceSha,
  sourceRepositoryRoot,
  toolingRoot,
  registryRemote,
  reservedVersions,
  protocol,
  pushConfig = null,
  quarantineRoot,
  handoffRoot = null
}) {
  requireState(OPERATION_ID.test(operationId), "operation ID is invalid");
  requireState(GENERATION.test(generation), "generation is invalid");
  requireState(SHA.test(sourceSha), "source SHA is invalid");
  requireState(isAbsolute(sourceRepositoryRoot), "sourceRepositoryRoot must be absolute");
  requireState(isAbsolute(toolingRoot), "toolingRoot must be absolute");
  requireState(resolve(sourceRepositoryRoot) !== resolve(toolingRoot),
    "sourceRepositoryRoot and toolingRoot must be distinct");
  requireState(typeof registryRemote === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(registryRemote),
    "registryRemote must be an explicit owner/repository");
  requireState(reservedVersions && typeof reservedVersions === "object" && !Array.isArray(reservedVersions),
    "reservedVersions must be an object");
  requireState(protocol && Number.isInteger(protocol.min) && Number.isInteger(protocol.max) &&
    protocol.min <= protocol.max, "protocol range is invalid");
  requireState(isAbsolute(quarantineRoot), "quarantineRoot must be absolute");
  assertOutsideRoots(quarantineRoot, [sourceRepositoryRoot, toolingRoot], "quarantineRoot");
  if (handoffRoot !== null) {
    requireState(isAbsolute(handoffRoot), "handoffRoot must be absolute");
    assertOutsideRoots(handoffRoot, [sourceRepositoryRoot, toolingRoot], "handoffRoot");
  }
  return {
    schema_version: 1,
    kind: "ash-atlas-coordinated-unsigned-build-request",
    operation_id: operationId,
    generation,
    source_sha: sourceSha,
    source_repository_root: resolve(sourceRepositoryRoot),
    tooling_root: resolve(toolingRoot),
    registry_remote: registryRemote,
    reserved_versions: structuredClone(reservedVersions),
    protocol: { min: protocol.min, max: protocol.max },
    push_config: pushConfig === null ? null : structuredClone(pushConfig),
    quarantine_root: resolve(quarantineRoot),
    handoff_root: resolve(handoffRoot ?? dirname(dirname(resolve(quarantineRoot))))
  };
}

export function validateUnsignedBuildResult(result, request) {
  requireState(result && result.schema_version === 1 &&
    result.kind === "ash-atlas-coordinated-unsigned-build-result" && result.status === "ok",
  "unsigned builder result schema is invalid");
  requireState(result.operation_id === request.operation_id &&
    result.generation === request.generation && result.source_sha === request.source_sha,
  "unsigned builder result is not bound to the request");
  requireState(result.registry_remote === request.registry_remote,
    "unsigned builder result registry remote is not bound to the request");
  requireState(sameJson(result.reserved_versions, request.reserved_versions) &&
    sameJson(result.protocol, request.protocol),
  "unsigned builder result reservation policy is not bound to the request");
  requireState(Array.isArray(result.artifacts) && result.artifacts.length === 2,
    "unsigned builder must return one iOS and one Android artifact");
  const platforms = new Set();
  const artifacts = result.artifacts.map((artifact) => {
    requireState(artifact && PLATFORMS.includes(artifact.platform), "unsigned artifact platform is invalid");
    requireState(!platforms.has(artifact.platform), "unsigned builder returned a duplicate platform");
    platforms.add(artifact.platform);
    const expectedKind = artifact.platform === "ios" ? "xcarchive" : "aab";
    requireState(artifact.kind === expectedKind, `${artifact.platform} unsigned artifact kind is invalid`);
    const reserved = reservationFor(request.reserved_versions, artifact.platform);
    const marketingVersion = String(artifact.marketing_version ?? artifact.marketingVersion ?? "");
    const build = Number(artifact.build);
    requireState(marketingVersion === String(reserved.marketingVersion ?? reserved.marketing_version ?? ""),
      `${artifact.platform} unsigned artifact marketing version does not match its reservation`);
    requireState(Number.isInteger(build) && build > 0 && build === Number(reserved.build),
      `${artifact.platform} unsigned artifact build does not match its reservation`);
    const path = quarantineArtifact(artifact.path, request.quarantine_root,
      `${artifact.platform} unsigned artifact`, artifact.kind,
      [request.source_repository_root, request.tooling_root]);
    const hash = artifactSha256(path);
    requireState(hash === artifact.sha256, `${artifact.platform} unsigned artifact hash does not match its bytes`);
    requireState(/^([0-9a-f]{64})$/u.test(artifact.sha256), `${artifact.platform} unsigned artifact hash is invalid`);
    return { platform: artifact.platform, kind: artifact.kind, path, sha256: artifact.sha256,
      marketing_version: marketingVersion, build };
  });
  requireState(PLATFORMS.every((platform) => platforms.has(platform)),
    "unsigned builder must return both platforms");
  const manifest = {
    schema_version: 1,
    kind: "ash-atlas-coordinated-unsigned-artifact-manifest",
    operation_id: request.operation_id,
    generation: request.generation,
    source_sha: request.source_sha,
    source_repository_root: request.source_repository_root,
    tooling_root: request.tooling_root,
    registry_remote: request.registry_remote,
    reserved_versions: structuredClone(request.reserved_versions),
    protocol: structuredClone(request.protocol),
    push_config: request.push_config === null ? null : structuredClone(request.push_config),
    quarantine_root: request.quarantine_root,
    artifacts,
  };
  manifest.manifest_sha256 = unsignedManifestFingerprint(manifest);
  return manifest;
}

export function runUnsignedBuild({
  request,
  env = process.env,
  builder = env.COORDINATED_ISOLATED_BUILDER,
  now = new Date().toISOString()
}) {
  const outputDirectory = join(dirname(resolve(request.quarantine_root)), ".isolated-build");
  mkdirSync(outputDirectory, { recursive: true });
  const requestPath = join(outputDirectory, "request.json");
  const resultPath = join(outputDirectory, "result.json");
  try {
    writeJsonAtomic(requestPath, request);
    if (typeof builder !== "string" || !isAbsolute(builder)) {
      throw new Error(`${ACTION_REQUIRED_PROVISION_ISOLATED_BUILD}: an external isolated unsigned builder is required before reservation`);
    }
    const supervisor = env.COORDINATED_ISOLATED_BUILD_SUPERVISOR;
    if (typeof supervisor !== "string" || !isAbsolute(supervisor)) {
      throw new Error(`${ACTION_REQUIRED_PROVISION_ISOLATED_BUILD}: a macOS isolation supervisor is required before reservation`);
    }
    const supervisorSha256 = env.COORDINATED_ISOLATED_BUILD_SUPERVISOR_SHA256;
    if (!/^([0-9a-f]{64})$/u.test(String(supervisorSha256 ?? "")) ||
      artifactSha256(supervisor) !== supervisorSha256) {
      throw new Error(`${ACTION_REQUIRED_PROVISION_ISOLATED_BUILD}: the isolation supervisor fingerprint is missing or changed`);
    }
    const gate = env.COORDINATED_ISOLATED_BUILD_GATE;
    const gateSha256 = env.COORDINATED_ISOLATED_BUILD_GATE_SHA256;
    if (typeof gate !== "string" || !isAbsolute(gate) ||
      !/^([0-9a-f]{64})$/u.test(String(gateSha256 ?? "")) || artifactSha256(gate) !== gateSha256) {
      throw new Error(`${ACTION_REQUIRED_PROVISION_ISOLATED_BUILD}: the root-owned Mac build gate fingerprint is missing or changed`);
    }
    const output = executeExternalProvider({
      provider: supervisor,
      args: ["--builder", builder, "--request", requestPath, "--output", resultPath,
        "--source-repository-root", request.source_repository_root,
        "--tooling-root", request.tooling_root, "--handoff-root", request.handoff_root,
        "--quarantine-root", request.quarantine_root,
        "--operation-id", request.operation_id],
      cwd: request.tooling_root,
      forbiddenRoots: [request.source_repository_root, request.tooling_root],
      env: positiveEnvironment({ env, overrides: {
        COORDINATED_BUILD_REQUEST: requestPath,
        COORDINATED_BUILD_OUTPUT: resultPath,
        COORDINATED_REGISTRY_REMOTE: request.registry_remote,
        COORDINATED_HANDOFF_ROOT: request.handoff_root
      }, names: ["PATH", "HOME", "TMPDIR", "RUNNER_TEMP", "CI", "GITHUB_ACTIONS", "GITHUB_RUN_ID",
         "ANDROID_HOME", "ANDROID_SDK_ROOT", "JAVA_HOME", "PNPM_HOME", "NVM_BIN",
         "COORDINATED_HANDOFF_ROOT", "COORDINATED_ISOLATED_BUILD_GATE",
         "COORDINATED_ISOLATED_BUILD_GATE_SHA256"] })
    });
    let result;
    try {
      result = readJson(resultPath);
    } catch {
      const lastLine = output.trim().split(/\r?\n/u).at(-1);
      result = lastLine ? JSON.parse(lastLine) : null;
    }
    const manifest = validateUnsignedBuildResult(result, request);
    return { ...manifest, status: "ok", observed_at_utc: now };
  } catch (error) {
    return {
      schema_version: 1,
      kind: "ash-atlas-coordinated-unsigned-build-result",
      status: "ACTION_REQUIRED",
      code: ACTION_REQUIRED_PROVISION_ISOLATED_BUILD,
      operation_id: request.operation_id,
      generation: request.generation,
      source_sha: request.source_sha,
      reason: safeProvisioningReason(error),
      observed_at_utc: now
    };
  }
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
  const request = buildUnsignedRequest({
    operationId: required(args, "operation-id"),
    generation: required(args, "generation"),
    sourceSha: required(args, "source-sha"),
    sourceRepositoryRoot: required(args, "source-repository-root"),
    toolingRoot: required(args, "tooling-root"),
    registryRemote: required(args, "registry-remote"),
    reservedVersions: args["reserved-versions-file"] ? readJson(args["reserved-versions-file"]) :
      JSON.parse(required(args, "reserved-versions")),
    protocol: { min: Number(required(args, "protocol-min")), max: Number(required(args, "protocol-max")) },
    pushConfig: args["push-config-file"] ? readJson(args["push-config-file"]) : null,
    quarantineRoot: required(args, "quarantine-root")
  });
  const result = runUnsignedBuild({ request });
  const outputPath = assertOutsideRoots(required(args, "output"),
    [request.source_repository_root, request.tooling_root]);
  writeJsonAtomic(outputPath, result);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== "ok") process.exitCode = 1;
}

function requireState(condition, message) {
  if (!condition) throw new Error(message);
}

function unsignedManifestFingerprint(manifest) {
  const copy = structuredClone(manifest);
  delete copy.manifest_sha256;
  return createHash("sha256").update(JSON.stringify(copy)).digest("hex");
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function reservationFor(reservedVersions, platform) {
  const reservation = reservedVersions?.[platform];
  requireState(reservation && typeof reservation === "object" && !Array.isArray(reservation),
    `${platform} unsigned artifact reservation is missing`);
  requireState(Number.isInteger(Number(reservation.build)) && Number(reservation.build) > 0,
    `${platform} unsigned artifact reservation build is invalid`);
  requireState(typeof (reservation.marketingVersion ?? reservation.marketing_version) === "string" &&
    (reservation.marketingVersion ?? reservation.marketing_version).length > 0,
  `${platform} unsigned artifact reservation marketing version is invalid`);
  return reservation;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(); } catch (error) {
    console.error(safeProvisioningReason(error));
    process.exitCode = 1;
  }
}
