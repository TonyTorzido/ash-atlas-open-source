import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ACTION_REQUIRED = "ACTION_REQUIRED_PROVISION_ISOLATED_BUILD";
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const SAFE_ENV_NAME = /^[A-Z][A-Z0-9_]*$/u;
const CHILD_ENV_NAMES = ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "RUNNER_TEMP", "CI", "GITHUB_ACTIONS",
  "GITHUB_RUN_ID", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "npm_config_cache", "GRADLE_USER_HOME", "PNPM_HOME",
  "ANDROID_HOME", "ANDROID_SDK_ROOT", "JAVA_HOME", "NVM_BIN"];
const GATE_CONFIG_PATH = "/etc/ash-atlas/coordinated-mobile-build-gate.json";

/**
 * Run the uncredentialed builder inside a real macOS Seatbelt sandbox.
 *
 * The private control workflow passes only positive, non-secret environment
 * values to this process.  The sandbox gives the child an operation-scoped
 * HOME and TMPDIR, permits reads from the immutable source/tooling roots, and
 * permits writes only to the operation handoff and temporary roots.  A label
 * or a different environment variable is not treated as isolation.
 */
export function runMacIsolatedBuild({
  builder,
  requestPath,
  outputPath,
  sourceRepositoryRoot,
  toolingRoot,
  handoffRoot,
  quarantineRoot,
  operationId,
  env = process.env,
  platform = process.platform,
  commandRunner = execFileSync
}) {
  requireState(platform === "darwin", `${ACTION_REQUIRED}: macOS Seatbelt is required for the native builder`);
  const identity = preflightMacIsolatedBuild({ env, platform, commandRunner,
    sourceRepositoryRoot, toolingRoot, handoffRoot: handoffRoot ?? dirname(dirname(resolve(quarantineRoot))),
    builder });
  requireExternalFile(builder, "builder");
  requireAbsoluteDirectory(sourceRepositoryRoot, "source repository root");
  requireAbsoluteDirectory(toolingRoot, "tooling root");
  requireAbsoluteDirectory(quarantineRoot, "quarantine root");
  requireAbsoluteFile(requestPath, "build request");
  requireAbsolutePath(outputPath, "build result");
  requireState(OPERATION_ID.test(String(operationId ?? "")), "operation ID is invalid");
  const sourceRoot = realpathSync(resolve(sourceRepositoryRoot));
  const toolingRootPath = realpathSync(resolve(toolingRoot));
  const quarantineRootPath = realpathSync(resolve(quarantineRoot));
  const builderPath = realpathSync(resolve(builder));
  requireState(!isDescendant(builderPath, sourceRoot) && !isDescendant(builderPath, toolingRootPath),
    "builder must be outside source and tooling roots");
  requireState(existsSync("/usr/bin/sandbox-exec"),
    `${ACTION_REQUIRED}: /usr/bin/sandbox-exec is unavailable on this Mac runner`);

  const sandboxRoot = mkdtempSync(join(dirname(quarantineRootPath),
    `.ash-atlas-${safePathPart(operationId)}-sandbox-`), { encoding: "utf8" });
  const guestHome = join(sandboxRoot, "home");
  const guestTmp = join(sandboxRoot, "tmp");
  const profilePath = join(sandboxRoot, "profile.sb");
  mkdirSync(guestHome, { recursive: true, mode: 0o700 });
  mkdirSync(guestTmp, { recursive: true, mode: 0o700 });
  const profile = buildSandboxProfile({
    sourceRepositoryRoot: sourceRoot,
    toolingRoot: toolingRootPath,
    quarantineRoot: quarantineRootPath,
    builderPath,
    requestPath,
    outputPath,
    guestHome,
    guestTmp,
    hostHome: env.HOME,
    toolchainRoots: trustedToolchainRoots(env)
  });
  writeFileSync(profilePath, profile, { encoding: "utf8", mode: 0o644 });
  const childEnv = {
    ...env,
    PATH: trustedToolchainPath(env),
    HOME: guestHome,
    TMPDIR: guestTmp,
    TMP: guestTmp,
    TEMP: guestTmp,
    RUNNER_TEMP: guestTmp,
    XDG_CONFIG_HOME: join(guestHome, ".config"),
    XDG_CACHE_HOME: join(guestHome, ".cache"),
    npm_config_cache: join(guestHome, ".npm"),
    GRADLE_USER_HOME: join(guestHome, ".gradle"),
    PNPM_HOME: join(guestHome, ".pnpm")
  };
  const gateRequest = {
    schema_version: 1,
    kind: "ash-atlas-mac-build-gate-request",
    operation_id: operationId,
    generation: readBuildRequestField(requestPath, "generation"),
    source_sha: readBuildRequestField(requestPath, "source_sha"),
    source_repository_root: sourceRoot,
    tooling_root: toolingRootPath,
    handoff_root: realpathSync(resolve(handoffRoot ?? dirname(dirname(resolve(quarantineRoot))))),
    builder_path: builderPath,
    builder_sha256: fileSha256(builderPath),
    quarantine_root: quarantineRootPath,
    request_path: resolve(requestPath),
    output_path: resolve(outputPath),
    sandbox_root: sandboxRoot,
    profile_path: profilePath,
    profile_sha256: fileSha256(profilePath),
    build_uid: identity.buildUid,
    build_gid: identity.buildGid,
    trusted_uid: identity.currentUid,
    trusted_gid: identity.currentGid,
    child_environment: childEnvironmentObject(childEnv)
  };
  try {
    return commandRunner("/usr/bin/sudo", ["-n", identity.gatePath], {
      cwd: toolingRootPath,
      env: { PATH: env.PATH ?? "/usr/bin:/bin", HOME: env.HOME ?? "" },
      input: `${JSON.stringify(gateRequest)}\n`,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"]
    });
  } finally {
    rmSync(sandboxRoot, { recursive: true, force: true });
  }
}

