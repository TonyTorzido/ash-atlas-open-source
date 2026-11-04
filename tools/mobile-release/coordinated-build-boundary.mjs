import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export const ACTION_REQUIRED_PROVISION_ISOLATED_BUILD =
  "ACTION_REQUIRED_PROVISION_ISOLATED_BUILD";

const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const GENERATION = /^t\d{3,4}$/u;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const REGISTRY_REMOTE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SENSITIVE_NAME = /(SECRET|TOKEN|PASSWORD|PASSPHRASE|P8_BASE64|P12|KEYSTORE|SERVICE_ACCOUNT|PRIVATE_KEY)/iu;

export class IsolatedBuildProvisioningRequired extends Error {
  constructor(message = "an isolated unsigned builder and trusted signing handoff are not provisioned") {
    super(`${ACTION_REQUIRED_PROVISION_ISOLATED_BUILD}: ${message}`);
    this.name = "IsolatedBuildProvisioningRequired";
    this.code = ACTION_REQUIRED_PROVISION_ISOLATED_BUILD;
    this.safeReason = this.message;
  }
}

export function assertBuildIdentity({
  operationId,
  generation,
  sourceSha,
  sourceRepositoryRoot,
  toolingRoot,
  registryRemote
}) {
  requireState(OPERATION_ID.test(String(operationId ?? "")), "coordinated operation ID is invalid");
  requireState(GENERATION.test(String(generation ?? "")), "coordinated generation is invalid");
  requireState(SHA.test(String(sourceSha ?? "")), "coordinated source SHA is invalid");
  requireAbsoluteDirectory(sourceRepositoryRoot, "sourceRepositoryRoot");
  requireAbsoluteDirectory(toolingRoot, "toolingRoot");
  requireState(resolve(sourceRepositoryRoot) !== resolve(toolingRoot),
    "sourceRepositoryRoot and toolingRoot must be distinct immutable roots");
  requireState(REGISTRY_REMOTE.test(String(registryRemote ?? "")),
    "an explicit game registry remote owner/repository is required");
}

export function requireProvisionedBuildBoundary({
  env = process.env,
  operationId,
  generation,
  sourceSha,
  sourceRepositoryRoot,
  toolingRoot,
  registryRemote,
  requireTrustedSigner = true
}) {
  try {
    assertBuildIdentity({ operationId, generation, sourceSha, sourceRepositoryRoot,
      toolingRoot, registryRemote });
    const forbiddenRoots = [sourceRepositoryRoot, toolingRoot];
    const builder = externalPath(env.COORDINATED_ISOLATED_BUILDER,
      "COORDINATED_ISOLATED_BUILDER", forbiddenRoots);
    requireState(SHA256.test(String(env.COORDINATED_ISOLATED_BUILDER_SHA256 ?? "")),
      "COORDINATED_ISOLATED_BUILDER_SHA256 is required");
    requireState(fileSha256(builder) === env.COORDINATED_ISOLATED_BUILDER_SHA256,
      "COORDINATED_ISOLATED_BUILDER_SHA256 does not match the builder");
    const supervisor = externalPath(env.COORDINATED_ISOLATED_BUILD_SUPERVISOR,
      "COORDINATED_ISOLATED_BUILD_SUPERVISOR", forbiddenRoots);
    requireState(SHA256.test(String(env.COORDINATED_ISOLATED_BUILD_SUPERVISOR_SHA256 ?? "")),
      "COORDINATED_ISOLATED_BUILD_SUPERVISOR_SHA256 is required");
    requireState(fileSha256(supervisor) === env.COORDINATED_ISOLATED_BUILD_SUPERVISOR_SHA256,
      "COORDINATED_ISOLATED_BUILD_SUPERVISOR_SHA256 does not match the supervisor");
    const gate = externalPath(env.COORDINATED_ISOLATED_BUILD_GATE,
      "COORDINATED_ISOLATED_BUILD_GATE", forbiddenRoots);
    requireState(SHA256.test(String(env.COORDINATED_ISOLATED_BUILD_GATE_SHA256 ?? "")),
      "COORDINATED_ISOLATED_BUILD_GATE_SHA256 is required");
    requireState(fileSha256(gate) === env.COORDINATED_ISOLATED_BUILD_GATE_SHA256,
      "COORDINATED_ISOLATED_BUILD_GATE_SHA256 does not match the gate");
    if (requireTrustedSigner) {
      externalPath(env.COORDINATED_TRUSTED_SIGNER,
        "COORDINATED_TRUSTED_SIGNER", forbiddenRoots);
    }
    requireState(env.COORDINATED_ISOLATED_BUILD_IDENTITY?.length > 0,
      "COORDINATED_ISOLATED_BUILD_IDENTITY is required");
    requireState(env.COORDINATED_TRUSTED_SIGNER_ID?.length > 0,
      "COORDINATED_TRUSTED_SIGNER_ID is required");
    return { builder, signer: env.COORDINATED_TRUSTED_SIGNER, supervisor, gate };
  } catch (error) {
    if (error instanceof IsolatedBuildProvisioningRequired) throw error;
    throw new IsolatedBuildProvisioningRequired(error.message);
  }
}

