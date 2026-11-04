import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const SHA = /^[0-9a-f]{40}$/u;
const GENERATION = /^t\d{3,4}$/u;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const BUNDLE_ID = "com.ashatlas.game";

/**
 * Trusted Mac signer for the private control repository.  This adapter only
 * consumes a validated unsigned manifest and never checks out or executes the
 * game source.  Xcode export and jarsigner are controller-owned tools; store
 * submission remains in the separate trusted store adapter.
 */
export async function runMacTrustedSigning({
  request,
  unsignedManifest,
  env = process.env,
  platform = process.platform,
  commandRunner = defaultCommandRunner,
  boundary = null,
  validator = null
}) {
  assertRequest(request);
  if (platform !== "darwin") throw new Error("ACTION_REQUIRED_PROVISION_ISOLATED_BUILD: trusted Mac signer is required");
  const boundaryModule = boundary ?? await loadBoundary(request.tooling_root);
  const signingModule = validator ?? await loadSigningModule(request.tooling_root);
  const unsigned = signingModule.validateUnsignedManifest(unsignedManifest);
  requireState(unsigned.operation_id === request.operation_id && unsigned.generation === request.generation &&
    unsigned.source_sha === request.source_sha && unsigned.tooling_root === resolve(request.tooling_root),
  "unsigned manifest is not bound to the trusted signing request");
  requireState(unsigned.source_repository_root === undefined ||
    request.source_repository_root === undefined ||
    unsigned.source_repository_root === resolve(request.source_repository_root),
  "unsigned manifest source root changed");
  const work = mkdtempSync(join(tmpdir(), `ash-atlas-${request.operation_id}-sign-`));
  let appleCleanup = null;
  try {
    appleCleanup = prepareAppleSigning({ env, work, commandRunner });
    const ios = signIos({ request, unsigned, env, work, commandRunner, boundaryModule });
    const android = signAndroid({ request, unsigned, env, work, commandRunner, boundaryModule });
    return {
      schema_version: 1,
      kind: "ash-atlas-coordinated-signed-artifact-result",
      status: "ok",
      operation_id: request.operation_id,
      generation: request.generation,
      source_sha: request.source_sha,
      unsigned_manifest_sha256: unsigned.manifest_sha256,
      tooling_root: request.tooling_root,
      signed_quarantine_root: request.signed_quarantine_root,
      artifacts: [ios, android]
    };
  } finally {
    if (appleCleanup) restoreAppleSigning(appleCleanup, commandRunner);
    rmSync(work, { recursive: true, force: true });
  }
}

function signIos({ request, unsigned, env, work, commandRunner, boundaryModule }) {
  const source = unsigned.artifacts.find((artifact) => artifact.platform === "ios");
  requireState(source?.kind === "xcarchive", "unsigned iOS archive is missing");
  const archive = boundaryModule.quarantineArtifact(source.path, unsigned.quarantine_root,
    "unsigned iOS archive", "xcarchive", [request.tooling_root]);
  const exportOptions = join(work, "ExportOptions.plist");
  writeFileSync(exportOptions, exportOptionsPlist(env), { encoding: "utf8", mode: 0o600 });
  const exportRoot = join(work, "ios-export");
  mkdirSync(exportRoot, { recursive: true, mode: 0o700 });
  run(commandRunner, "xcodebuild", ["-exportArchive", "-archivePath", archive,
    "-exportPath", exportRoot, "-exportOptionsPlist", exportOptions], work, env);
  const ipa = findSingleFile(exportRoot, ".ipa", "exported iOS IPA");
  const destination = join(request.signed_quarantine_root, "artifacts", "ios", "AshAtlas.ipa");
  persistFile(boundaryModule, ipa, destination, "signed iOS IPA");
  const path = boundaryModule.quarantineArtifact(destination, request.signed_quarantine_root,
    "signed iOS IPA", "ipa", [request.tooling_root]);
  verifyFinalArtifact({ request, unsigned, source, env, work, commandRunner, artifactPath: path });
  return { platform: "ios", kind: "ipa", signed_path: path,
    sha256: boundaryModule.artifactSha256(path), unsigned_sha256: source.sha256 };
}

