import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  ACTION_REQUIRED_PROVISION_ISOLATED_BUILD,
  assertOutsideRoots,
  BUILD_BOUNDARY_PATTERNS,
  artifactSha256,
  executeExternalProvider,
  quarantineArtifact,
  readJson,
  safeProvisioningReason,
  scopedEnvironment,
  writeJsonAtomic
} from "./coordinated-build-boundary.mjs";

const { SHA, GENERATION, OPERATION_ID } = BUILD_BOUNDARY_PATTERNS;
const PLATFORMS = ["ios", "android"];

/**
 * Validate an unsigned manifest before it enters a trusted signing boundary.
 * The signer receives only a manifest and quarantine files.  It never receives
 * the game checkout and this module never invokes Xcode, Gradle, or game code.
 */
export function validateUnsignedManifest(manifest) {
  requireState(manifest?.schema_version === 1 &&
    manifest.kind === "ash-atlas-coordinated-unsigned-artifact-manifest",
  "unsigned artifact manifest schema is invalid");
  requireState(OPERATION_ID.test(manifest.operation_id) && GENERATION.test(manifest.generation) &&
    SHA.test(manifest.source_sha), "unsigned artifact manifest identity is invalid");
  requireState(isAbsolute(manifest.source_repository_root) && isAbsolute(manifest.tooling_root) &&
    isAbsolute(manifest.quarantine_root),
    "unsigned artifact manifest roots must be absolute");
  requireState(typeof manifest.registry_remote === "string" &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(manifest.registry_remote),
  "unsigned artifact manifest registry remote is invalid");
  requireState(manifest.reserved_versions && typeof manifest.reserved_versions === "object" &&
    !Array.isArray(manifest.reserved_versions),
  "unsigned artifact manifest reservation policy is invalid");
  requireState(manifest.protocol && Number.isInteger(manifest.protocol.min) &&
    Number.isInteger(manifest.protocol.max) && manifest.protocol.min <= manifest.protocol.max,
  "unsigned artifact manifest protocol policy is invalid");
  requireState(Array.isArray(manifest.artifacts) && manifest.artifacts.length === 2,
    "unsigned artifact manifest must contain both platforms");
  const seen = new Set();
  const artifacts = manifest.artifacts.map((artifact) => {
    requireState(artifact && PLATFORMS.includes(artifact.platform) && !seen.has(artifact.platform),
      "unsigned artifact manifest has invalid or duplicate platform");
    seen.add(artifact.platform);
    requireState(artifact.kind === (artifact.platform === "ios" ? "xcarchive" : "aab"),
      `${artifact.platform} unsigned artifact kind is invalid`);
    const reserved = manifest.reserved_versions[artifact.platform];
    const marketingVersion = String(artifact.marketing_version ?? artifact.marketingVersion ?? "");
    const build = Number(artifact.build);
    requireState(reserved && marketingVersion === String(reserved.marketingVersion ?? reserved.marketing_version ?? ""),
      `${artifact.platform} unsigned artifact marketing version does not match its reservation`);
    requireState(Number.isInteger(build) && build > 0 && build === Number(reserved.build),
      `${artifact.platform} unsigned artifact build does not match its reservation`);
    const path = quarantineArtifact(artifact.path, manifest.quarantine_root,
      `${artifact.platform} unsigned artifact`, artifact.kind,
      [manifest.source_repository_root, manifest.tooling_root]);
    requireState(artifact.sha256 === artifactSha256(path) && /^[0-9a-f]{64}$/u.test(artifact.sha256),
      `${artifact.platform} unsigned artifact hash is invalid`);
    return { ...artifact, path, marketing_version: marketingVersion, build };
  });
  requireState(PLATFORMS.every((platform) => seen.has(platform)),
    "unsigned artifact manifest must contain one iOS and one Android artifact");
  const normalized = { ...structuredClone(manifest), artifacts };
  requireState(/^[0-9a-f]{64}$/u.test(normalized.manifest_sha256) &&
    normalized.manifest_sha256 === unsignedManifestFingerprint(normalized),
  "unsigned artifact manifest fingerprint is invalid");
  return normalized;
}

