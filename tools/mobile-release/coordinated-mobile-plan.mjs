import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateProductionMetadataPacket } from "./production.mjs";
import {
  assertBuildIdentity,
  assertOutsideRoots,
  BUILD_BOUNDARY_PATTERNS,
  readJson,
  writeJsonAtomic
} from "./coordinated-build-boundary.mjs";
import { DAILY_TESTER_MODE, readTesterDeliveryMode, readTesterDestination } from "./coordinated-mobile-testers.mjs";

const { SHA, OPERATION_ID } = BUILD_BOUNDARY_PATTERNS;
const PLATFORMS = ["ios", "android"];
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const MATERIALIZED_PLAN_KIND = "ash-atlas-coordinated-mobile-bootstrap-plan";
const MATERIALIZED_VERSIONS_KIND = "ash-atlas-coordinated-mobile-reserved-versions";

/**
 * Derive immutable per-operation controller inputs from protected metadata
 * packets and authoritative distributed-source history. The registry later
 * allocates the independent numeric build numbers. Output paths are
 * operation-scoped and may be reused only when their full identity and packet
 * hashes still match.
 */
export function materializeCoordinatedPlan({
  operationId,
  generation,
  serverSha,
  registryRemote,
  acceptedMasterSha,
  currentServerSha,
  sourceRepositoryRoot,
  toolingRoot,
  handoffRoot,
  metadataPacketPaths,
  distributedSources = null,
  approvedVersionPlan = null,
  now = new Date().toISOString()
}) {
  assertBuildIdentity({ operationId, generation, sourceSha: serverSha,
    sourceRepositoryRoot, toolingRoot, registryRemote });
  requireState(SHA.test(String(acceptedMasterSha ?? "")), "accepted master SHA is invalid");
  requireState(SHA.test(String(currentServerSha ?? "")), "current server SHA is invalid");
  requireState(Number.isFinite(Date.parse(now)), "materialized plan timestamp is invalid");
  requireState(isAbsolute(handoffRoot), "handoffRoot must be absolute");
  assertOutsideRoots(handoffRoot, [sourceRepositoryRoot, toolingRoot], "durable handoff root");

  const operationRoot = operationHandoffRoot(handoffRoot, operationId);
  assertOutsideRoots(operationRoot, [sourceRepositoryRoot, toolingRoot], "operation input root");
  mkdirSync(operationRoot, { recursive: true, mode: 0o700 });

  const metadataRoot = join(operationRoot, "metadata");
  mkdirSync(metadataRoot, { recursive: true, mode: 0o700 });
  const paths = {
    operationRoot,
    planPath: join(operationRoot, "coordinated-plan.json"),
    reservedVersionsPath: join(operationRoot, "reserved-versions.json"),
    manifestPath: join(operationRoot, "materialized-inputs.json")
  };
  const sourcePackets = Object.fromEntries(PLATFORMS.map((platform) => {
    const packetPath = resolve(String(metadataPacketPaths?.[platform] ?? ""));
    requireState(isAbsolute(packetPath), `${platform} metadata packet path must be absolute`);
    assertOutsideRoots(packetPath, [sourceRepositoryRoot, toolingRoot, operationRoot],
      `${platform} metadata packet`);
    requireState(existsSync(packetPath) && statSync(packetPath).isFile() && statSync(packetPath).size > 0,
      `${platform} metadata packet is unavailable`);
    const bytes = readFileSync(packetPath);
    let raw;
    try { raw = JSON.parse(bytes.toString("utf8")); } catch {
      throw new Error(`${platform} metadata packet must be UTF-8 JSON`);
    }
    const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
    const testerDestination = readTesterDestination(platform, raw);
    return [platform, { packetPath, raw, sourceSha256, testerDestination }];
  }));
  const deliveryModes = [...new Set(PLATFORMS.map((platform) =>
    readTesterDeliveryMode(sourcePackets[platform].raw)))];
  requireState(deliveryModes.length <= 1,
    "mobile delivery mode must be the same for both platform packets");
  const deliveryMode = deliveryModes[0] ?? null;
  if (deliveryMode !== null) requireState(deliveryMode === DAILY_TESTER_MODE,
    "unsupported coordinated mobile delivery mode");
  if (deliveryMode === DAILY_TESTER_MODE) {
    for (const platform of PLATFORMS) requireState(sourcePackets[platform].testerDestination,
      `${platform} daily tester destination is required in its metadata packet`);
  } else {
    for (const platform of PLATFORMS) requireState(!sourcePackets[platform].testerDestination,
      `${platform} tester destination requires daily tester delivery mode`);
  }
  const existing = readExistingMaterialization({ paths, operationId, generation, serverSha,
    registryRemote, acceptedMasterSha, currentServerSha, sourcePackets });
  if (existing) return existing;
  const versionPlan = deriveVersionPlan({ operationId, generation, serverSha, acceptedMasterSha,
    currentServerSha, distributedSources, approvedVersionPlan, deliveryMode,
    packetVersions: Object.fromEntries(PLATFORMS.map((platform) => [platform,
      sourcePackets[platform].raw.marketingVersion])) });
  const packets = Object.fromEntries(PLATFORMS.map((platform) => {
    const { packetPath, raw, sourceSha256 } = sourcePackets[platform];
    const plannedVersion = versionPlan[platform].marketingVersion;
    const materializedRaw = raw.marketingVersion === plannedVersion ? raw :
      { ...raw, marketingVersion: plannedVersion };
    const packet = validateProductionMetadataPacket(platform, materializedRaw);
    const materializedBytes = Buffer.from(`${JSON.stringify(materializedRaw)}\n`, "utf8");
    const materializedPath = join(metadataRoot, `${platform}.json`);
    writeBytesOrVerify(materializedPath, materializedBytes, `${platform} metadata packet`);
    const sha256 = createHash("sha256").update(materializedBytes).digest("hex");
    return [platform, { path: materializedPath, sourcePath: packetPath, packet, sha256, sourceSha256 }];
  }));

  const plan = {
    schemaVersion: 1,
    kind: MATERIALIZED_PLAN_KIND,
    operation_id: operationId,
    pinned: { generation, server_sha: serverSha, registry_remote: registryRemote,
      accepted_master_sha: acceptedMasterSha, current_server_sha: currentServerSha },
    ...(deliveryMode ? { delivery_mode: deliveryMode } : {}),
    apps: Object.fromEntries(PLATFORMS.map((platform) => {
      const { path, packet, sha256 } = packets[platform];
      const testerDestination = sourcePackets[platform].testerDestination;
      return [platform, {
        metadata_packet_path: path,
        metadata_sha256: sha256,
        marketing_version: packet.marketingVersion,
        countries: [...packet.policy.countries],
        rollout: structuredClone(packet.policy.rollout),
        ...(testerDestination ? { tester_destination: testerDestination } : {}),
        ...(platform === "android" ? {
          ...(deliveryMode === DAILY_TESTER_MODE ? {} : { managed_publishing: true }),
          first_publication_bootstrap_verified: packet.policy.rollout.kind === "first-publish"
        } : {})
      }];
    })),
    version_plan: structuredClone(versionPlan)
  };
  const reservedVersions = {
    schemaVersion: 1,
    kind: MATERIALIZED_VERSIONS_KIND,
    operation_id: operationId,
    pinned: structuredClone(plan.pinned),
    ios: { marketingVersion: packets.ios.packet.marketingVersion },
    android: { marketingVersion: packets.android.packet.marketingVersion }
  };
  const manifest = {
    schemaVersion: 1,
    kind: "ash-atlas-coordinated-mobile-materialized-inputs",
    operation_id: operationId,
    pinned: structuredClone(plan.pinned),
    packets: Object.fromEntries(PLATFORMS.map((platform) => [platform, {
      path: packets[platform].path, sha256: packets[platform].sha256,
      source_path: packets[platform].sourcePath, source_sha256: packets[platform].sourceSha256,
      marketing_version: packets[platform].packet.marketingVersion
    }])),
    version_plan: structuredClone(versionPlan),
    plan_sha256: jsonSha256(plan),
    reserved_versions_sha256: jsonSha256(reservedVersions)
  };
  writeOrVerify(paths.planPath, plan, "coordinated plan");
  writeOrVerify(paths.reservedVersionsPath, reservedVersions, "reserved versions");
  writeOrVerify(paths.manifestPath, manifest, "materialized input manifest");
  return { ...paths, plan, reservedVersions, manifest };
}