function signAndroid({ request, unsigned, env, work, commandRunner, boundaryModule }) {
  const source = unsigned.artifacts.find((artifact) => artifact.platform === "android");
  requireState(source?.kind === "aab", "unsigned Android bundle is missing");
  const input = boundaryModule.quarantineArtifact(source.path, unsigned.quarantine_root,
    "unsigned Android bundle", "aab", [request.tooling_root]);
  const keystore = join(work, "upload.jks");
  const keyStoreBytes = decodeSecret(env.ANDROID_UPLOAD_KEYSTORE_BASE64, "Android upload keystore");
  writeFileSync(keystore, keyStoreBytes, { mode: 0o600 });
  requireState(typeof env.ANDROID_UPLOAD_KEYSTORE_PASSWORD === "string" &&
    env.ANDROID_UPLOAD_KEYSTORE_PASSWORD.length > 0 &&
    typeof env.ANDROID_UPLOAD_KEY_ALIAS === "string" && env.ANDROID_UPLOAD_KEY_ALIAS.length > 0 &&
    typeof env.ANDROID_UPLOAD_KEY_PASSWORD === "string" && env.ANDROID_UPLOAD_KEY_PASSWORD.length > 0,
  "Android upload-key credentials are required by the trusted signer");
  const fingerprint = run(commandRunner, "keytool", ["-list", "-v", "-keystore", keystore,
    "-storepass", env.ANDROID_UPLOAD_KEYSTORE_PASSWORD, "-alias", env.ANDROID_UPLOAD_KEY_ALIAS], work, env);
  const observedFingerprint = parseSha256Fingerprint(fingerprint);
  requireState(normalizeFingerprint(observedFingerprint) === normalizeFingerprint(env.ANDROID_UPLOAD_KEY_FINGERPRINT),
    "Android upload-key fingerprint does not match the approved signer identity");
  const destination = join(request.signed_quarantine_root, "artifacts", "android", "app-release.aab");
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  run(commandRunner, "jarsigner", ["-keystore", keystore, "-storepass", env.ANDROID_UPLOAD_KEYSTORE_PASSWORD,
    "-keypass", env.ANDROID_UPLOAD_KEY_PASSWORD, "-sigalg", "SHA256withRSA", "-digestalg", "SHA-256",
    "-signedjar", destination, input, env.ANDROID_UPLOAD_KEY_ALIAS], work, env);
  run(commandRunner, "jarsigner", ["-verify", "-strict", "-keystore", keystore,
    "-storepass", env.ANDROID_UPLOAD_KEYSTORE_PASSWORD, destination], work, env);
  const signedFingerprint = run(commandRunner, "keytool", ["-printcert", "-jarfile", destination], work, env);
  requireState(normalizeFingerprint(parseSha256Fingerprint(signedFingerprint)) ===
    normalizeFingerprint(env.ANDROID_UPLOAD_KEY_FINGERPRINT),
  "signed Android bundle certificate does not match the approved signer identity");
  const path = boundaryModule.quarantineArtifact(destination, request.signed_quarantine_root,
    "signed Android bundle", "aab", [request.tooling_root]);
  verifyFinalArtifact({ request, unsigned, source, env, work, commandRunner, artifactPath: path });
  return { platform: "android", kind: "aab", signed_path: path,
    sha256: boundaryModule.artifactSha256(path), unsigned_sha256: source.sha256 };
}