/**
 * Child processes receive only the values named by the caller.  In particular,
 * this helper never starts with process.env and therefore cannot accidentally
 * pass a signing key, store token, or registry credential to a game script.
 */
export function positiveEnvironment({
  env = process.env,
  names = ["PATH", "HOME", "TMPDIR", "RUNNER_TEMP", "CI", "GITHUB_ACTIONS", "GITHUB_RUN_ID"],
  overrides = {}
}) {
  const result = {};
  for (const name of names) {
    if (SENSITIVE_NAME.test(name)) continue;
    if (typeof env[name] === "string") result[name] = env[name];
  }
  for (const [name, value] of Object.entries(overrides)) {
    requireState(!SENSITIVE_NAME.test(name), `sensitive environment value ${name} must not cross the build boundary`);
    if (value !== undefined && value !== null) result[name] = String(value);
  }
  return result;
}

export function executeExternalProvider({
  provider,
  args,
  cwd,
  env,
  outputPath = null,
  forbiddenRoots = []
}) {
  const providerPath = externalPath(provider, "external provider", forbiddenRoots);
  const extension = providerPath.toLowerCase();
  const command = extension.endsWith(".mjs") ? process.execPath :
    extension.endsWith(".sh") || extension.endsWith(".command") ? "bash" : providerPath;
  const commandArgs = command === process.execPath || command === "bash" ? [providerPath, ...args] : args;
  const output = execFileSync(command, commandArgs, {
    cwd: resolve(cwd),
    env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (outputPath) writeJsonAtomic(outputPath, JSON.parse(output.trim()));
  return output;
}

export function quarantineFile(path, root, label = "artifact", forbiddenRoots = []) {
  return quarantineArtifact(path, root, label, "file", forbiddenRoots);
}

/**
 * Validate a persisted handoff artifact without following a symlink or a
 * junction out of its operation quarantine.  Xcode archives are directory
 * packages; AABs and IPAs remain regular files.
 */
export function quarantineArtifact(path, root, label = "artifact", kind = "file", forbiddenRoots = []) {
  requireState(typeof path === "string" && isAbsolute(path), `${label} path must be absolute`);
  requireState(typeof root === "string" && isAbsolute(root), `${label} root must be absolute`);
  const candidateLexical = resolve(path);
  const quarantineLexical = resolve(root);
  requireState(existsSync(quarantineLexical), `${label} quarantine root is unavailable`);
  const quarantineRoot = realpathSync(quarantineLexical);
  const candidate = realpathSync(candidateLexical);
  requireState(candidate !== quarantineRoot && isDescendant(candidate, quarantineRoot),
    `${label} must be inside its dedicated quarantine root`);
  for (const forbiddenRoot of [process.cwd(), ...forbiddenRoots]) {
    if (!forbiddenRoot) continue;
    const forbiddenLexical = resolve(forbiddenRoot);
    const forbidden = existsSync(forbiddenLexical) ? realpathSync(forbiddenLexical) : forbiddenLexical;
    requireState(!isDescendant(candidate, forbidden) && candidate !== forbidden,
      `${label} must not be inside a source or tooling checkout`);
  }
  const stat = lstatSync(candidateLexical);
  requireState(!stat.isSymbolicLink(), `${label} must not be a symbolic link`);
  if (kind === "xcarchive") {
    requireState(stat.isDirectory(), `${label} must be an xcarchive directory package`);
    assertArtifactTree(candidateLexical, candidate, label);
  } else {
    requireState(kind === "file" || kind === "aab" || kind === "ipa",
      `${label} artifact kind is unsupported`);
    requireState(stat.isFile() && stat.size > 0, `${label} must be a non-empty regular file`);
  }
  return candidate;
}

/**
 * Copy an artifact into a dedicated operation quarantine while preserving the
 * package shape.  The destination is checked after copying by the caller's
 * hash-bound manifest validation.
 */
export function copyArtifact(sourcePath, destinationPath, kind = "file") {
  const source = resolve(sourcePath);
  const destination = resolve(destinationPath);
  const sourceStat = lstatSync(source);
  requireState(!sourceStat.isSymbolicLink(), "source artifact must not be a symbolic link");
  if (kind === "xcarchive") {
    requireState(sourceStat.isDirectory(), "source xcarchive must be a directory package");
    assertArtifactTree(source, realpathSync(source), "source xcarchive");
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    copyArtifactTree(source, destination);
  } else {
    requireState(kind === "file" || kind === "aab" || kind === "ipa",
      "source artifact kind is unsupported");
    requireState(sourceStat.isFile() && sourceStat.size > 0, "source artifact must be a non-empty file");
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    copyFileSync(source, destination, 0);
  }
  return destination;
}

export function assertOutsideRoots(path, forbiddenRoots, label = "handoff file") {
  requireState(typeof path === "string" && isAbsolute(path), `${label} must be an absolute path`);
  const lexical = resolve(path);
  const candidate = canonicalForCheck(lexical);
  for (const forbiddenRoot of forbiddenRoots) {
    if (!forbiddenRoot) continue;
    const rootPath = resolve(forbiddenRoot);
    const root = existsSync(rootPath) ? realpathSync(rootPath) : rootPath;
    requireState(candidate !== root && !isDescendant(candidate, root),
      `${label} must be outside source and tooling roots`);
  }
  return lexical;
}

/**
 * Explicit environment allowlist for a trusted private-control adapter.  The
 * unsigned builder and game checkout use positiveEnvironment instead; this
 * helper is only for a controller-owned signer/store process whose secret
 * names are deliberately enumerated by the private workflow.
 */
export function scopedEnvironment({ env = process.env, names = [], overrides = {} }) {
  const result = {};
  for (const name of names) {
    requireState(/^[A-Z][A-Z0-9_]*$/u.test(name), `invalid trusted environment name ${name}`);
    if (typeof env[name] === "string") result[name] = env[name];
  }
  for (const [name, value] of Object.entries(overrides)) {
    requireState(/^[A-Z][A-Z0-9_]*$/u.test(name), `invalid trusted environment name ${name}`);
    if (value !== undefined && value !== null) result[name] = String(value);
  }
  return result;
}

export function artifactSha256(path) {
  const candidate = resolve(path);
  const stat = lstatSync(candidate);
  requireState(!stat.isSymbolicLink(), "artifact must not be a symbolic link");
  if (stat.isFile()) return createHash("sha256").update(readFileSync(candidate)).digest("hex");
  requireState(stat.isDirectory(), "artifact must be a regular file or directory package");
  const root = realpathSync(candidate);
  const hash = createHash("sha256");
  hash.update("ash-atlas-artifact-tree-v1\0");
  hashArtifactTree(candidate, root, "", hash);
  return hash.digest("hex");
}

function fileSha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function writeJsonAtomic(path, value) {
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8", flag: "wx", mode: 0o600
    });
    renameSync(temporary, absolute);
  } finally {
    try { unlinkSync(temporary); } catch { /* already renamed */ }
  }
}