function readExistingMaterialization({ paths, operationId, generation, serverSha, registryRemote,
  acceptedMasterSha, currentServerSha, sourcePackets }) {
  const durablePaths = [paths.planPath, paths.reservedVersionsPath, paths.manifestPath];
  const present = durablePaths.map((path) => existsSync(path));
  if (!present.some(Boolean)) return null;
  requireState(present.every(Boolean), "materialized input files are incomplete for the active operation");
  const plan = readJson(paths.planPath);
  const reservedVersions = readJson(paths.reservedVersionsPath);
  const manifest = readJson(paths.manifestPath);
  const pinned = { generation, server_sha: serverSha, registry_remote: registryRemote,
    accepted_master_sha: acceptedMasterSha, current_server_sha: currentServerSha };
  assertDurableIdentity(plan, MATERIALIZED_PLAN_KIND, operationId, pinned, "coordinated plan");
  assertDurableIdentity(reservedVersions, MATERIALIZED_VERSIONS_KIND, operationId, pinned,
    "reserved versions");
  assertDurableIdentity(manifest, "ash-atlas-coordinated-mobile-materialized-inputs", operationId,
    pinned, "materialized input manifest");
  requireState(manifest.plan_sha256 === jsonSha256(plan),
    "coordinated plan fingerprint changed for the active operation");
  requireState(manifest.reserved_versions_sha256 === jsonSha256(reservedVersions),
    "reserved versions fingerprint changed for the active operation");
  const expectedDeliveryModes = [...new Set(PLATFORMS.map((platform) =>
    readTesterDeliveryMode(sourcePackets[platform].raw)))];
  requireState(expectedDeliveryModes.length <= 1 &&
    (plan.delivery_mode ?? null) === (expectedDeliveryModes[0] ?? null),
  "coordinated delivery mode changed for the active operation");
  for (const platform of PLATFORMS) {
    const source = sourcePackets[platform];
    const packetEntry = manifest.packets?.[platform];
    const app = plan.apps?.[platform];
    const reserved = reservedVersions[platform];
    const materializedPath = join(paths.operationRoot, "metadata", `${platform}.json`);
    requireState(packetEntry && app && reserved,
      `${platform} materialized input identity is incomplete`);
    requireState(resolve(packetEntry.source_path) === source.packetPath &&
      packetEntry.source_sha256 === source.sourceSha256,
    `${platform} metadata packet changed for the active operation`);
    requireState(resolve(packetEntry.path) === materializedPath &&
      resolve(app.metadata_packet_path) === materializedPath &&
      existsSync(materializedPath),
    `${platform} operation metadata packet is unavailable or moved`);
    const bytes = readFileSync(materializedPath);
    requireState(createHash("sha256").update(bytes).digest("hex") === packetEntry.sha256,
      `${platform} operation metadata packet fingerprint changed`);
    let raw;
    try { raw = JSON.parse(bytes.toString("utf8")); } catch {
      throw new Error(`${platform} operation metadata packet is not valid UTF-8 JSON`);
    }
    const packet = validateProductionMetadataPacket(platform, raw);
    const testerDestination = readTesterDestination(platform, raw);
    requireState(app.metadata_sha256 === packetEntry.sha256 &&
      app.marketing_version === packet.marketingVersion &&
      sameJson(app.countries, packet.policy.countries) &&
      sameJson(app.rollout, packet.policy.rollout) &&
      sameJson(app.tester_destination ?? null, testerDestination) &&
      reserved.marketingVersion === packet.marketingVersion &&
      manifest.version_plan?.[platform]?.marketingVersion === packet.marketingVersion,
    `${platform} durable candidate policy changed for the active operation`);
  }
  return { ...paths, plan, reservedVersions, manifest };
}