// Fail closed unless the pinned tooling's verify-artifact.mjs accepts the final
// signed artifact (IPA entitlements/profile, AAB permissions/identity/signer).
// It receives no signing secrets; bundletool 1.18.3 is a provisioned host file.
function verifyFinalArtifact({ request, unsigned, source, env, work, commandRunner, artifactPath }) {
  const pushEnabled = unsigned.push_config?.enabled === true || unsigned.push_config?.native_push_enabled === true;
  const verifyEnv = { PATH: env.PATH ?? "", HOME: env.HOME ?? "", ASH_ATLAS_JOB_TEMP: work,
    SOURCE_SHA: request.source_sha, APPLE_TEAM_ID: env.APPLE_TEAM_ID ?? "",
    VITE_NATIVE_APP_VERSION: String(source.marketing_version), VITE_NATIVE_APP_BUILD: String(source.build),
    VITE_NATIVE_PUSH_ENABLED: pushEnabled ? "true" : "false",
    ASH_ATLAS_PLAY_UPLOAD_CERT_SHA256: env.ASH_ATLAS_PLAY_UPLOAD_CERT_SHA256 ?? "",
    ASH_ATLAS_BUNDLETOOL_JAR: join(env.HOME ?? "", "Library", "Application Support", "AshAtlasRelease",
      "bundletool-all-1.18.3.jar") };
  run(commandRunner, process.execPath, [join(resolve(request.tooling_root), "tools", "mobile-release",
    "verify-artifact.mjs"), source.platform, artifactPath], work, verifyEnv);
}

function prepareAppleSigning({ env, work, commandRunner }) {
  requireState(typeof env.APPLE_DISTRIBUTION_P12_BASE64 === "string" &&
    env.APPLE_DISTRIBUTION_P12_BASE64.length > 0 &&
    typeof env.APPLE_DISTRIBUTION_P12_PASSWORD === "string" && env.APPLE_DISTRIBUTION_P12_PASSWORD.length > 0 &&
    typeof env.APPLE_PROVISIONING_PROFILE_BASE64 === "string" &&
    env.APPLE_PROVISIONING_PROFILE_BASE64.length > 0 &&
    typeof env.APPLE_PROVISIONING_PROFILE_SPECIFIER === "string" &&
    env.APPLE_PROVISIONING_PROFILE_SPECIFIER.length > 0 &&
    typeof env.APPLE_TEAM_ID === "string" && /^[A-Z0-9]{6,12}$/u.test(env.APPLE_TEAM_ID),
  "Apple distribution credentials are required by the trusted signer");
  const keychain = join(work, "signing.keychain-db");
  const keychainPassword = randomBytes(24).toString("hex");
  const p12 = join(work, "distribution.p12");
  const profile = join(work, "profile.mobileprovision");
  const profilePlist = join(work, "profile.plist");
  const state = { keychain, keychainPassword, originalKeychains: [], originalDefault: null,
    profileDestination: null, profileExisted: false, profileBytes: null,
    cleanupEnv: { PATH: env.PATH ?? "", HOME: env.HOME ?? "" } };
  writeFileSync(p12, decodeSecret(env.APPLE_DISTRIBUTION_P12_BASE64, "Apple distribution certificate"), { mode: 0o600 });
  const profileBytes = decodeSecret(env.APPLE_PROVISIONING_PROFILE_BASE64, "Apple provisioning profile");
  state.profileBytes = profileBytes;
  try {
    writeFileSync(profile, profileBytes, { mode: 0o600 });
    state.originalKeychains = parseKeychainList(run(commandRunner, "security", ["list-keychains", "-d", "user"], work, env));
    state.originalDefault = parseSinglePath(run(commandRunner, "security", ["default-keychain", "-d", "user"], work, env));
    run(commandRunner, "security", ["create-keychain", "-p", keychainPassword, keychain], work, env);
    run(commandRunner, "security", ["set-keychain-settings", "-lut", "21600", keychain], work, env);
    run(commandRunner, "security", ["unlock-keychain", "-p", keychainPassword, keychain], work, env);
    run(commandRunner, "security", ["import", p12, "-k", keychain, "-P", env.APPLE_DISTRIBUTION_P12_PASSWORD,
      "-T", "/usr/bin/codesign"], work, env);
    run(commandRunner, "security", ["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k",
      keychainPassword, keychain], work, env);
    const identities = run(commandRunner, "security", ["find-identity", "-v", "-p", "codesigning", keychain], work, env);
    requireState(/Apple Distribution/u.test(identities), "Apple Distribution identity was not imported");
    const profileInfo = run(commandRunner, "security", ["cms", "-D", "-i", profile], work, env);
    writeFileSync(profilePlist, profileInfo, { encoding: "utf8", mode: 0o600 });
    requireState(run(commandRunner, "/usr/libexec/PlistBuddy", ["-c", "Print :Name", profilePlist], work, env).trim() ===
      env.APPLE_PROVISIONING_PROFILE_SPECIFIER, "Apple provisioning profile name does not match");
    requireState(run(commandRunner, "/usr/libexec/PlistBuddy", ["-c", "Print :TeamIdentifier:0", profilePlist], work, env).trim() ===
      env.APPLE_TEAM_ID, "Apple provisioning profile team does not match");
    const profileUuid = run(commandRunner, "/usr/libexec/PlistBuddy", ["-c", "Print :UUID", profilePlist], work, env).trim();
    requireState(/^[A-Fa-f0-9-]{36}$/u.test(profileUuid), "Apple provisioning profile UUID is invalid");
    const profileDirectory = join(env.HOME ?? "", "Library", "MobileDevice", "Provisioning Profiles");
    requireState(isAbsolute(profileDirectory), "Apple profile directory is unavailable");
    mkdirSync(profileDirectory, { recursive: true, mode: 0o700 });
    state.profileDestination = join(profileDirectory, `${profileUuid}.mobileprovision`);
    state.profileExisted = existsSync(state.profileDestination);
    if (state.profileExisted) requireState(readFileSync(state.profileDestination).equals(profileBytes),
      "existing Apple provisioning profile differs from the approved profile");
    else copyFileSync(profile, state.profileDestination, 0);
    run(commandRunner, "security", ["list-keychains", "-d", "user", "-s", keychain, ...state.originalKeychains], work, env);
    return state;
  } catch (error) {
    restoreAppleSigning(state, commandRunner);
    throw error;
  }
}