export function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

export function safeProvisioningReason(error) {
  if (error instanceof IsolatedBuildProvisioningRequired || error?.code === ACTION_REQUIRED_PROVISION_ISOLATED_BUILD) {
    return error.safeReason ?? error.message;
  }
  return `${ACTION_REQUIRED_PROVISION_ISOLATED_BUILD}: isolated build/signing provider failed during a protected step`;
}

function externalPath(value, label, forbiddenRoots = []) {
  requireState(typeof value === "string" && isAbsolute(value),
    `${ACTION_REQUIRED_PROVISION_ISOLATED_BUILD}: ${label} must be an absolute external path`);
  const candidate = resolve(value);
  requireState(existsSync(candidate), `${ACTION_REQUIRED_PROVISION_ISOLATED_BUILD}: ${label} is unavailable`);
  const real = realpathSync(candidate);
  requireState(lstatSync(real).isFile(), `${ACTION_REQUIRED_PROVISION_ISOLATED_BUILD}: ${label} is not a regular file`);
  for (const forbiddenRoot of forbiddenRoots) {
    const root = resolve(forbiddenRoot);
    requireState(candidate !== root && !isDescendant(candidate, root) &&
      real !== root && !isDescendant(real, root),
      `${ACTION_REQUIRED_PROVISION_ISOLATED_BUILD}: ${label} must be outside source and tooling roots`);
  }
  return real;
}