function assertDurableIdentity(value, kind, operationId, pinned, label) {
  requireState(value && value.schemaVersion === 1 && value.kind === kind &&
    value.operation_id === operationId && sameJson(value.pinned, pinned),
  `${label} identity changed for the active operation`);
}

export function operationHandoffRoot(handoffRoot, operationId) {
  requireState(isAbsolute(handoffRoot), "handoffRoot must be absolute");
  requireState(OPERATION_ID.test(String(operationId ?? "")), "operation ID is invalid");
  const segment = operationId.replace(/[^A-Za-z0-9._-]/gu, "-").slice(0, 80) || "operation";
  const suffix = createHash("sha256").update(operationId).digest("hex").slice(0, 12);
  return join(resolve(handoffRoot), `${segment}-${suffix}`);
}

function deriveVersionPlan({ operationId, generation, serverSha, acceptedMasterSha,
  currentServerSha, distributedSources, approvedVersionPlan, packetVersions, deliveryMode }) {
  if (approvedVersionPlan !== null) {
    validateApprovedVersionPlan(approvedVersionPlan, { operationId, generation, serverSha,
      acceptedMasterSha, currentServerSha });
  }
  const result = {};
  for (const platform of PLATFORMS) {
    const override = approvedVersionPlan?.versions?.[platform] ?? approvedVersionPlan?.[platform];
    const source = distributedSources?.[platform] ?? null;
    const sourceVersion = source?.marketingVersion ?? source?.marketing_version;
    const requestedVersion = override?.marketingVersion ?? override?.marketing_version;
    if (requestedVersion !== undefined) {
      requireState(VERSION.test(String(requestedVersion)), `${platform} approved marketing version is invalid`);
      if (deliveryMode !== DAILY_TESTER_MODE && sourceVersion !== undefined) requireState(compareVersion(String(requestedVersion), String(sourceVersion)) > 0,
        `${platform} approved marketing version must be newer than the authoritative distributed source`);
      result[platform] = {
        marketingVersion: String(requestedVersion), basis: "approved-override",
        ...(sourceVersion !== undefined ? { sourceMarketingVersion: String(sourceVersion) } : {}),
        ...(override?.approval_sha256 ? { approvalSha256: String(override.approval_sha256) } : {})
      };
      continue;
    }
    if (deliveryMode === DAILY_TESTER_MODE) {
      const configuredVersion = packetVersions?.[platform];
      requireState(VERSION.test(String(configuredVersion)), `${platform} configured marketing version is invalid`);
      result[platform] = { marketingVersion: String(configuredVersion), basis: "configured-packet" };
      continue;
    }
    requireState(source && VERSION.test(String(sourceVersion)),
      `${platform} requires an authoritative distributed-source snapshot or an operation-bound version override`);
    const packetVersion = packetVersions?.[platform];
    const base = packetVersion && VERSION.test(String(packetVersion)) ? String(packetVersion) : String(sourceVersion);
    const planned = compareVersion(base, String(sourceVersion)) > 0 ? base : bumpPatch(String(sourceVersion));
    result[platform] = { marketingVersion: planned, basis: "distributed-source",
      sourceMarketingVersion: String(sourceVersion), sourceReleaseId: source.releaseId ?? source.release_id ?? null };
  }
  return result;
}