export function validateSignedArtifactResult(result, request, unsigned) {
  requireState(result?.schema_version === 1 &&
    ["ash-atlas-coordinated-signed-artifact-result",
      "ash-atlas-coordinated-signed-artifact-manifest"].includes(result.kind) &&
    result.status === "ok",
  "signed artifact result schema is invalid");
  requireState(result.operation_id === request.operation_id &&
    result.generation === request.generation && result.source_sha === request.source_sha,
  "signed artifact result is not bound to the request");
  requireState(request.unsigned_manifest_sha256 === unsigned.manifest_sha256 &&
    result.unsigned_manifest_sha256 === request.unsigned_manifest_sha256,
  "signed artifact result is not bound to the exact unsigned manifest");
  requireState(Array.isArray(result.artifacts) && result.artifacts.length === 2,
    "signed artifact result must contain both platforms");
  const unsignedByPlatform = new Map(unsigned.artifacts.map((artifact) => [artifact.platform, artifact]));
  const seen = new Set();
  const artifacts = result.artifacts.map((artifact) => {
    const source = unsignedByPlatform.get(artifact?.platform);
    requireState(source && !seen.has(artifact.platform), "signed artifact platform is invalid or duplicated");
    seen.add(artifact.platform);
    const expectedKind = artifact.platform === "ios" ? "ipa" : "aab";
    requireState(artifact.kind === expectedKind, `${artifact.platform} signed artifact kind is invalid`);
    const path = quarantineArtifact(artifact.signed_path, request.signed_quarantine_root,
      `${artifact.platform} signed artifact`, artifact.kind,
      [request.tooling_root]);
    requireState(/^[0-9a-f]{64}$/u.test(artifact.sha256) && artifact.sha256 === artifactSha256(path),
      `${artifact.platform} signed artifact hash is invalid`);
    requireState(path !== source.path, `${artifact.platform} signed artifact must be a distinct persisted file`);
    return { platform: artifact.platform, kind: artifact.kind, signed_path: path, sha256: artifact.sha256,
      unsigned_sha256: source.sha256 };
  });
  requireState(PLATFORMS.every((platform) => seen.has(platform)),
    "signed artifact result must contain one iOS and one Android artifact");
  const normalized = {
    schema_version: 1,
    kind: "ash-atlas-coordinated-signed-artifact-manifest",
    operation_id: request.operation_id,
    generation: request.generation,
    source_sha: request.source_sha,
    unsigned_manifest_sha256: request.unsigned_manifest_sha256,
    tooling_root: request.tooling_root,
    signed_quarantine_root: request.signed_quarantine_root,
    artifacts
  };
  return { ...normalized,
    manifest_sha256: createHash("sha256").update(JSON.stringify(normalized)).digest("hex") };
}

