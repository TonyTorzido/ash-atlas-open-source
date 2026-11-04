import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ACTION_REQUIRED_PROVISION_ISOLATED_BUILD,
  artifactSha256,
  copyArtifact,
  positiveEnvironment,
  quarantineArtifact,
  requireProvisionedBuildBoundary
} from "./coordinated-build-boundary.mjs";
import { buildUnsignedRequest, runUnsignedBuild } from "./coordinated-unsigned-build.mjs";
import { runTrustedSigning, validateUnsignedManifest } from "./coordinated-sign-artifacts.mjs";
import { buildSandboxProfile, sandboxCommandArguments } from "./coordinated-mac-isolated-build-supervisor.mjs";
import {
  assertBuildIdentityIdle,
  buildGateCommand,
  chownRecursive,
  finalizeGateHandoff,
  hardenedMode,
  prepareBuildTraversal,
  restoreIncompleteStaging,
  terminateBuildIdentity,
  validateGateConfig,
  validateGateRequest
} from "./coordinated-mac-build-gate.mjs";

const operationId = "coord-boundary-fixture";
const generation = "t1251";
const sourceSha = "a".repeat(40);

test("archive handoff preserves and hashes empty regular Capacitor assets", () => {
  const directory = mkdtempSync(join(tmpdir(), "ash-atlas-empty-archive-assets-"));
  try {
    const source = join(directory, "source.xcarchive");
    const assets = join(source, "Products", "Applications", "App.app", "public");
    mkdirSync(assets, { recursive: true });
    writeFileSync(join(assets, "cordova.js"), "");
    writeFileSync(join(assets, "cordova_plugins.js"), "");
    const initialHash = artifactSha256(source);
    const destination = join(directory, "quarantine", "App.xcarchive");
    copyArtifact(source, destination, "xcarchive");
    assert.equal(artifactSha256(destination), initialHash);
    assert.equal(quarantineArtifact(destination, join(directory, "quarantine"), "archive", "xcarchive"), destination);
    writeFileSync(join(assets, "cordova.js"), "changed");
    assert.notEqual(artifactSha256(source), initialHash);
    const emptyAab = join(directory, "quarantine", "empty.aab");
    writeFileSync(emptyAab, "");
    assert.throws(() => quarantineArtifact(emptyAab, join(directory, "quarantine"), "AAB", "aab"), /non-empty/u);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

function request(directory) {
  const source = join(directory, "source");
  const tooling = join(directory, "tooling");
const quarantine = join(directory, "unsigned");
  mkdirSync(source); mkdirSync(tooling); mkdirSync(quarantine);
  return buildUnsignedRequest({ operationId, generation, sourceSha,
    sourceRepositoryRoot: source, toolingRoot: tooling, registryRemote: "example-org/game",
    reservedVersions: { ios: { marketingVersion: "1.2.0", build: 12 }, android: { marketingVersion: "1.2.0", build: 72 } },
    protocol: { min: 3, max: 3 }, quarantineRoot: quarantine });
}

test("positive environment excludes credentials even when the caller names them", () => {
  const result = positiveEnvironment({
    env: { PATH: "/bin", SIGNING_PASSWORD: "sentinel", ASH_ATLAS_REGISTRY_TOKEN: "token", SAFE: "value" },
    names: ["PATH", "SIGNING_PASSWORD", "ASH_ATLAS_REGISTRY_TOKEN", "SAFE"]
  });
  assert.deepEqual(result, { PATH: "/bin", SAFE: "value" });
});

test("Mac isolation profile denies the trusted host home and scopes build writes", () => {
  const profile = buildSandboxProfile({
    sourceRepositoryRoot: "/Users/runner/work/game",
    toolingRoot: "/Users/runner/work/control-tooling",
    quarantineRoot: "/Users/runner/handoff/operation/unsigned",
    builderPath: "/Users/runner/temp/provider/coordinated-mac-unsigned-builder.mjs",
    requestPath: "/private/tmp/request.json",
    outputPath: "/private/tmp/result.json",
    guestHome: "/Users/runner/handoff/operation/.sandbox/home",
    guestTmp: "/Users/runner/handoff/operation/.sandbox/tmp",
    hostHome: "/Users/runner"
  });
  assert.match(profile, /\(deny file-read\* \(subpath .*[/\\]\.ssh"\)\)/u);
  assert.match(profile, /\(allow file-read\* \(subpath .*game"\)\)/u);
  assert.match(profile, /\(allow file-write\* \(subpath .*\.sandbox.*tmp"\)\)/u);
  assert.match(profile, /\(allow file-write\* \(literal "\/dev\/null"\)\)/u);
  assert.doesNotMatch(profile, /\(allow file-write\* \(subpath .*\/dev"\)\)/u);
  assert.doesNotMatch(profile, /sysctl-read/u);
  assert.doesNotMatch(profile, /\(allow file-write\* \(subpath "(?:\/Users\/runner|C:.*Users\\\\runner)"\)\)/u);
});

test("Mac supervisor passes the profile file to sandbox-exec", () => {
  const args = sandboxCommandArguments({
    profilePath: "/handoff/profile.sb",
    builderPath: "/providers/builder.mjs",
    requestPath: "/tmp/request.json",
    outputPath: "/tmp/result.json"
  });
  assert.equal(args[0], "-f");
  assert.notEqual(args[0], "-p");
  assert.equal(args[1].endsWith("profile.sb"), true);
});

test("Mac gate contract uses only the fixed gate and a distinct UID", () => {
  const command = buildGateCommand({
    profile_path: "/handoff/op/profile.sb",
    builder_path: "/providers/builder.mjs",
    request_path: "/handoff/op/request.json",
    output_path: "/handoff/op/result.json",
    tooling_root: "/checkouts/tooling",
    build_uid: 501,
    build_gid: 501,
    child_environment: { PATH: "/usr/bin:/bin", HOME: "/handoff/op/home" }
  });
  assert.equal(command.command, "/usr/bin/sandbox-exec");
  assert.equal(command.args[0], "-f");
  assert.match(command.args[1], /(?:^|[\\/])handoff[\\/]op[\\/]profile\.sb$/u);
  assert.equal(command.uid, 501);
  assert.equal(command.gid, 501);
  assert.equal(command.detached, true);
  assert.equal(Object.hasOwn(command.env, "SIGNING_PASSWORD"), false);
});

test("Mac gate grants build-only traversal and keeps returned work dirs reusable", () => {
  const directory = mkdtempSync(join(tmpdir(), "ash-atlas-gate-modes-"));
  try {
    const handoff = join(directory, "handoff");
    const operation = join(handoff, "operation");
    const work = join(operation, ".isolated-build");
    mkdirSync(work, { recursive: true });
    const chmodCalls = [];
    const chownCalls = [];
    prepareBuildTraversal({ handoffRoot: handoff, targetRoots: [work], trustedUid: 502, buildGid: 501,
      chown: (...args) => chownCalls.push(args), chmod: (...args) => chmodCalls.push(args) });
    assert.ok(chownCalls.length >= 3);
    assert.ok(chmodCalls.every(([, mode]) => mode === 0o710));
    assert.equal(hardenedMode({ mutable: false, directory: true }), 0o500);
    assert.equal(hardenedMode({ mutable: false }), 0o400);
    assert.equal(hardenedMode({ mutable: true, directory: true }), 0o700);
    assert.equal(hardenedMode({ mutable: true }), 0o600);
    assert.equal(hardenedMode({ mutable: true, executable: true }), 0o700);
    assert.equal(hardenedMode({ mutable: false, executable: true }), 0o500);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Mac gate drains the exclusive build UID and proves no open handoff files", () => {
  const directory = mkdtempSync(join(tmpdir(), "ash-atlas-gate-processes-"));
  const calls = [];
  try {
    const commandRunner = (command, args) => {
      calls.push([command, args]);
      if (command === "/usr/bin/pgrep") return { status: 1, stdout: "", stderr: "" };
      if (command === "/usr/sbin/lsof") return { status: 1, stdout: "", stderr: "" };
      return { status: 1, stdout: "", stderr: "" };
    };
    assert.doesNotThrow(() => {
      assertBuildIdentityIdle({ buildUid: 501, commandRunner });
      terminateBuildIdentity({ buildUid: 501, paths: [directory], commandRunner,
        pathExists: (path) => path === "/usr/sbin/lsof" || path === directory });
    });
    assert.deepEqual(calls.slice(-4).map(([command]) => command),
      ["/usr/bin/pkill", "/usr/bin/pkill", "/usr/bin/pgrep", "/usr/sbin/lsof"]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Mac gate fails closed when a descendant or open handoff file remains", () => {
  const directory = mkdtempSync(join(tmpdir(), "ash-atlas-gate-process-failure-"));
  try {
    const commandRunner = (command) => {
      if (command === "/usr/bin/pgrep") return { status: 1, stdout: "", stderr: "" };
      if (command === "/usr/sbin/lsof") return { status: 0, stdout: "4321\n", stderr: "" };
      return { status: 1, stdout: "", stderr: "" };
    };
    assert.throws(() => terminateBuildIdentity({ buildUid: 501, paths: [directory], commandRunner,
      pathExists: (path) => path === "/usr/sbin/lsof" || path === directory }), /open files/u);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Mac gate rejects a symlinked handoff before any ownership mutation", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ash-atlas-gate-symlink-"));
  try {
    const staging = join(directory, "staging");
    const outside = join(directory, "outside");
    mkdirSync(staging); mkdirSync(outside);
    try { symlinkSync(outside, join(staging, "escape"), "dir"); }
    catch (error) {
      if (["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) { t.skip("symlink creation unavailable"); return; }
      throw error;
    }
    const chownCalls = [];
    assert.throws(() => chownRecursive(staging, 62001, 62001,
      { chown: (...args) => chownCalls.push(args) }), /symlink/u);
    assert.equal(chownCalls.length, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Mac gate rejects hard-linked handoff files before any ownership mutation", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ash-atlas-gate-hardlink-"));
  try {
    const staging = join(directory, "staging");
    const outside = join(directory, "outside.txt");
    const alias = join(staging, "alias.txt");
    mkdirSync(staging); writeFileSync(outside, "sentinel");
    try { linkSync(outside, alias); }
    catch (error) {
      if (["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) { t.skip("hardlink creation unavailable"); return; }
      throw error;
    }
    const chownCalls = [];
    assert.throws(() => chownRecursive(staging, 62001, 62001,
      { chown: (...args) => chownCalls.push(args) }), /hard-linked file/u);
    assert.equal(chownCalls.length, 0);
    assert.equal(readFileSync(outside, "utf8"), "sentinel");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Mac gate never hardens a tree when drain proof fails", () => {
  const hardened = [];
  assert.throws(() => finalizeGateHandoff({ paths: ["/handoff/unsigned"],
    drain: () => { throw new Error("descendant remains"); },
    harden: (path) => hardened.push(path) }), /descendant remains/u);
  assert.deepEqual(hardened, []);
});

test("Mac gate rejects an incomplete lsof scan", () => {
  const directory = mkdtempSync(join(tmpdir(), "ash-atlas-gate-lsof-error-"));
  try {
    const commandRunner = (command) => {
      if (command === "/usr/bin/pgrep") return { status: 1, stdout: "", stderr: "" };
      if (command === "/usr/sbin/lsof") return { status: 1, stdout: "", stderr: "scan incomplete" };
      return { status: 1, stdout: "", stderr: "" };
    };
    assert.throws(() => terminateBuildIdentity({ buildUid: 501, paths: [directory], commandRunner,
      pathExists: (path) => path === "/usr/sbin/lsof" || path === directory }), /open-file proof failed/u);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("failed unsigned staging is writable again on a safe Resume", (t) => {
  if (process.platform === "win32") { t.skip("POSIX mode semantics unavailable"); return; }
  const directory = mkdtempSync(join(tmpdir(), "ash-atlas-gate-resume-"));
  try {
    const staging = join(directory, "unsigned");
    const artifact = join(staging, "partial.aab");
    mkdirSync(staging); writeFileSync(artifact, "partial");
    chmodSync(staging, 0o500); chmodSync(artifact, 0o400);
    restoreIncompleteStaging(staging, 62001, 62001, { chown: () => {} });
    assert.equal(readFileSync(artifact, "utf8"), "partial");
    assert.equal(statSync(staging).mode & 0o777, 0o700);
    assert.equal(statSync(artifact).mode & 0o777, 0o600);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Mac gate validates fixed roots and rejects a builder inside a checkout", () => {
  const directory = mkdtempSync(join(tmpdir(), "ash-atlas-gate-contract-"));
  try {
    const source = join(directory, "source");
    const tooling = join(directory, "tooling");
    const handoff = join(directory, "handoff");
    const builder = join(handoff, "builder.mjs");
    const checkoutBuilder = join(tooling, "builder.mjs");
    mkdirSync(source); mkdirSync(tooling); mkdirSync(handoff);
    writeFileSync(builder, "export {};");
    writeFileSync(checkoutBuilder, "export {};");
    const config = validateGateConfig({ schema_version: 1,
      kind: "ash-atlas-mac-build-gate-config", build_account: "ash-atlas-build",
      build_uid: 501, build_gid: 501, trusted_uid: 502, trusted_gid: 502,
      allowed_handoff_root: handoff, allowed_checkout_parent: directory });
    assert.equal(config.build_uid, 501);
    assert.doesNotThrow(() => validateGateRequest({ schema_version: 1,
      kind: "ash-atlas-mac-build-gate-preflight", operation_id: "preflight", generation: "t000",
      source_sha: "0".repeat(40), source_repository_root: source, tooling_root: tooling,
      handoff_root: handoff, builder_path: builder, builder_sha256: artifactSha256(builder) }, config,
    { preflight: true }));
    assert.throws(() => validateGateRequest({ schema_version: 1,
      kind: "ash-atlas-mac-build-gate-preflight", operation_id: "preflight", generation: "t000",
      source_sha: "0".repeat(40), source_repository_root: source, tooling_root: tooling,
      handoff_root: handoff, builder_path: checkoutBuilder,
      builder_sha256: artifactSha256(checkoutBuilder) }, config, { preflight: true }), /outside the source and tooling/u);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("provider boundary fails before reservation when roots or external providers are missing", () => {
  const directory = mkdtempSync(join(tmpdir(), "ash-atlas-boundary-"));
  try {
    const source = join(directory, "source");
    const tooling = join(directory, "tooling");
    mkdirSync(source); mkdirSync(tooling);
    assert.throws(() => requireProvisionedBuildBoundary({
      env: {}, operationId, generation, sourceSha,
      sourceRepositoryRoot: source, toolingRoot: tooling,
      registryRemote: "example-org/game"
    }), new RegExp(ACTION_REQUIRED_PROVISION_ISOLATED_BUILD, "u"));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("provisioning accepts the private template signer contract", () => {
  const directory = mkdtempSync(join(tmpdir(), "ash-atlas-boundary-provisioned-"));
  try {
    const source = join(directory, "source");
    const tooling = join(directory, "tooling");
    const builder = join(directory, "builder.mjs");
    const signer = join(directory, "signer.mjs");
    const supervisor = join(directory, "supervisor.mjs");
    const gate = join(directory, "gate.mjs");
    mkdirSync(source); mkdirSync(tooling);
    writeFileSync(builder, "");
    writeFileSync(signer, "");
    writeFileSync(supervisor, "");
    writeFileSync(gate, "");
    const result = requireProvisionedBuildBoundary({
      env: {
        COORDINATED_ISOLATED_BUILDER: builder,
        COORDINATED_ISOLATED_BUILDER_SHA256: createHash("sha256").update("").digest("hex"),
        COORDINATED_TRUSTED_SIGNER: signer,
        COORDINATED_ISOLATED_BUILD_SUPERVISOR: supervisor,
        COORDINATED_ISOLATED_BUILD_SUPERVISOR_SHA256: createHash("sha256").update("").digest("hex"),
        COORDINATED_ISOLATED_BUILD_GATE: gate,
        COORDINATED_ISOLATED_BUILD_GATE_SHA256: createHash("sha256").update("").digest("hex"),
        COORDINATED_ISOLATED_BUILD_IDENTITY: "fixture-builder",
        COORDINATED_TRUSTED_SIGNER_ID: "fixture-signer"
      }, operationId, generation, sourceSha,
      sourceRepositoryRoot: source, toolingRoot: tooling,
      registryRemote: "example-org/game"
    });
    assert.equal(result.builder, builder);
    assert.equal(result.signer, signer);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("isolated unsigned builder receives no signing secret and returns durable artifact hashes", () => {
  const directory = mkdtempSync(join(tmpdir(), "ash-atlas-unsigned-fixture-"));
  try {
    const req = request(directory);
    const builder = join(directory, "isolated-builder.mjs");
    const supervisor = join(directory, "isolated-supervisor.mjs");
    const gate = join(directory, "isolated-gate");
    writeFileSync(builder, `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const args = process.argv.slice(2); const requestPath = args[args.indexOf("--request") + 1];
const outputPath = args[args.indexOf("--output") + 1]; const request = JSON.parse(readFileSync(requestPath, "utf8"));
writeFileSync(request.quarantine_root + "/env.json", JSON.stringify({ secret: process.env.SIGNING_PASSWORD ?? null }));
const treeHash = (value) => createHash("sha256").update("ash-atlas-artifact-tree-v1\\0").update("F\\0Info.plist\\0" + value.length + "\\0").update(value).digest("hex");
const artifacts = ["ios.xcarchive", "android.aab"].map((name) => { const path = request.quarantine_root + "/" + name;
if (name.startsWith("ios")) { mkdirSync(path); writeFileSync(path + "/Info.plist", name); } else writeFileSync(path, name); const platform = name.startsWith("ios") ? "ios" : "android"; const reserved = request.reserved_versions[platform]; return { platform, kind: platform === "ios" ? "xcarchive" : "aab", path, marketing_version: reserved.marketingVersion, build: reserved.build, sha256: name.startsWith("ios") ? treeHash(name) : createHash("sha256").update(name).digest("hex") }; });
writeFileSync(outputPath, JSON.stringify({ schema_version: 1, kind: "ash-atlas-coordinated-unsigned-build-result", status: "ok", operation_id: request.operation_id, generation: request.generation, source_sha: request.source_sha, registry_remote: request.registry_remote, reserved_versions: request.reserved_versions, protocol: request.protocol, artifacts }));`);
    chmodSync(builder, 0o700);
    writeFileSync(supervisor, `import { execFileSync } from "node:child_process";
const args = process.argv.slice(2); const builder = args[args.indexOf("--builder") + 1];
const forwarded = ["--request", args[args.indexOf("--request") + 1], "--output", args[args.indexOf("--output") + 1]];
process.stdout.write(execFileSync(process.execPath, [builder, ...forwarded], { env: process.env, encoding: "utf8" }));`);
    chmodSync(supervisor, 0o700);
    writeFileSync(gate, "gate");
    const result = runUnsignedBuild({ request: req, env: {
      PATH: process.env.PATH, SIGNING_PASSWORD: "sentinel", COORDINATED_ISOLATED_BUILD_SUPERVISOR: supervisor,
      COORDINATED_ISOLATED_BUILD_SUPERVISOR_SHA256: createHash("sha256").update(readFileSync(supervisor)).digest("hex"),
      COORDINATED_ISOLATED_BUILD_GATE: gate,
      COORDINATED_ISOLATED_BUILD_GATE_SHA256: createHash("sha256").update(readFileSync(gate)).digest("hex")
    }, builder });
    assert.equal(result.status, "ok");
    assert.equal(JSON.parse(readFileSync(join(req.quarantine_root, "env.json"), "utf8")).secret, null);
    assert.equal(result.artifacts.length, 2);
    assert.match(result.manifest_sha256, /^[0-9a-f]{64}$/u);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("missing isolated builder is durable ACTION_REQUIRED and does not reserve", () => {
  const directory = mkdtempSync(join(tmpdir(), "ash-atlas-unsigned-required-"));
  try {
    const req = request(directory);
    const result = runUnsignedBuild({ request: req, env: {} });
    assert.equal(result.status, "ACTION_REQUIRED");
    assert.equal(result.code, ACTION_REQUIRED_PROVISION_ISOLATED_BUILD);
    assert.equal(result.operation_id, operationId);
    assert.equal(existsSync(join(req.quarantine_root, "env.json")), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("trusted signing refuses until controller-owned signer is provisioned", () => {
  const directory = mkdtempSync(join(tmpdir(), "ash-atlas-sign-required-"));
  try {
    const req = request(directory);
    const iosPath = join(req.quarantine_root, "ios.xcarchive");
    const androidPath = join(req.quarantine_root, "android.aab");
    mkdirSync(iosPath); writeFileSync(join(iosPath, "Info.plist"), "ios"); writeFileSync(androidPath, "android");
    const manifestBase = { schema_version: 1, kind: "ash-atlas-coordinated-unsigned-artifact-manifest",
      operation_id: operationId, generation, source_sha: sourceSha,
      source_repository_root: req.source_repository_root, tooling_root: req.tooling_root,
      registry_remote: req.registry_remote, reserved_versions: req.reserved_versions,
      protocol: req.protocol, push_config: req.push_config, quarantine_root: req.quarantine_root, artifacts: [
        { platform: "ios", kind: "xcarchive", path: iosPath, marketing_version: req.reserved_versions.ios.marketingVersion, build: req.reserved_versions.ios.build, sha256: artifactSha256(iosPath) },
        { platform: "android", kind: "aab", path: androidPath, marketing_version: req.reserved_versions.android.marketingVersion, build: req.reserved_versions.android.build, sha256: artifactSha256(androidPath) }
      ] };
    const manifest = { ...manifestBase, manifest_sha256: createHash("sha256").update(JSON.stringify(manifestBase)).digest("hex") };
    assert.doesNotThrow(() => validateUnsignedManifest(manifest));
    const result = runTrustedSigning({ request: { operation_id: operationId, generation,
      source_sha: sourceSha, tooling_root: req.tooling_root,
      signed_quarantine_root: join(directory, "signed") }, unsignedManifest: manifest, env: {} });
    assert.equal(result.status, "ACTION_REQUIRED");
    assert.equal(result.code, ACTION_REQUIRED_PROVISION_ISOLATED_BUILD);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("trusted signing rejects a cross-operation unsigned manifest before invoking the signer", () => {
  const directory = mkdtempSync(join(tmpdir(), "ash-atlas-sign-binding-"));
  try {
    const req = request(directory);
    const iosPath = join(req.quarantine_root, "ios.xcarchive");
    const androidPath = join(req.quarantine_root, "android.aab");
    mkdirSync(iosPath); writeFileSync(join(iosPath, "Info.plist"), "ios"); writeFileSync(androidPath, "android");
    const base = { schema_version: 1, kind: "ash-atlas-coordinated-unsigned-artifact-manifest",
      operation_id: operationId, generation, source_sha: sourceSha,
      source_repository_root: req.source_repository_root, tooling_root: req.tooling_root,
      registry_remote: req.registry_remote, reserved_versions: req.reserved_versions,
      protocol: req.protocol, push_config: req.push_config, quarantine_root: req.quarantine_root, artifacts: [
        { platform: "ios", kind: "xcarchive", path: iosPath, marketing_version: req.reserved_versions.ios.marketingVersion, build: req.reserved_versions.ios.build, sha256: artifactSha256(iosPath) },
        { platform: "android", kind: "aab", path: androidPath, marketing_version: req.reserved_versions.android.marketingVersion, build: req.reserved_versions.android.build, sha256: artifactSha256(androidPath) }
      ] };
    const manifest = { ...base, manifest_sha256: createHash("sha256").update(JSON.stringify(base)).digest("hex") };
    const result = runTrustedSigning({ request: { operation_id: "coord-other-operation", generation,
      source_sha: sourceSha, source_repository_root: req.source_repository_root,
      registry_remote: req.registry_remote, reserved_versions: req.reserved_versions,
      protocol: req.protocol, tooling_root: req.tooling_root,
      signed_quarantine_root: join(directory, "signed") }, unsignedManifest: manifest, env: {} });
    assert.equal(result.status, "ACTION_REQUIRED");
    assert.match(result.reason, /ACTION_REQUIRED_PROVISION_ISOLATED_BUILD/u);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