function restoreAppleSigning(state, commandRunner) {
  try {
    const env = state.cleanupEnv;
    if (state.originalKeychains.length > 0) run(commandRunner, "security", ["list-keychains", "-d", "user", "-s",
      ...state.originalKeychains], process.cwd(), env);
    if (state.originalDefault) run(commandRunner, "security", ["default-keychain", "-d", "user", "-s",
      state.originalDefault], process.cwd(), env);
    run(commandRunner, "security", ["delete-keychain", state.keychain], process.cwd(), env);
    if (state.profileDestination && !state.profileExisted && existsSync(state.profileDestination) &&
      readFileSync(state.profileDestination).equals(state.profileBytes)) rmSync(state.profileDestination, { force: true });
  } catch {
    // The workflow's durable cleanup marker remains authoritative if host
    // restoration fails; never hide the signing result behind cleanup output.
  }
}

function exportOptionsPlist(env) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>method</key><string>app-store-connect</string><key>manageAppVersionAndBuildNumber</key><false/><key>signingStyle</key><string>manual</string><key>teamID</key><string>${xml(env.APPLE_TEAM_ID)}</string><key>signingCertificate</key><string>Apple Distribution</string><key>provisioningProfiles</key><dict><key>${BUNDLE_ID}</key><string>${xml(env.APPLE_PROVISIONING_PROFILE_SPECIFIER)}</string></dict></dict></plist>\n`;
}

function findSingleFile(root, extension, label) {
  const results = [];
  walk(root, (path) => { if (path.toLowerCase().endsWith(extension)) results.push(path); });
  requireState(results.length === 1, `${label} must contain exactly one ${extension} file`);
  return results[0];
}

function walk(path, callback) {
  const stat = lstatSync(path);
  requireState(!stat.isSymbolicLink(), "signed output contains a symbolic link");
  if (stat.isFile()) { callback(path); return; }
  requireState(stat.isDirectory(), "signed output contains a non-regular path");
  for (const entry of readdirSync(path)) walk(join(path, entry), callback);
}

function persistFile(boundary, source, destination, label) {
  requireState(lstatSync(source).isFile() && lstatSync(source).size > 0, `${label} is empty`);
  if (existsSync(destination)) {
    requireState(boundary.artifactSha256(source) === boundary.artifactSha256(destination),
      `${label} changed for the active operation`);
    return;
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(source, destination, 0);
}

function decodeSecret(value, label) {
  requireState(typeof value === "string" && value.length > 0, `${label} is required`);
  const normalized = value.replace(/\s+/gu, "");
  requireState(normalized.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/u.test(normalized),
    `${label} is not valid base64`);
  try {
    const decoded = Buffer.from(normalized, "base64");
    requireState(decoded.length > 0, `${label} is empty`);
    return decoded;
  } catch { throw new Error(`${label} is not valid base64`); }
}

function parseSha256Fingerprint(value) {
  const match = String(value).match(/SHA256:\s*([0-9A-F]{2}(?::[0-9A-F]{2}){31})/iu);
  requireState(match, "signer certificate SHA-256 fingerprint was not found");
  return match[1];
}

function normalizeFingerprint(value) {
  requireState(typeof value === "string" && /^[0-9A-F]{64}$/iu.test(value.replaceAll(":", "")),
    "approved signer fingerprint is invalid");
  return value.replaceAll(":", "").toUpperCase();
}

function parseKeychainList(value) {
  return String(value).split(/\r?\n/u).map((line) => line.trim().replace(/^"|"$/gu, ""))
    .filter((line) => line.endsWith(".keychain") || line.endsWith(".keychain-db"));
}

function parseSinglePath(value) {
  const line = String(value).split(/\r?\n/u).map((entry) => entry.trim().replace(/^"|"$/gu, ""))
    .find((entry) => entry.endsWith(".keychain") || entry.endsWith(".keychain-db"));
  return line ?? null;
}

function xml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function run(commandRunner, command, args, cwd, env) {
  return commandRunner(command, args, { cwd, env, encoding: "utf8" });
}

function defaultCommandRunner(command, args, options) {
  return execFileSync(command, args, {
    cwd: options.cwd, env: options.env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

async function loadBoundary(toolingRoot) {
  return import(pathToFileURL(join(resolve(toolingRoot), "tools", "mobile-release",
    "coordinated-build-boundary.mjs")).href);
}

async function loadSigningModule(toolingRoot) {
  return import(pathToFileURL(join(resolve(toolingRoot), "tools", "mobile-release",
    "coordinated-sign-artifacts.mjs")).href);
}

function assertRequest(request) {
  requireState(request?.schema_version === 1 && request.kind === "ash-atlas-coordinated-sign-request",
    "trusted signing request schema is invalid");
  requireState(OPERATION_ID.test(request.operation_id) && GENERATION.test(request.generation) && SHA.test(request.source_sha),
    "trusted signing request identity is invalid");
  for (const [name, value] of [["tooling_root", request.tooling_root], ["signed_quarantine_root", request.signed_quarantine_root]]) {
    requireState(typeof value === "string" && isAbsolute(value), `${name} must be absolute`);
  }
}

function requireState(condition, message) {
  if (!condition) throw new Error(message);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = Object.fromEntries(process.argv.slice(2).map((value, index, values) =>
    value.startsWith("--") ? [value.slice(2), values[index + 1]] : null).filter(Boolean));
  try {
    requireState(typeof args.request === "string" && typeof args.output === "string",
      "--request and --output are required");
    const input = JSON.parse(readFileSync(resolve(args.request), "utf8"));
    const request = input.request ?? input;
    const unsigned = input.unsigned_manifest ?? input.unsignedManifest;
    requireState(unsigned, "trusted signing request is missing unsigned manifest");
    const result = await runMacTrustedSigning({ request, unsignedManifest: unsigned });
    const { writeJsonAtomic } = await loadBoundary(request.tooling_root);
    writeJsonAtomic(resolve(args.output), result);
  } catch {
    console.error("ACTION_REQUIRED_PROVISION_ISOLATED_BUILD: trusted Mac signer failed");
    process.exitCode = 1;
  }
}