export function runTrustedSigning({
  request,
  unsignedManifest,
  env = process.env,
  signer = env.COORDINATED_TRUSTED_SIGNER,
  now = new Date().toISOString()
}) {
  const work = mkdtempSync(join(tmpdir(), "ash-atlas-sign-artifacts-"));
  const requestPath = join(work, "request.json");
  const resultPath = join(work, "result.json");
  try {
    requireState(isAbsolute(request.tooling_root) && isAbsolute(request.signed_quarantine_root),
      "trusted signing roots must be absolute");
    const normalizedUnsigned = validateUnsignedManifest(unsignedManifest);
    assertOutsideRoots(request.signed_quarantine_root,
      [normalizedUnsigned.source_repository_root, request.tooling_root], "signed quarantine root");
    requireState(normalizedUnsigned.operation_id === request.operation_id &&
      normalizedUnsigned.generation === request.generation &&
      normalizedUnsigned.source_sha === request.source_sha &&
      normalizedUnsigned.tooling_root === resolve(request.tooling_root),
    "unsigned artifact manifest identity does not match the signing request");
    requireState(request.source_repository_root === undefined ||
      normalizedUnsigned.source_repository_root === resolve(request.source_repository_root),
    "unsigned artifact manifest source root does not match the signing request");
    requireState(request.registry_remote === undefined ||
      normalizedUnsigned.registry_remote === request.registry_remote,
    "unsigned artifact manifest registry remote does not match the signing request");
    requireState(request.reserved_versions === undefined ||
      sameJson(normalizedUnsigned.reserved_versions, request.reserved_versions),
    "unsigned artifact manifest reservation policy does not match the signing request");
    requireState(request.protocol === undefined || sameJson(normalizedUnsigned.protocol, request.protocol),
      "unsigned artifact manifest protocol policy does not match the signing request");
    const unsignedManifestSha256 = normalizedUnsigned.manifest_sha256;
    if (typeof signer !== "string" || !isAbsolute(signer)) {
      throw new Error(`${ACTION_REQUIRED_PROVISION_ISOLATED_BUILD}: a controller-owned signer is required before upload intent`);
    }
    const requestWithManifest = { ...request,
      unsigned_manifest_sha256: unsignedManifestSha256,
      unsigned_manifest: normalizedUnsigned };
    writeJsonAtomic(requestPath, requestWithManifest);
    executeExternalProvider({
      provider: signer,
      args: ["--request", requestPath, "--output", resultPath],
      cwd: request.tooling_root,
      forbiddenRoots: [request.source_repository_root, request.tooling_root].filter(Boolean),
      env: scopedEnvironment({ env, names: [
        "PATH", "HOME", "TMPDIR", "RUNNER_TEMP", "CI", "GITHUB_ACTIONS", "GITHUB_RUN_ID",
        "APPLE_DISTRIBUTION_P12_BASE64", "APPLE_DISTRIBUTION_P12_PASSWORD",
        "APPLE_PROVISIONING_PROFILE_BASE64", "APPLE_PROVISIONING_PROFILE_SPECIFIER", "APPLE_TEAM_ID",
        "ANDROID_UPLOAD_KEYSTORE_BASE64", "ANDROID_UPLOAD_KEYSTORE_PASSWORD",
        "ANDROID_UPLOAD_KEY_ALIAS", "ANDROID_UPLOAD_KEY_PASSWORD", "ANDROID_UPLOAD_KEY_FINGERPRINT"
      ], overrides: {
        COORDINATED_SIGN_REQUEST: requestPath,
        COORDINATED_SIGN_OUTPUT: resultPath
      } })
    });
    const result = readJson(resultPath);
    const manifest = validateSignedArtifactResult(result,
      { ...request, unsigned_manifest_sha256: unsignedManifestSha256 }, normalizedUnsigned);
    return { ...manifest, status: "ok", observed_at_utc: now };
  } catch (error) {
    return {
      schema_version: 1,
      kind: "ash-atlas-coordinated-signed-artifact-result",
      status: "ACTION_REQUIRED",
      code: ACTION_REQUIRED_PROVISION_ISOLATED_BUILD,
      operation_id: request.operation_id,
      generation: request.generation,
      source_sha: request.source_sha,
      reason: safeProvisioningReason(error),
      observed_at_utc: now
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
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
  const unsigned = readJson(required(args, "unsigned-manifest"));
  const request = {
    schema_version: 1,
    kind: "ash-atlas-coordinated-sign-request",
    operation_id: required(args, "operation-id"),
    generation: required(args, "generation"),
    source_sha: required(args, "source-sha"),
    source_repository_root: unsigned.source_repository_root,
    registry_remote: unsigned.registry_remote,
    reserved_versions: unsigned.reserved_versions,
    protocol: unsigned.protocol,
    tooling_root: resolve(required(args, "tooling-root")),
    signed_quarantine_root: resolve(required(args, "signed-quarantine-root"))
  };
  const result = runTrustedSigning({ request, unsignedManifest: unsigned });
  const outputPath = assertOutsideRoots(required(args, "output"), [request.tooling_root]);
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
  delete copy.status;
  delete copy.observed_at_utc;
  return createHash("sha256").update(JSON.stringify(copy)).digest("hex");
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(); } catch (error) {
    console.error(safeProvisioningReason(error));
    process.exitCode = 1;
  }
}