export function preflightMacIsolatedBuild({
  env = process.env,
  platform = process.platform,
  commandRunner = execFileSync,
  sourceRepositoryRoot,
  toolingRoot,
  handoffRoot,
  builder = env.COORDINATED_ISOLATED_BUILDER
}) {
  requireState(platform === "darwin", `${ACTION_REQUIRED}: a root-owned macOS build gate is required`);
  requireState(existsSync("/usr/bin/sandbox-exec"),
    `${ACTION_REQUIRED}: /usr/bin/sandbox-exec is unavailable on this Mac runner`);
  requireState(existsSync("/usr/bin/sudo") && existsSync("/usr/bin/id"),
    `${ACTION_REQUIRED}: the root-owned Mac build gate transport is unavailable`);
  const gatePath = String(env.COORDINATED_ISOLATED_BUILD_GATE ?? "");
  const gateSha256 = String(env.COORDINATED_ISOLATED_BUILD_GATE_SHA256 ?? "");
  requireState(isAbsolute(gatePath) && existsSync(gatePath) && lstatSync(gatePath).isFile() &&
    !lstatSync(gatePath).isSymbolicLink() && rootOwnedLocked(gatePath),
  `${ACTION_REQUIRED}: root-owned Mac build gate is unavailable`);
  requireState(/^[0-9a-f]{64}$/u.test(gateSha256) && fileSha256(gatePath) === gateSha256,
    `${ACTION_REQUIRED}: root-owned Mac build gate fingerprint is missing or changed`);
  requireState(existsSync(GATE_CONFIG_PATH) && lstatSync(GATE_CONFIG_PATH).isFile() &&
    !lstatSync(GATE_CONFIG_PATH).isSymbolicLink() && rootOwnedLocked(GATE_CONFIG_PATH),
    `${ACTION_REQUIRED}: root-owned Mac build gate configuration is unavailable`);
  requireAbsoluteDirectory(sourceRepositoryRoot, "source repository root");
  requireAbsoluteDirectory(toolingRoot, "tooling root");
  requireAbsoluteDirectory(handoffRoot, "durable handoff root");
  requireExternalFile(builder, "isolated builder", [sourceRepositoryRoot, toolingRoot]);
  const options = { cwd: process.cwd(), env: { PATH: env.PATH ?? "/usr/bin:/bin", HOME: env.HOME ?? "" },
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
  const currentUid = commandRunner("/usr/bin/id", ["-u"], options).trim();
  const currentGid = commandRunner("/usr/bin/id", ["-g"], options).trim();
  const currentUser = commandRunner("/usr/bin/id", ["-un"], options).trim();
  requireState(/^[1-9][0-9]{0,9}$/u.test(currentUid) && /^[1-9][0-9]{0,9}$/u.test(currentGid),
    `${ACTION_REQUIRED}: trusted runner identity is invalid`);
  let gateConfig;
  try { gateConfig = JSON.parse(readFileSync(GATE_CONFIG_PATH, "utf8")); }
  catch { throw new Error(`${ACTION_REQUIRED}: root-owned Mac build gate configuration is unreadable`); }
  requireState(Number(gateConfig.trusted_uid) === Number(currentUid) &&
    Number(gateConfig.trusted_gid) === Number(currentGid),
  `${ACTION_REQUIRED}: root-owned Mac build gate trusted identity does not match the runner`);
  requireState(/^[1-9][0-9]{0,9}$/u.test(String(gateConfig.build_uid)) &&
    /^[1-9][0-9]{0,9}$/u.test(String(gateConfig.build_gid)) &&
    String(gateConfig.build_uid) !== String(currentUid),
  `${ACTION_REQUIRED}: root-owned Mac build gate has no distinct build identity`);
  const preflight = {
    schema_version: 1,
    kind: "ash-atlas-mac-build-gate-preflight",
    operation_id: "preflight",
    generation: "t000",
    source_sha: "0".repeat(40),
    source_repository_root: realpathSync(resolve(sourceRepositoryRoot)),
    tooling_root: realpathSync(resolve(toolingRoot)),
    handoff_root: realpathSync(resolve(handoffRoot)),
    builder_path: realpathSync(resolve(builder)),
    builder_sha256: fileSha256(builder)
  };
  const result = commandRunner("/usr/bin/sudo", ["-n", gatePath], {
    ...options,
    input: `${JSON.stringify(preflight)}\n`,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const output = typeof result === "string" ? result.trim() : "";
  let gateResult;
  try { gateResult = JSON.parse(output.split(/\r?\n/u).at(-1) ?? ""); }
  catch { gateResult = null; }
  requireState(gateResult?.status === "ok" && gateResult.kind === "ash-atlas-mac-build-gate-preflight-result",
    `${ACTION_REQUIRED}: root-owned Mac build gate preflight did not prove its identity`);
  return { gatePath, currentUid: Number(currentUid), currentGid: Number(currentGid), currentUser,
    buildUid: Number(gateConfig.build_uid), buildGid: Number(gateConfig.build_gid) };
}

export function sandboxCommandArguments({ profilePath, builderPath, requestPath, outputPath }) {
  return ["-f", resolve(profilePath), process.execPath, resolve(builderPath),
    "--request", resolve(requestPath), "--output", resolve(outputPath)];
}

export function childEnvironmentArguments(env) {
  return CHILD_ENV_NAMES
    .filter((name) => SAFE_ENV_NAME.test(name) || name === "npm_config_cache" || name === "GRADLE_USER_HOME")
    .filter((name) => typeof env[name] === "string")
    .map((name) => `${name}=${env[name]}`);
}

export function childEnvironmentObject(env) {
  return Object.fromEntries(childEnvironmentArguments(env).map((value) => {
    const separator = value.indexOf("=");
    return [value.slice(0, separator), value.slice(separator + 1)];
  }));
}

export function buildSandboxProfile({
  sourceRepositoryRoot,
  toolingRoot,
  quarantineRoot,
  builderPath,
  requestPath,
  outputPath,
  guestHome,
  guestTmp,
  hostHome,
  toolchainRoots = []
}) {
  const readRoots = [
    "/System", "/usr", "/bin", "/sbin", "/Applications", "/Library", "/opt", "/dev",
    sourceRepositoryRoot, toolingRoot, quarantineRoot, builderPath,
    dirname(resolve(requestPath)), dirname(resolve(outputPath)), guestHome, guestTmp,
    ...toolchainRoots
  ].filter((value, index, values) => typeof value === "string" &&
    isAbsolute(value) && values.indexOf(value) === index);
  const writeRoots = [quarantineRoot, dirname(resolve(requestPath)), dirname(resolve(outputPath)), guestHome, guestTmp]
    .filter((value, index, values) => typeof value === "string" && values.indexOf(value) === index);
  const lines = [
    ";; Generated for one coordinated mobile build operation.",
    "(version 1)",
    "(deny default)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow signal (target self))",
    "(allow file-read-metadata)",
    "(allow network-outbound)",
    "(allow mach-lookup)"
  ];
  for (const root of readRoots) lines.push(`(allow file-read* (subpath ${quote(root)}))`);
  for (const root of writeRoots) lines.push(`(allow file-write* (subpath ${quote(root)}))`);
  lines.push('(allow file-write* (literal "/dev/null"))');
  if (typeof hostHome === "string" && isAbsolute(hostHome)) {
    for (const sensitiveHomePath of [".ssh", ".aws", ".gnupg", ".npmrc", ".netrc", "Library/Keychains"]) {
      const protectedPath = join(resolve(hostHome), sensitiveHomePath);
      lines.push(`(deny file-read* (subpath ${quote(protectedPath)}))`);
      lines.push(`(deny file-write* (subpath ${quote(protectedPath)}))`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index];
    requireState(flag?.startsWith("--"), `unexpected argument ${flag ?? ""}`);
    const value = values[index + 1];
    requireState(typeof value === "string" && !value.startsWith("--"), `${flag} requires a value`);
    result[flag.slice(2)] = value;
    index += 1;
  }
  return result;
}

function required(args, name) {
  requireState(typeof args[name] === "string" && args[name].length > 0, `--${name} is required`);
  return args[name];
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    runMacIsolatedBuild({
      builder: required(args, "builder"),
      requestPath: required(args, "request"),
      outputPath: required(args, "output"),
      sourceRepositoryRoot: required(args, "source-repository-root"),
      toolingRoot: required(args, "tooling-root"),
      handoffRoot: required(args, "handoff-root"),
      quarantineRoot: required(args, "quarantine-root"),
      operationId: required(args, "operation-id")
    });
  } catch {
    process.stderr.write(`${ACTION_REQUIRED}: macOS isolated builder supervisor failed\n`);
    process.exitCode = 1;
  }
}

function requireExternalFile(path, label) {
  requireAbsoluteFile(path, label);
  requireState(!lstatSync(resolve(path)).isSymbolicLink(), `${label} must not be a symbolic link`);
}

function requireAbsoluteFile(path, label) {
  requireState(typeof path === "string" && isAbsolute(path), `${label} must be absolute`);
  requireState(existsSync(resolve(path)) && lstatSync(resolve(path)).isFile(), `${label} is unavailable`);
}

function requireAbsoluteDirectory(path, label) {
  requireState(typeof path === "string" && isAbsolute(path), `${label} must be absolute`);
  requireState(existsSync(resolve(path)) && lstatSync(resolve(path)).isDirectory(), `${label} is unavailable`);
}

function requireAbsolutePath(path, label) {
  requireState(typeof path === "string" && isAbsolute(path), `${label} must be absolute`);
}

function isDescendant(candidate, root) {
  const value = relative(root, candidate);
  return value !== "" && value !== ".." && !value.startsWith("../") && !isAbsolute(value);
}

function safePathPart(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 80);
}

function quote(value) {
  return JSON.stringify(resolve(value));
}

function fileSha256(path) {
  return createHash("sha256").update(readFileSync(resolve(path))).digest("hex");
}

function readBuildRequestField(path, field) {
  let request;
  try { request = JSON.parse(readFileSync(resolve(path), "utf8")); }
  catch { throw new Error(`${ACTION_REQUIRED}: build request is unreadable`); }
  requireState(typeof request[field] === "string" && request[field].length > 0,
    `${ACTION_REQUIRED}: build request ${field} is missing`);
  return request[field];
}

function rootOwnedLocked(path) {
  const stat = lstatSync(resolve(path));
  return stat.uid === 0 && (stat.mode & 0o022) === 0;
}

function trustedToolchainRoots(env) {
  return [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, env.JAVA_HOME, env.PNPM_HOME, env.NVM_BIN,
    ...trustedPathEntries(env)].filter((value, index, values) => typeof value === "string" &&
    isAbsolute(value) && values.indexOf(value) === index);
}

function trustedPathEntries(env) {
  const hostHome = typeof env.HOME === "string" && isAbsolute(env.HOME) ? resolve(env.HOME) : null;
  return typeof env.PATH === "string" ? env.PATH.split(delimiter).filter((value) => {
    if (!isAbsolute(value)) return false;
    return hostHome === null || !isDescendant(resolve(value), hostHome);
  }) : [];
}

function trustedToolchainPath(env) {
  const entries = ["/usr/bin", "/bin", "/usr/sbin", "/sbin", env.PNPM_HOME, env.NVM_BIN,
    ...trustedPathEntries(env)].filter((value) => typeof value === "string" && isAbsolute(value));
  return [...new Set(entries)].join(delimiter);
}

function requireState(condition, message) {
  if (!condition) throw new Error(message);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
