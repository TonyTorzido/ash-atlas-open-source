#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  chownSync,
  existsSync,
  lchownSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const ACTION_REQUIRED_PROVISION_ISOLATED_BUILD =
  "ACTION_REQUIRED_PROVISION_ISOLATED_BUILD";
export const GATE_CONFIG_PATH = "/etc/ash-atlas/coordinated-mobile-build-gate.json";
export const GATE_SCHEMA_VERSION = 1;
export const GATE_KIND = "ash-atlas-mac-build-gate-request";
export const GATE_PREFLIGHT_KIND = "ash-atlas-mac-build-gate-preflight";

const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const UID = /^[1-9][0-9]{0,9}$/u;
const ACCOUNT = /^[A-Za-z_][A-Za-z0-9._-]{0,31}$/u;
const SAFE_ENV_NAMES = new Set(["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "RUNNER_TEMP", "CI",
  "GITHUB_ACTIONS", "GITHUB_RUN_ID", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "npm_config_cache",
  "GRADLE_USER_HOME", "PNPM_HOME", "ANDROID_HOME", "ANDROID_SDK_ROOT", "JAVA_HOME", "NVM_BIN"]);
const DEFAULT_TIMEOUT_SECONDS = 45 * 60;

/**
 * This module is installed as a root-owned file outside both checkouts. The
 * repository copy is the reviewed reference implementation and contract. The
 * sudoers entry on the trusted Mac permits exactly this file with no args;
 * request data arrives through stdin and cannot select another executable.
 */
export function validateGateConfig(config) {
  requireState(config && config.schema_version === GATE_SCHEMA_VERSION &&
    config.kind === "ash-atlas-mac-build-gate-config", "gate config schema is invalid");
  requireState(ACCOUNT.test(String(config.build_account ?? "")), "gate build account is invalid");
  requireState(UID.test(String(config.build_uid ?? "")) && String(config.build_uid) !== "0",
    "gate build UID is invalid");
  requireState(UID.test(String(config.build_gid ?? "")) && String(config.build_gid) !== "0",
    "gate build GID is invalid");
  requireState(UID.test(String(config.trusted_uid ?? "")) && String(config.trusted_uid) !== "0",
    "gate trusted UID is invalid");
  requireState(UID.test(String(config.trusted_gid ?? "")) && String(config.trusted_gid) !== "0",
    "gate trusted GID is invalid");
  requireState(String(config.build_uid) !== String(config.trusted_uid),
    "gate build and trusted UIDs must be distinct");
  requireAbsoluteDirectory(config.allowed_handoff_root, "gate handoff root");
  requireAbsoluteDirectory(config.allowed_checkout_parent, "gate checkout parent");
  const timeout = Number(config.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS);
  requireState(Number.isInteger(timeout) && timeout > 0 && timeout <= 4 * 60 * 60,
    "gate timeout is invalid");
  return {
    ...config,
    build_account: String(config.build_account),
    build_uid: Number(config.build_uid),
    build_gid: Number(config.build_gid),
    trusted_uid: Number(config.trusted_uid),
    trusted_gid: Number(config.trusted_gid),
    allowed_handoff_root: realpathSync(resolve(config.allowed_handoff_root)),
    allowed_checkout_parent: realpathSync(resolve(config.allowed_checkout_parent)),
    timeout_seconds: timeout
  };
}

