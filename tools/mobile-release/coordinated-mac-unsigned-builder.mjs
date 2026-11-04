import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const SHA = /^[0-9a-f]{40}$/u;
const GENERATION = /^t\d{3,4}$/u;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const BUNDLE_ID = "com.ashatlas.game";
const SAFE_ENV_NAMES = ["PATH", "HOME", "TMPDIR", "RUNNER_TEMP", "CI", "GITHUB_ACTIONS", "GITHUB_RUN_ID",
  "ANDROID_HOME", "ANDROID_SDK_ROOT", "JAVA_HOME", "PNPM_HOME", "NVM_BIN"];

/**
 * Trusted control-repository provider for the uncredentialed native build.
 * The provider is copied outside both checkouts by the private workflow and
 * receives only a source mirror, reservation, and a dedicated quarantine.
 * It never receives store or signing credentials.
 */
export async function runMacUnsignedBuild({
  request,
  env = process.env,
  platform = process.platform,
  commandRunner = defaultCommandRunner,
  boundary = null
}) {
  assertRequest(request);
  if (platform !== "darwin") throw new Error("ACTION_REQUIRED_PROVISION_ISOLATED_BUILD: native Mac builder is required");
  const boundaryModule = boundary ?? await loadBoundary(request.tooling_root);
  boundaryModule.assertOutsideRoots(request.quarantine_root,
    [request.source_repository_root, request.tooling_root], "unsigned quarantine root");
  const work = mkdtempSync(join(tmpdir(), `ash-atlas-${request.operation_id}-build-`));
  try {
    const commandEnv = safeBuildEnvironment(env);
    const source = materializeSourceMirror(request, work, commandRunner, commandEnv);
    runCommand(commandRunner, "pnpm", ["install", "--frozen-lockfile"], source, commandEnv);

    const iosReservation = reservationFor(request, "ios");
    const androidReservation = reservationFor(request, "android");
    const iosEnv = platformBuildEnvironment(commandEnv, iosReservation, request.push_config);
    runCommand(commandRunner, "pnpm", ["build:native"], source, iosEnv);
    runCommand(commandRunner, "pnpm", ["exec", "cap", "sync", "ios"], source, iosEnv);
    const iosArchive = join(work, "ios", "AshAtlas.xcarchive");
    runCommand(commandRunner, "xcodebuild", [
      "-project", join(source, "ios", "App", "App.xcodeproj"),
      "-scheme", "App", "-configuration", "Release", "-sdk", "iphoneos",
      "-derivedDataPath", join(work, "ios-derived"), "-archivePath", iosArchive,
      `MARKETING_VERSION=${iosReservation.marketingVersion}`,
      `CURRENT_PROJECT_VERSION=${iosReservation.build}`,
      "CODE_SIGNING_ALLOWED=NO", "CODE_SIGNING_REQUIRED=NO", "CODE_SIGN_IDENTITY=", "archive"
    ], source, iosEnv);
    assertDirectoryPackage(iosArchive, "unsigned iOS archive");
    signArchivedAppAdHoc({ source, archive: iosArchive, work, commandRunner, env: iosEnv });
    assertIosArchiveIdentity(iosArchive, iosReservation, commandRunner, source, iosEnv);

    const androidEnv = platformBuildEnvironment(commandEnv, androidReservation, request.push_config);
    runCommand(commandRunner, "pnpm", ["--filter", "@ash-atlas/client", "build:android"], source, androidEnv);
    runCommand(commandRunner, "pnpm", ["exec", "cap", "sync", "android"], source, androidEnv);
    const gradle = join(source, "android", "gradlew");
    const androidRoot = join(source, "android");
    const identityArgs = [gradle, "--no-daemon", "-q", "-p", androidRoot,
      ":app:printAshAtlasReleaseIdentity", `-PashAtlasVersionName=${androidReservation.marketingVersion}`,
      `-PashAtlasVersionCode=${androidReservation.build}`];
    assertAndroidReleaseIdentity(runCommand(commandRunner, "bash", identityArgs, source, androidEnv), androidReservation);
    runCommand(commandRunner, "bash", [gradle, "--no-daemon", "-p", androidRoot, "bundleRelease",
      `-PashAtlasVersionName=${androidReservation.marketingVersion}`,
      `-PashAtlasVersionCode=${androidReservation.build}`], source, androidEnv);
    assertAndroidReleaseIdentity(runCommand(commandRunner, "bash", identityArgs, source, androidEnv), androidReservation);
    const androidAab = join(androidRoot, "app", "build", "outputs", "bundle", "release", "app-release.aab");
    requireFile(androidAab, "unsigned Android bundle");

    const artifactsRoot = join(request.quarantine_root, "artifacts");
    const iosDestination = join(artifactsRoot, "ios", "AshAtlas.xcarchive");
    const androidDestination = join(artifactsRoot, "android", "app-release.aab");
    const artifacts = [
      persistArtifact(boundaryModule, iosArchive, iosDestination, "xcarchive", "ios", iosReservation),
      persistArtifact(boundaryModule, androidAab, androidDestination, "aab", "android", androidReservation)
    ];
    return {
      schema_version: 1,
      kind: "ash-atlas-coordinated-unsigned-build-result",
      status: "ok",
      operation_id: request.operation_id,
      generation: request.generation,
      source_sha: request.source_sha,
      registry_remote: request.registry_remote,
      reserved_versions: structuredClone(request.reserved_versions),
      protocol: structuredClone(request.protocol),
      push_config: request.push_config === null ? null : structuredClone(request.push_config),
      artifacts
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function persistArtifact(boundary, source, destination, kind, platform, reservation) {
  const sourceHash = boundary.artifactSha256(source);
  if (existsSync(destination)) {
    requireState(boundary.artifactSha256(destination) === sourceHash,
      `${platform} persisted artifact changed for the active operation`);
  } else {
    boundary.copyArtifact(source, destination, kind);
  }
  const hash = boundary.artifactSha256(destination);
  requireState(hash === sourceHash, `${platform} persisted artifact hash changed during handoff`);
  return { platform, kind, path: destination, sha256: hash,
    marketing_version: reservation.marketingVersion, build: Number(reservation.build) };
}

function materializeSourceMirror(request, work, commandRunner, env) {
  const sourceRoot = resolve(request.source_repository_root);
  const actualSha = runCommand(commandRunner, "git", ["-C", sourceRoot, "rev-parse", "HEAD"], sourceRoot, env).trim();
  requireState(actualSha === request.source_sha, "source mirror HEAD does not match the coordinated candidate");
  const status = runCommand(commandRunner, "git", ["-C", sourceRoot, "status", "--porcelain"], sourceRoot, env).trim();
  requireState(status.length === 0, "source mirror is dirty before isolated build");
  const archive = join(work, "source.tar");
  runCommand(commandRunner, "git", ["-C", sourceRoot, "archive", "--format=tar", "--output", archive,
    request.source_sha], sourceRoot, env);
  const source = join(work, "source");
  mkdirSync(source, { recursive: true, mode: 0o700 });
  // git archive writes the repository root directly into the extraction
  // directory; do not assume an additional top-level source folder.
  runCommand(commandRunner, "tar", ["-xf", archive, "-C", source], source, env);
  requireDirectory(source, "isolated source mirror");
  return source;
}

function platformBuildEnvironment(base, reservation, pushConfig) {
  return { ...base,
    VITE_NATIVE_APP_VERSION: String(reservation.marketingVersion),
    VITE_NATIVE_APP_BUILD: String(reservation.build),
    VITE_NATIVE_PUSH_ENABLED: pushConfig?.enabled === true || pushConfig?.native_push_enabled === true ? "true" : "false"
  };
}

// Xcode 27 refuses to ad-hoc sign an iOS target whose entitlements need a
// profile, so the archive is built unsigned and only the app is then signed
// ad hoc ("-": no team, profile, or keychain) with its Release entitlements.
// Export re-signing keeps those entitlements. Store builds always carry the
// production APNs entitlement (AppPush.entitlements, matching the App Store
// profile); whether the app uses push stays the VITE_NATIVE_PUSH_ENABLED switch.
export function signArchivedAppAdHoc({ source, archive, work,
  commandRunner = defaultCommandRunner, env = process.env }) {
  const template = readFileSync(join(source, "ios", "App", "App", "AppPush.entitlements"), "utf8");
  const entitlements = template.replaceAll("$(APP_ATTEST_ENVIRONMENT)", "production")
    .replaceAll("$(APS_ENVIRONMENT)", "production");
  requireState(!entitlements.includes("$("), "iOS store entitlements contain an unresolved build setting");
  const path = join(work, "ios-store.entitlements");
  writeFileSync(path, entitlements, { mode: 0o600 });
  runCommand(commandRunner, "codesign", ["--force", "--sign", "-", "--entitlements", path,
    join(archive, "Products", "Applications", "App.app")], work, env);
}

function safeBuildEnvironment(env) {
  return Object.fromEntries(SAFE_ENV_NAMES
    .filter((name) => typeof env[name] === "string")
    .map((name) => [name, env[name]])
    .concat([["CI", "1"]]));
}

function runCommand(commandRunner, command, args, cwd, env) {
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

function reservationFor(request, platform) {
  const reservation = request.reserved_versions?.[platform];
  requireState(reservation && typeof reservation.marketingVersion === "string" && reservation.marketingVersion.length > 0 &&
    Number.isInteger(Number(reservation.build)) && Number(reservation.build) > 0,
  `${platform} reservation is incomplete`);
  return { marketingVersion: reservation.marketingVersion, build: Number(reservation.build) };
}

function assertRequest(request) {
  requireState(request?.schema_version === 1 &&
    request.kind === "ash-atlas-coordinated-unsigned-build-request", "unsigned build request schema is invalid");
  requireState(OPERATION_ID.test(request.operation_id) && GENERATION.test(request.generation) && SHA.test(request.source_sha),
    "unsigned build request identity is invalid");
  for (const [name, value] of [["source_repository_root", request.source_repository_root],
    ["tooling_root", request.tooling_root], ["quarantine_root", request.quarantine_root]]) {
    requireState(typeof value === "string" && isAbsolute(value), `${name} must be absolute`);
  }
  requireState(resolve(request.source_repository_root) !== resolve(request.tooling_root),
    "source and tooling roots must be distinct");
}

function assertDirectoryPackage(path, label) {
  requireState(existsSync(path) && lstatSync(path).isDirectory(), `${label} must be a directory package`);
}

function assertIosArchiveIdentity(archive, reservation, commandRunner, cwd, env) {
  const info = join(archive, "Info.plist");
  requireFile(info, "unsigned iOS archive metadata");
  const read = (key) => runCommand(commandRunner, "/usr/libexec/PlistBuddy", [
    "-c", `Print :ApplicationProperties:${key}`, info
  ], cwd, env).trim();
  requireState(read("CFBundleIdentifier") === BUNDLE_ID,
    "unsigned iOS archive bundle identifier does not match the application");
  requireState(read("CFBundleShortVersionString") === String(reservation.marketingVersion),
    "unsigned iOS archive marketing version does not match its reservation");
  requireState(read("CFBundleVersion") === String(reservation.build),
    "unsigned iOS archive build does not match its reservation");
}

function assertAndroidReleaseIdentity(output, reservation) {
  const lines = String(output).split(/\r?\n/u);
  requireState(lines.some((line) => line === `versionName=${reservation.marketingVersion}`),
    "unsigned Android build versionName does not match its reservation");
  requireState(lines.some((line) => line === `versionCode=${reservation.build}`),
    "unsigned Android build versionCode does not match its reservation");
}

function requireDirectory(path, label) {
  requireState(existsSync(path) && lstatSync(path).isDirectory(), `${label} is unavailable`);
}

function requireFile(path, label) {
  requireState(existsSync(path) && lstatSync(path).isFile() && lstatSync(path).size > 0,
    `${label} is unavailable or empty`);
}

function requireState(condition, message) {
  if (!condition) throw new Error(message);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = Object.fromEntries(process.argv.slice(2).map((value, index, values) =>
    value.startsWith("--") ? [value.slice(2), values[index + 1]] : null).filter(Boolean));
  const requestPath = args.request;
  const outputPath = args.output;
  try {
    requireState(typeof requestPath === "string" && typeof outputPath === "string", "--request and --output are required");
    const request = JSON.parse(readFileSync(resolve(requestPath), "utf8"));
    const result = await runMacUnsignedBuild({ request });
    requireState(outputPath && isAbsolute(outputPath), "--output must be absolute");
    mkdirSync(dirname(resolve(outputPath)), { recursive: true });
    const boundary = await loadBoundary(request.tooling_root);
    boundary.assertOutsideRoots(resolve(outputPath),
      [request.source_repository_root, request.tooling_root], "unsigned result");
    requireState(result.status === "ok", "unsigned build did not complete");
    boundary.writeJsonAtomic(resolve(outputPath), result);
  } catch (error) {
    console.error(`ACTION_REQUIRED_PROVISION_ISOLATED_BUILD: ${error.message}`);
    process.exitCode = 1;
  }
}