function validateApprovedVersionPlan(plan, identity) {
  requireState(plan && plan.schemaVersion === 1 &&
    plan.kind === "ash-atlas-coordinated-mobile-version-plan" &&
    plan.operation_id === identity.operationId,
  "approved version plan identity is invalid");
  requireState(plan.pinned?.generation === identity.generation &&
    plan.pinned.server_sha === identity.serverSha &&
    plan.pinned.accepted_master_sha === identity.acceptedMasterSha &&
    plan.pinned.current_server_sha === identity.currentServerSha,
  "approved version plan pinned identity changed");
  requireState(plan.versions && typeof plan.versions === "object" &&
    PLATFORMS.every((platform) => plan.versions[platform]),
  "approved version plan must contain both platforms");
}

function bumpPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/u.exec(version);
  requireState(match, "automatic marketing version planning requires a numeric release version");
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function compareVersion(left, right) {
  const leftParts = numericVersion(left);
  const rightParts = numericVersion(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function numericVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/u.exec(String(value));
  requireState(match, "marketing version must contain three numeric components");
  return match.slice(1, 4).map(Number);
}

export function materializedPlanPaths({ handoffRoot, operationId }) {
  const operationRoot = operationHandoffRoot(handoffRoot, operationId);
  return { operationRoot, planPath: join(operationRoot, "coordinated-plan.json"),
    reservedVersionsPath: join(operationRoot, "reserved-versions.json"),
    manifestPath: join(operationRoot, "materialized-inputs.json") };
}

function writeOrVerify(path, value, label) {
  if (existsSync(path)) {
    const existing = readJson(path);
    requireState(jsonSha256(existing) === jsonSha256(value), `${label} changed for the active operation`);
    return;
  }
  writeJsonAtomic(path, value);
}

function writeBytesOrVerify(path, bytes, label) {
  if (existsSync(path)) {
    const existing = readFileSync(path);
    requireState(createHash("sha256").update(existing).digest("hex") ===
      createHash("sha256").update(bytes).digest("hex"), `${label} changed for the active operation`);
    return;
  }
  writeFileSync(path, bytes, { encoding: "utf8", mode: 0o600 });
}

function jsonSha256(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requireState(condition, message) {
  if (!condition) throw new Error(message);
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
  const distributedSourcesPath = args["distributed-sources-file"];
  const approvedVersionPath = args["approved-version-file"];
  const result = materializeCoordinatedPlan({
    operationId: required(args, "operation-id"), generation: required(args, "generation"),
    serverSha: required(args, "server-sha"), registryRemote: required(args, "registry-remote"),
    acceptedMasterSha: required(args, "accepted-master-sha"),
    currentServerSha: required(args, "current-server-sha"),
    sourceRepositoryRoot: required(args, "source-repository-root"),
    toolingRoot: required(args, "tooling-root"), handoffRoot: required(args, "handoff-root"),
    metadataPacketPaths: { ios: required(args, "ios-metadata-packet"), android: required(args, "android-metadata-packet") },
    distributedSources: distributedSourcesPath ? readJson(resolve(distributedSourcesPath)).distributedSources ??
      readJson(resolve(distributedSourcesPath)) : null,
    approvedVersionPlan: approvedVersionPath ? readJson(resolve(approvedVersionPath)) : null
  });
  const outputPath = required(args, "output");
  assertOutsideRoots(outputPath, [result.operationRoot], "materialized input result");
  writeJsonAtomic(outputPath, { schemaVersion: 1, kind: "ash-atlas-coordinated-mobile-materializer-result",
    operation_id: result.manifest.operation_id, operation_root: result.operationRoot,
    plan_path: result.planPath, reserved_versions_path: result.reservedVersionsPath,
    manifest_path: result.manifestPath, plan_sha256: result.manifest.plan_sha256,
    reserved_versions_sha256: result.manifest.reserved_versions_sha256 });
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT,
      `operation_root=${result.operationRoot}\nplan_path=${result.planPath}\n` +
      `reserved_versions_path=${result.reservedVersionsPath}\nmanifest_path=${result.manifestPath}\n`, { encoding: "utf8" });
  }
  process.stdout.write(`${JSON.stringify({ status: "ok", operation_id: result.manifest.operation_id,
    plan_path: result.planPath, reserved_versions_path: result.reservedVersionsPath })}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