export function validateGateRequest(request, config, { preflight = false } = {}) {
  const expectedKind = preflight ? GATE_PREFLIGHT_KIND : GATE_KIND;
  requireState(request && request.schema_version === GATE_SCHEMA_VERSION &&
    request.kind === expectedKind, "gate request schema is invalid");
  requireState(OPERATION_ID.test(String(request.operation_id ?? "")), "gate operation ID is invalid");
  requireAbsoluteDirectory(request.source_repository_root, "gate source root");
  requireAbsoluteDirectory(request.tooling_root, "gate tooling root");
  requireAbsoluteDirectory(request.handoff_root, "gate handoff root");
  requireState(within(realpathSync(resolve(request.handoff_root)), config.allowed_handoff_root),
    "gate handoff root is outside the provisioned root");
  requireState(within(realpathSync(resolve(request.source_repository_root)), config.allowed_checkout_parent),
    "gate source root is outside the provisioned checkout parent");
  requireState(within(realpathSync(resolve(request.tooling_root)), config.allowed_checkout_parent),
    "gate tooling root is outside the provisioned checkout parent");
  requireState(typeof request.source_sha === "string" && SHA.test(request.source_sha),
    "gate source SHA is invalid");
  requireState(typeof request.generation === "string" && /^t\d{3,4}$/u.test(request.generation),
    "gate generation is invalid");
  if (preflight) {
    requireState(typeof request.builder_path === "string" && isAbsolute(request.builder_path),
      "gate builder path is required for preflight");
    requireAbsoluteFile(request.builder_path, "gate builder");
    requireState(!within(request.builder_path, request.source_repository_root) &&
      !within(request.builder_path, request.tooling_root),
    "gate builder must be outside the source and tooling checkouts");
    requireState(within(request.builder_path, config.allowed_handoff_root),
      "gate builder must be inside the provisioned handoff root");
    requireState(SHA256.test(String(request.builder_sha256 ?? "")) &&
      sha256File(request.builder_path) === request.builder_sha256,
    "gate builder fingerprint is invalid");
    return request;
  }
  for (const field of ["builder_path", "profile_path", "request_path", "output_path", "quarantine_root", "sandbox_root"]) {
    requireState(typeof request[field] === "string" && isAbsolute(request[field]),
      `gate ${field} must be absolute`);
  }
  requireAbsoluteFile(request.builder_path, "gate builder");
  requireState(within(request.builder_path, config.allowed_handoff_root),
    "gate builder must be inside the provisioned handoff root");
  requireAbsoluteFile(request.profile_path, "gate profile");
  requireAbsoluteFile(request.request_path, "gate build request");
  requireState(SHA256.test(String(request.builder_sha256 ?? "")) &&
    sha256File(request.builder_path) === request.builder_sha256,
  "gate builder fingerprint changed");
  requireState(SHA256.test(String(request.profile_sha256 ?? "")) &&
    sha256File(request.profile_path) === request.profile_sha256,
  "gate profile fingerprint changed");
  requireState(within(request.quarantine_root, request.handoff_root),
    "gate quarantine root is outside the durable handoff root");
  requireState(within(request.profile_path, request.handoff_root),
    "gate profile is outside the durable handoff root");
  requireState(within(request.sandbox_root, request.handoff_root),
    "gate sandbox root is outside the durable handoff root");
  requireState(within(dirname(request.request_path), request.handoff_root) &&
    within(dirname(request.output_path), request.handoff_root),
  "gate request/output roots are outside the durable handoff root");
  requireState(Number(request.build_uid) === config.build_uid &&
    Number(request.build_gid) === config.build_gid &&
    Number(request.trusted_uid) === config.trusted_uid &&
    Number(request.trusted_gid) === config.trusted_gid,
  "gate request identity does not match the root-owned configuration");
  requireState(request.child_environment && typeof request.child_environment === "object" &&
    !Array.isArray(request.child_environment), "gate child environment is invalid");
  for (const [name, value] of Object.entries(request.child_environment)) {
    requireState(SAFE_ENV_NAMES.has(name) && typeof value === "string",
      "gate child environment contains an unapproved name");
  }
  return request;
}

export function buildGateCommand(request) {
  return {
    command: "/usr/bin/sandbox-exec",
    args: ["-f", resolve(request.profile_path), process.execPath, resolve(request.builder_path),
      "--request", resolve(request.request_path), "--output", resolve(request.output_path)],
    cwd: resolve(request.tooling_root),
    uid: Number(request.build_uid),
    gid: Number(request.build_gid),
    env: { ...request.child_environment },
    detached: true
  };
}