function requireAbsoluteDirectory(value, label) {
  requireState(typeof value === "string" && isAbsolute(value), `${label} must be an absolute path`);
  requireState(existsSync(resolve(value)), `${label} is unavailable`);
}

function isDescendant(candidate, root) {
  const value = relative(root, candidate);
  return value !== "" && value !== ".." && !value.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(value);
}

function canonicalForCheck(path) {
  if (existsSync(path)) return realpathSync(path);
  let current = dirname(path);
  const suffix = [];
  while (!existsSync(current)) {
    suffix.unshift(basename(current));
    const parent = dirname(current);
    if (parent === current) return path;
    current = parent;
  }
  return resolve(realpathSync(current), ...suffix, basename(path));
}

function assertArtifactTree(path, root, label) {
  const canonical = realpathSync(path);
  requireState(canonical === root || isDescendant(canonical, root),
    `${label} contains a path outside its package root`);
  const stat = lstatSync(path);
  requireState(!stat.isSymbolicLink(), `${label} contains a symbolic link`);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      assertArtifactTree(join(path, entry.name), root, label);
    }
    return;
  }
  requireState(stat.isFile(), `${label} contains a non-regular file`);
}

function hashArtifactTree(path, root, relativePath, hash) {
  const stat = lstatSync(path);
  requireState(!stat.isSymbolicLink(), "artifact package contains a symbolic link");
  if (stat.isDirectory()) {
    if (relativePath) hash.update(`D\0${relativePath}\0`);
    const entries = readdirSync(path, { withFileTypes: true })
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const entryPath = join(path, entry.name);
      const entryCanonical = realpathSync(entryPath);
      requireState(entryCanonical !== root && isDescendant(entryCanonical, root),
        "artifact package entry escapes its package root");
      const childRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      hashArtifactTree(entryPath, root, childRelative, hash);
    }
    return;
  }
  requireState(stat.isFile(), "artifact package contains a non-regular file");
  const bytes = readFileSync(path);
  hash.update(`F\0${relativePath}\0${bytes.length}\0`);
  hash.update(bytes);
}

function copyArtifactTree(source, destination) {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourceEntry = join(source, entry.name);
    const destinationEntry = join(destination, entry.name);
    const stat = lstatSync(sourceEntry);
    requireState(!stat.isSymbolicLink(), "source artifact package contains a symbolic link");
    if (stat.isDirectory()) {
      mkdirSync(destinationEntry, { recursive: true, mode: 0o700 });
      copyArtifactTree(sourceEntry, destinationEntry);
    } else {
      requireState(stat.isFile(),
        "source artifact package contains a non-regular file");
      copyFileSync(sourceEntry, destinationEntry, 0);
    }
  }
}

function requireState(condition, message) {
  if (!condition) {
    if (String(message).startsWith(ACTION_REQUIRED_PROVISION_ISOLATED_BUILD)) {
      throw new IsolatedBuildProvisioningRequired(String(message).slice(`${ACTION_REQUIRED_PROVISION_ISOLATED_BUILD}: `.length));
    }
    throw new Error(message);
  }
}

export const BUILD_BOUNDARY_PATTERNS = { SHA, SHA256, GENERATION, OPERATION_ID, REGISTRY_REMOTE };