export function runGate({ request, config, commandRunner = spawnSync, platform = process.platform,
  rootUid = typeof process.getuid === "function" ? process.getuid() : null }) {
  requireState(platform === "darwin", `${ACTION_REQUIRED_PROVISION_ISOLATED_BUILD}: Mac gate is required`);
  requireState(rootUid === 0, `${ACTION_REQUIRED_PROVISION_ISOLATED_BUILD}: Mac gate must run as root`);
  const checkedConfig = validateGateConfig(config);
  validateGateRequest(request, checkedConfig);
  assertBuildIdentityIdle({ buildUid: checkedConfig.build_uid, commandRunner });
  // Swift/Foundation use the account's Darwin temp directory even with TMPDIR set.
  const darwinTempResult = commandRunner("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], {
    uid: checkedConfig.build_uid, gid: checkedConfig.build_gid, env: {}, encoding: "utf8"
  });
  requireState(darwinTempResult?.status === 0 && !darwinTempResult.error,
    `${ACTION_REQUIRED_PROVISION_ISOLATED_BUILD}: dedicated Darwin temp directory is unavailable`);
  const darwinTemp = realpathSync(String(darwinTempResult.stdout).trim());
  requireState(/^\/private\/var\/folders\/[^/]+\/[^/]+\/T$/u.test(darwinTemp) &&
    lstatSync(darwinTemp).isDirectory() && lstatSync(darwinTemp).uid === checkedConfig.build_uid,
  `${ACTION_REQUIRED_PROVISION_ISOLATED_BUILD}: Darwin temp directory has unexpected ownership`);
  const darwinCacheResult = commandRunner("/usr/bin/getconf", ["DARWIN_USER_CACHE_DIR"], {
    uid: checkedConfig.build_uid, gid: checkedConfig.build_gid, env: {}, encoding: "utf8"
  });
  requireState(darwinCacheResult?.status === 0 && !darwinCacheResult.error,
    `${ACTION_REQUIRED_PROVISION_ISOLATED_BUILD}: dedicated Darwin cache directory is unavailable`);
  const darwinCache = realpathSync(String(darwinCacheResult.stdout).trim());
  requireState(/^\/private\/var\/folders\/[^/]+\/[^/]+\/C$/u.test(darwinCache) &&
    lstatSync(darwinCache).isDirectory() && lstatSync(darwinCache).uid === checkedConfig.build_uid,
  `${ACTION_REQUIRED_PROVISION_ISOLATED_BUILD}: Darwin cache directory has unexpected ownership`);
  const buildRequest = JSON.parse(readFileSync(resolve(request.request_path), "utf8"));
  requireState(buildRequest.operation_id === request.operation_id &&
    buildRequest.generation === request.generation &&
    buildRequest.source_sha === request.source_sha &&
    resolve(buildRequest.source_repository_root) === resolve(request.source_repository_root) &&
    resolve(buildRequest.tooling_root) === resolve(request.tooling_root) &&
    resolve(buildRequest.quarantine_root) === resolve(request.quarantine_root),
  "gate build request identity does not match");
  const owned = [request.quarantine_root, request.sandbox_root,
    dirname(request.request_path), dirname(request.output_path)];
  prepareBuildTraversal({
    handoffRoot: checkedConfig.allowed_handoff_root,
    targetRoots: owned.map((path) => dirname(path)),
    trustedUid: checkedConfig.trusted_uid,
    buildGid: checkedConfig.build_gid
  });
  const operationRoot = resolve(dirname(request.quarantine_root));
  requireState(!tryStat(join(operationRoot, "unsigned-manifest.json"), lstatSync),
    `${ACTION_REQUIRED_PROVISION_ISOLATED_BUILD}: verified unsigned artifacts cannot be rebuilt in place`);
  restoreIncompleteStaging(request.quarantine_root, checkedConfig.build_uid, checkedConfig.build_gid);
  for (const path of uniquePaths(owned)) chownRecursive(path, checkedConfig.build_uid, checkedConfig.build_gid);
  // Xcode export preserves archive modes and must write its trusted signing copy.
  const mutableRoots = new Set(uniquePaths([request.quarantine_root, request.sandbox_root,
    dirname(request.request_path), dirname(request.output_path)]));
  // Unix socket paths (including tsx IPC) must fit macOS's short path limit.
  const shortTmp = mkdtempSync("/private/tmp/aa-");
  chownSync(shortTmp, checkedConfig.build_uid, checkedConfig.build_gid);
  const processRoots = uniquePaths([request.quarantine_root, request.sandbox_root,
    dirname(request.request_path), dirname(request.output_path), shortTmp]);
  let result;
  let drainError = null;
  try {
    // macOS dyld, Git, and Node need these exact platform reads to start.
    appendFileSync(request.profile_path,
      '\n(allow file-read-data (literal "/") (literal "/private/etc/gitconfig"))\n' +
      '(allow file-read-data (literal "/private/etc/ssl/openssl.cnf") (literal "/private/etc/ssl/cert.pem"))\n' +
      '(allow file-read-data (literal "/Users/Shared/AshAtlasBuildIdentity/Library/Preferences") ' +
      '(literal "/Users/Shared/AshAtlasBuildIdentity/Library/Preferences/.GlobalPreferences.plist") ' +
      '(literal "/Users/Shared/AshAtlasBuildIdentity/Library/Preferences/.GlobalPreferences_m.plist"))\n' +
      '(allow file-issue-extension (require-all (extension-class "com.apple.cfprefsd.read") ' +
      '(require-any (literal "/Users/Shared/AshAtlasBuildIdentity/Library/Preferences/.GlobalPreferences.plist") ' +
      '(literal "/Users/Shared/AshAtlasBuildIdentity/Library/Preferences/.GlobalPreferences_m.plist"))))\n' +
      '(allow ipc-posix-shm-read-data (ipc-posix-name "apple.cfprefs.daemonv1"))\n' +
      '(allow sysctl-read (sysctl-name "hw.pagesize_compat") ' +
      '(sysctl-name "hw.ncpu") (sysctl-name "hw.activecpu") ' +
      '(sysctl-name "kern.osversion") (sysctl-name "kern.argmax") ' +
      '(sysctl-name "kern.ostype") (sysctl-name "kern.hostname") ' +
      '(sysctl-name "kern.osrelease") (sysctl-name "kern.version") (sysctl-name "hw.machine"))\n' +
      '(allow sysctl-read (sysctl-name-prefix "kern.proc.pid."))\n' +
      '(allow sysctl-read (sysctl-name "net.routetable.0.0.3.0") (sysctl-name "machdep.cpu.brand_string"))\n' +
      `(allow file-read* file-write* (subpath ${JSON.stringify(shortTmp)}))\n` +
      `(allow file-read* file-write* (subpath ${JSON.stringify(darwinTemp)}))\n` +
      `(allow file-read* file-write* (subpath ${JSON.stringify(join(darwinCache, "clang"))}))\n` +
      '(allow file-read* file-write* (subpath "/Users/Shared/AshAtlasBuildIdentity/Library/Caches/org.swift.swiftpm"))\n' +
      '(allow file-read* file-write* (subpath "/Users/Shared/AshAtlasBuildIdentity/Library/org.swift.swiftpm") ' +
      '(subpath "/Users/Shared/AshAtlasBuildIdentity/.swiftpm"))\n' +
      '(allow file-read* file-write* (subpath "/Users/Shared/AshAtlasBuildIdentity/.gradle"))\n' +
      '(allow file-read* file-write* (subpath "/Users/Shared/AshAtlasBuildIdentity/.android"))\n' +
      '(allow network-bind (local unix-socket) (local udp) (local tcp))\n' +
      '(allow network-inbound (local tcp "localhost:*") (local udp))\n');
    const command = buildGateCommand(request);
    Object.assign(command.env, { TMPDIR: shortTmp, TMP: shortTmp, TEMP: shortTmp, RUNNER_TEMP: shortTmp });
    result = commandRunner(command.command, command.args, {
      cwd: command.cwd,
      env: command.env,
      uid: command.uid,
      gid: command.gid,
      detached: command.detached,
      timeout: checkedConfig.timeout_seconds * 1000,
      killSignal: "SIGKILL",
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } finally {
    try {
      finalizeGateHandoff({
        paths: processRoots,
        drain: () => terminateBuildIdentity({ buildUid: checkedConfig.build_uid,
          paths: processRoots, commandRunner }),
        harden: (path) => {
          // Package-manager caches contain symlinks; discard this drained scratch tree.
          if (path === resolve(request.sandbox_root) || path === shortTmp) rmSync(path, { recursive: true, force: true });
          else hardenAndReturn(path, checkedConfig.trusted_uid, checkedConfig.trusted_gid,
            { mutable: mutableRoots.has(path) });
        }
      });
    } catch (error) {
      drainError = error;
    }
  }
  if (drainError) throw drainError;
  requireState(result && result.status === 0 && !result.error,
    `${ACTION_REQUIRED_PROVISION_ISOLATED_BUILD}: isolated builder failed`);
  return result.stdout ?? "";
}

export function runGatePreflight({ request, config, commandRunner = spawnSync,
  platform = process.platform, rootUid = typeof process.getuid === "function" ? process.getuid() : null }) {
  requireState(platform === "darwin", `${ACTION_REQUIRED_PROVISION_ISOLATED_BUILD}: Mac gate is required`);
  requireState(rootUid === 0, `${ACTION_REQUIRED_PROVISION_ISOLATED_BUILD}: Mac gate must run as root`);
  const checkedConfig = validateGateConfig(config);
  validateGateRequest(request, checkedConfig, { preflight: true });
  requireState(existsSync("/usr/bin/sandbox-exec"),
    `${ACTION_REQUIRED_PROVISION_ISOLATED_BUILD}: sandbox-exec is unavailable`);
  requireAbsoluteDirectory(request.handoff_root, "gate handoff root");
  prepareBuildTraversal({
    handoffRoot: checkedConfig.allowed_handoff_root,
    targetRoots: [request.handoff_root, dirname(request.builder_path)],
    trustedUid: checkedConfig.trusted_uid,
    buildGid: checkedConfig.build_gid
  });
  const identityOptions = {
    uid: checkedConfig.build_uid,
    gid: checkedConfig.build_gid,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  };
  for (const path of [request.source_repository_root, request.tooling_root, request.builder_path]) {
    const readable = commandRunner("/bin/test", ["-r", resolve(path)], identityOptions);
    requireState(readable?.status === 0 && !readable.error,
      `${ACTION_REQUIRED_PROVISION_ISOLATED_BUILD}: build UID cannot read its pinned roots`);
  }
  for (const path of [request.source_repository_root, request.tooling_root, request.handoff_root]) {
    const searchable = commandRunner("/bin/test", ["-x", resolve(path)], identityOptions);
    requireState(searchable?.status === 0 && !searchable.error,
      `${ACTION_REQUIRED_PROVISION_ISOLATED_BUILD}: build UID cannot traverse its pinned roots`);
  }
  assertBuildIdentityIdle({ buildUid: checkedConfig.build_uid, commandRunner });
  return JSON.stringify({ schema_version: 1, kind: "ash-atlas-mac-build-gate-preflight-result",
    status: "ok", build_account: checkedConfig.build_account,
    build_uid: checkedConfig.build_uid, trusted_uid: checkedConfig.trusted_uid });
}

export function assertSafeTree(path, { stat = lstatSync, readdir = readdirSync } = {}) {
  const absolute = resolve(path);
  const node = tryStat(absolute, stat);
  if (!node) return;
  requireState(!node.isSymbolicLink(),
    `${ACTION_REQUIRED_PROVISION_ISOLATED_BUILD}: symlink in build handoff tree`);
  if (!node.isDirectory()) {
    requireState(Number(node.nlink) === 1,
      `${ACTION_REQUIRED_PROVISION_ISOLATED_BUILD}: hard-linked file in build handoff tree`);
    return;
  }
  for (const child of readdir(absolute)) assertSafeTree(join(absolute, child), { stat, readdir });
}

export function chownRecursive(path, uid, gid, { chown = lchownSync } = {}) {
  const absolute = resolve(path);
  if (!tryStat(absolute, lstatSync)) return;
  assertSafeTree(absolute);
  const node = lstatSync(absolute);
  if (node.isDirectory()) {
    for (const child of readdirSync(absolute)) chownRecursive(join(absolute, child), uid, gid, { chown });
  }
  chown(absolute, uid, gid);
}

export function restoreIncompleteStaging(path, uid, gid, { chown = lchownSync, chmod = chmodSync } = {}) {
  const absolute = resolve(path);
  if (!tryStat(absolute, lstatSync)) return;
  assertSafeTree(absolute);
  hardenNode(absolute, uid, gid, { mutable: true, chown, chmod });
}

export function prepareBuildTraversal({ handoffRoot, targetRoots, trustedUid, buildGid,
  realpath = realpathSync, stat = lstatSync, chown = chownSync, chmod = chmodSync }) {
  const root = realpath(resolve(handoffRoot));
  for (const target of uniquePaths(targetRoots)) {
    const targetPath = realpath(resolve(target));
    requireState(within(targetPath, root), "gate traversal root is outside the provisioned handoff root");
    const ancestors = [];
    let current = targetPath;
    while (true) {
      ancestors.push(current);
      if (current === root) break;
      const parent = dirname(current);
      requireState(parent !== current && within(parent, root),
        "gate traversal parent is outside the provisioned handoff root");
      current = parent;
    }
    for (const path of ancestors.reverse()) {
      const node = stat(path);
      requireState(node.isDirectory() && !node.isSymbolicLink(),
        "gate traversal path must be a directory");
      chown(path, trustedUid, buildGid);
      chmod(path, 0o710);
    }
  }
}

export function hardenedMode({ mutable = false, directory = false, executable = false } = {}) {
  if (directory) return mutable ? 0o700 : 0o500;
  return (mutable ? 0o600 : 0o400) | (executable ? 0o100 : 0);
}

function hardenAndReturn(path, uid, gid, { mutable = false } = {}) {
  const absolute = resolve(path);
  if (!tryStat(absolute, lstatSync)) return;
  assertSafeTree(absolute);
  hardenNode(absolute, uid, gid, { mutable });
}

export function assertBuildIdentityIdle({ buildUid, commandRunner = spawnSync }) {
  const result = commandRunner("/usr/bin/pgrep", ["-u", String(buildUid)], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
  });
  requireState(!result?.error && result.status === 1 && !String(result.stdout ?? "").trim() &&
    !String(result.stderr ?? "").trim(),
  `${ACTION_REQUIRED_PROVISION_ISOLATED_BUILD}: build UID has active processes`);
}

export function terminateBuildIdentity({ buildUid, paths = [], commandRunner = spawnSync,
  pathExists = existsSync }) {
  const options = { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
  const active = commandRunner("/usr/bin/pgrep", ["-u", String(buildUid)], options);
  requireState(!active?.error && [0, 1].includes(active.status) && !String(active.stderr ?? "").trim(),
    `${ACTION_REQUIRED_PROVISION_ISOLATED_BUILD}: cannot inspect build UID processes`);
  if (active.status === 0) {
    // Stop launchd from respawning the dedicated build user's macOS helpers.
    const bootout = commandRunner("/bin/launchctl", ["bootout", `user/${buildUid}`], options);
    requireState(!bootout?.error && bootout.status === 0,
      `${ACTION_REQUIRED_PROVISION_ISOLATED_BUILD}: cannot stop build UID launchd domain`);
  }
  for (const signal of ["TERM", "KILL"]) {
    const result = commandRunner("/usr/bin/pkill", [`-${signal}`, "-u", String(buildUid)], options);
    requireState(!result?.error && (result.status === 0 || result.status === 1) &&
      !String(result.stderr ?? "").trim(),
      `${ACTION_REQUIRED_PROVISION_ISOLATED_BUILD}: cannot drain build UID processes`);
  }
  const remaining = commandRunner("/usr/bin/pgrep", ["-u", String(buildUid)], options);
  requireState(!remaining?.error && remaining.status === 1 && !String(remaining.stdout ?? "").trim() &&
    !String(remaining.stderr ?? "").trim(),
    `${ACTION_REQUIRED_PROVISION_ISOLATED_BUILD}: build UID descendants remain active`);
  requireState(pathExists("/usr/sbin/lsof"),
    `${ACTION_REQUIRED_PROVISION_ISOLATED_BUILD}: open-file proof is unavailable`);
  for (const path of uniquePaths(paths)) {
    requireState(pathExists(path),
      `${ACTION_REQUIRED_PROVISION_ISOLATED_BUILD}: handoff path disappeared before open-file proof`);
    const open = commandRunner("/usr/sbin/lsof", ["-t", "+D", resolve(path)], options);
    requireState(!open?.error && open.status === 1 && !String(open.stdout ?? "").trim() &&
      !String(open.stderr ?? "").trim(),
      `${ACTION_REQUIRED_PROVISION_ISOLATED_BUILD}: open-file proof failed or handoff path still has open files`);
  }
}

export function finalizeGateHandoff({ paths, drain, harden }) {
  drain();
  for (const path of paths) harden(path);
}

function hardenNode(path, uid, gid, { mutable = false, chown = lchownSync, chmod = chmodSync } = {}) {
  const stat = lstatSync(path);
  requireState(!stat.isSymbolicLink(),
    `${ACTION_REQUIRED_PROVISION_ISOLATED_BUILD}: symlink in build handoff tree`);
  if (stat.isDirectory()) {
    chmod(path, hardenedMode({ mutable, directory: true }));
    for (const child of readdirSync(path)) hardenNode(join(path, child), uid, gid,
      { mutable, chown, chmod });
  } else {
    chmod(path, hardenedMode({ mutable, executable: (stat.mode & 0o111) !== 0 }));
  }
  chown(path, uid, gid);
}

function tryStat(path, stat) {
  try { return stat(path); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function uniquePaths(paths) {
  return [...new Set(paths.map((path) => resolve(path)))];
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(resolve(path))).digest("hex");
}

function within(candidate, root) {
  const value = relative(resolve(root), resolve(candidate));
  return value === "" || (value !== ".." && !value.startsWith(`..${requireSeparator()}`) && !isAbsolute(value));
}

function requireSeparator() {
  return process.platform === "win32" ? "\\" : "/";
}

function requireAbsoluteFile(path, label) {
  requireState(typeof path === "string" && isAbsolute(path), `${label} must be absolute`);
  requireState(existsSync(resolve(path)) && lstatSync(resolve(path)).isFile() &&
    !lstatSync(resolve(path)).isSymbolicLink(), `${label} is unavailable or is a link`);
}

function requireAbsoluteDirectory(path, label) {
  requireState(typeof path === "string" && isAbsolute(path), `${label} must be absolute`);
  requireState(existsSync(resolve(path)) && lstatSync(resolve(path)).isDirectory(), `${label} is unavailable`);
}

function requireState(condition, message) {
  if (!condition) throw new Error(message);
}

function readStdin() {
  return readFileSync(0, "utf8");
}

function main() {
  try {
    requireState(typeof process.getuid === "function" && process.getuid() === 0,
      `${ACTION_REQUIRED_PROVISION_ISOLATED_BUILD}: gate must run as root`);
    requireState(process.argv.length === 2,
      `${ACTION_REQUIRED_PROVISION_ISOLATED_BUILD}: gate accepts no command arguments`);
    const request = JSON.parse(readStdin());
    const config = JSON.parse(readFileSync(GATE_CONFIG_PATH, "utf8"));
    const result = request.kind === GATE_PREFLIGHT_KIND
      ? runGatePreflight({ request, config })
      : runGate({ request, config });
    process.stdout.write(`${result}\n`);
  } catch {
    process.stderr.write(`${ACTION_REQUIRED_PROVISION_ISOLATED_BUILD}: Mac build gate failed\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
