import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as boundary from "./coordinated-build-boundary.mjs";
import { artifactSha256 } from "./coordinated-build-boundary.mjs";
import { validateUnsignedManifest } from "./coordinated-sign-artifacts.mjs";
import { runMacTrustedSigning } from "./coordinated-mac-trusted-signer.mjs";
import { runMacUnsignedBuild } from "./coordinated-mac-unsigned-builder.mjs";

const operationId = "coord-mac-provider-fixture";
const generation = "t1251";
const sourceSha = "a".repeat(40);
const reservation = { ios: { marketingVersion: "1.2.0", build: 12 },
  android: { marketingVersion: "1.2.0", build: 72 } };

function unsignedRequest(root) {
  const source = join(root, "source");
  const tooling = join(root, "tooling");
  const quarantine = join(root, "unsigned");
  mkdirSync(source); mkdirSync(tooling); mkdirSync(quarantine);
  return { schema_version: 1, kind: "ash-atlas-coordinated-unsigned-build-request", operation_id: operationId,
    generation, source_sha: sourceSha, source_repository_root: source, tooling_root: tooling,
    registry_remote: "example-org/game", reserved_versions: reservation,
    protocol: { min: 3, max: 3 }, push_config: null, quarantine_root: quarantine };
}

test("directory package hashes are deterministic and differ from regular files", () => {
  const root = mkdtempSync(join(tmpdir(), "ash-atlas-directory-hash-"));
  try {
    const first = join(root, "first.xcarchive");
    const second = join(root, "second.xcarchive");
    mkdirSync(join(first, "Products"), { recursive: true });
    mkdirSync(join(second, "Products"), { recursive: true });
    writeFileSync(join(first, "Products", "Info.plist"), "same");
    writeFileSync(join(second, "Products", "Info.plist"), "same");
    assert.equal(artifactSha256(first), artifactSha256(second));
    mkdirSync(join(second, "Empty"));
    assert.notEqual(artifactSha256(first), artifactSha256(second));
    const regular = join(root, "regular.aab");
    writeFileSync(regular, "same");
    assert.notEqual(artifactSha256(first), artifactSha256(regular));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Mac providers reject a quarantine rooted inside a checkout before running tools", async () => {
  const root = mkdtempSync(join(tmpdir(), "ash-atlas-mac-root-guard-"));
  try {
    const request = unsignedRequest(root);
    await assert.rejects(() => runMacUnsignedBuild({
      request: { ...request, quarantine_root: request.source_repository_root },
      platform: "darwin",
      commandRunner: () => { throw new Error("native command must not run"); },
      boundary
    }), /outside source and tooling roots/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Mac unsigned provider archives the exact source and persists hash-bound packages", async () => {
  const root = mkdtempSync(join(tmpdir(), "ash-atlas-mac-builder-"));
  try {
    const request = unsignedRequest(root);
    const commands = [];
    let entitlementsSigned = null;
    const commandRunner = (command, args, options) => {
      commands.push({ command, args, options });
      if (command === "pnpm") {
        const invocation = args.join(" ");
        assert.ok(new Set([
          "install --frozen-lockfile",
          "build:native",
          "exec cap sync ios",
          "--filter @ash-atlas/client build:android",
          "exec cap sync android"
        ]).has(invocation), `unexpected pnpm invocation: ${invocation}`);
        return "";
      }
      if (command === "git" && args.includes("rev-parse")) return `${sourceSha}\n`;
      if (command === "git" && args.includes("status")) return "";
      if (command === "git" && args.includes("archive")) {
        writeFileSync(args[args.indexOf("--output") + 1], "fixture archive");
        return "";
      }
      if (command === "tar") {
        const source = args[args.indexOf("-C") + 1];
        mkdirSync(join(source, "ios", "App", "App.xcodeproj"), { recursive: true });
        mkdirSync(join(source, "ios", "App", "App"), { recursive: true });
        writeFileSync(join(source, "ios", "App", "App", "AppPush.entitlements"),
          "<string>$(APS_ENVIRONMENT)</string><string>$(APP_ATTEST_ENVIRONMENT)</string><string>applinks:playashatlas.com</string>");
        mkdirSync(join(source, "android", "app"), { recursive: true });
        return "";
      }
      if (command === "codesign") {
        entitlementsSigned = readFileSync(args[args.indexOf("--entitlements") + 1], "utf8");
        return "";
      }
      if (command === "xcodebuild") {
        const archive = args[args.indexOf("-archivePath") + 1];
        mkdirSync(join(archive, "Products"), { recursive: true });
        writeFileSync(join(archive, "Info.plist"), "unsigned-ios");
        writeFileSync(join(archive, "Products", "Info.plist"), "unsigned-ios");
        return "";
      }
      if (command === "/usr/libexec/PlistBuddy") {
        if (args.some((arg) => arg.includes("CFBundleIdentifier"))) return "com.ashatlas.game\n";
        if (args.some((arg) => arg.includes("CFBundleShortVersionString"))) return "1.2.0\n";
        if (args.some((arg) => arg.includes("CFBundleVersion"))) return "12\n";
        return "";
      }
      if (command === "bash" && args.some((arg) => arg.includes("printAshAtlasReleaseIdentity"))) {
        return "versionName=1.2.0\nversionCode=72\n";
      }
      if (command === "bash" && args.includes("bundleRelease")) {
        const source = args[args.indexOf("-p") + 1];
        const output = join(source, "app", "build", "outputs", "bundle", "release", "app-release.aab");
        mkdirSync(join(output, ".."), { recursive: true });
        writeFileSync(output, "unsigned-android");
        return "";
      }
      return "";
    };
    const result = await runMacUnsignedBuild({ request, platform: "darwin", commandRunner, boundary });
    assert.equal(result.status, "ok");
    assert.equal(result.artifacts.length, 2);
    assert.equal(result.artifacts[0].kind, "xcarchive");
    assert.equal(result.artifacts[0].sha256, artifactSha256(result.artifacts[0].path));
    assert.equal(result.artifacts[1].sha256, artifactSha256(result.artifacts[1].path));
    assert.ok(commands.some(({ command, args }) => command === "xcodebuild" && args.includes("CODE_SIGNING_ALLOWED=NO")));
    const adHoc = commands.find(({ command }) => command === "codesign");
    assert.deepEqual(adHoc.args.slice(0, 3), ["--force", "--sign", "-"]);
    assert.ok(adHoc.args.at(-1).endsWith(join("Products", "Applications", "App.app")));
    assert.equal(entitlementsSigned,
      "<string>production</string><string>production</string><string>applinks:playashatlas.com</string>");
    assert.ok(commands.every(({ options }) => options.env.SIGNING_PASSWORD === undefined));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("unsigned manifest uses real artifact paths across the macOS /var alias", {
  skip: process.platform !== "darwin" || realpathSync(tmpdir()) === tmpdir()
}, () => {
  const root = mkdtempSync(join(tmpdir(), "ash-atlas-mac-alias-"));
  try {
    const request = unsignedRequest(root);
    const ios = join(request.quarantine_root, "ios.xcarchive");
    const android = join(request.quarantine_root, "android.aab");
    mkdirSync(join(ios, "Products"), { recursive: true });
    writeFileSync(join(ios, "Products", "Info.plist"), "unsigned-ios");
    writeFileSync(android, "unsigned-android");
    assert.notEqual(realpathSync(ios), ios);
    const base = { schema_version: 1, kind: "ash-atlas-coordinated-unsigned-artifact-manifest",
      operation_id: operationId, generation, source_sha: sourceSha,
      source_repository_root: request.source_repository_root, tooling_root: request.tooling_root,
      registry_remote: request.registry_remote, reserved_versions: reservation, protocol: request.protocol,
      push_config: null, quarantine_root: request.quarantine_root, artifacts: [
        { platform: "ios", kind: "xcarchive", path: realpathSync(ios), marketing_version: "1.2.0", build: 12, sha256: artifactSha256(ios) },
        { platform: "android", kind: "aab", path: realpathSync(android), marketing_version: "1.2.0", build: 72, sha256: artifactSha256(android) }
      ] };
    assert.equal(validateUnsignedManifest({ ...base,
      manifest_sha256: createHash("sha256").update(JSON.stringify(base)).digest("hex") }).artifacts[0].path,
    realpathSync(ios));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Mac trusted signer binds both outputs to the unsigned manifest without store calls", async () => {
  const root = mkdtempSync(join(tmpdir(), "ash-atlas-mac-signer-"));
  try {
    const request = unsignedRequest(root);
    const ios = join(request.quarantine_root, "ios.xcarchive");
    const android = join(request.quarantine_root, "android.aab");
    mkdirSync(join(ios, "Products"), { recursive: true });
    writeFileSync(join(ios, "Products", "Info.plist"), "unsigned-ios");
    writeFileSync(android, "unsigned-android");
    const unsignedBase = { schema_version: 1, kind: "ash-atlas-coordinated-unsigned-artifact-manifest",
      operation_id: operationId, generation, source_sha: sourceSha,
      source_repository_root: request.source_repository_root, tooling_root: request.tooling_root,
      registry_remote: request.registry_remote, reserved_versions: reservation, protocol: request.protocol,
      push_config: null, quarantine_root: request.quarantine_root, artifacts: [
        { platform: "ios", kind: "xcarchive", path: realpathSync(ios), marketing_version: "1.2.0", build: 12, sha256: artifactSha256(ios) },
        { platform: "android", kind: "aab", path: realpathSync(android), marketing_version: "1.2.0", build: 72, sha256: artifactSha256(android) }
      ] };
    const unsigned = { ...unsignedBase,
      manifest_sha256: createHash("sha256").update(JSON.stringify(unsignedBase)).digest("hex") };
    validateUnsignedManifest(unsigned);
    const signedRoot = join(root, "signed");
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    const fingerprint = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";
    const env = {
      HOME: home, PATH: process.env.PATH, APPLE_DISTRIBUTION_P12_BASE64: Buffer.from("p12").toString("base64"),
      APPLE_DISTRIBUTION_P12_PASSWORD: "p12-password", APPLE_PROVISIONING_PROFILE_BASE64: Buffer.from("profile").toString("base64"),
      APPLE_PROVISIONING_PROFILE_SPECIFIER: "Ash Atlas Distribution", APPLE_TEAM_ID: "TEAM1234",
      ANDROID_UPLOAD_KEYSTORE_BASE64: Buffer.from("keystore").toString("base64"),
      ANDROID_UPLOAD_KEYSTORE_PASSWORD: "store-password", ANDROID_UPLOAD_KEY_ALIAS: "upload",
      ANDROID_UPLOAD_KEY_PASSWORD: "key-password", ANDROID_UPLOAD_KEY_FINGERPRINT: fingerprint
    };
    const commands = [];
    const commandRunner = (command, args, options) => {
      commands.push({ command, args, options });
      if (command === "security" && args.includes("list-keychains")) return '    "/Users/test/login.keychain-db"\n';
      if (command === "security" && args.includes("default-keychain")) return '    "/Users/test/login.keychain-db"\n';
      if (command === "security" && args.includes("find-identity")) return '1) ABC "Apple Distribution: Ash Atlas"\n';
      if (command === "security" && args.includes("cms")) return "profile plist";
      if (command === "/usr/libexec/PlistBuddy" && args.some((arg) => arg.includes(":Name"))) return "Ash Atlas Distribution\n";
      if (command === "/usr/libexec/PlistBuddy" && args.some((arg) => arg.includes(":TeamIdentifier:0"))) return "TEAM1234\n";
      if (command === "/usr/libexec/PlistBuddy" && args.some((arg) => arg.includes(":UUID"))) return "01234567-89AB-CDEF-0123-456789ABCDEF\n";
      if (command === "xcodebuild") {
        const output = args[args.indexOf("-exportPath") + 1];
        mkdirSync(output, { recursive: true });
        writeFileSync(join(output, "AshAtlas.ipa"), "signed-ios");
      }
      if (command === "keytool" && args.includes("-list")) return `SHA256: ${fingerprint}\n`;
      if (command === "keytool" && args.includes("-printcert")) return `SHA256: ${fingerprint}\n`;
      if (command === "jarsigner" && args.includes("-signedjar")) {
        writeFileSync(args[args.indexOf("-signedjar") + 1], "signed-android");
      }
      return "";
    };
    const result = await runMacTrustedSigning({
      request: { schema_version: 1, kind: "ash-atlas-coordinated-sign-request", operation_id: operationId,
        generation, source_sha: sourceSha, source_repository_root: request.source_repository_root,
        tooling_root: request.tooling_root, registry_remote: request.registry_remote,
        reserved_versions: reservation, protocol: request.protocol, signed_quarantine_root: signedRoot },
      unsignedManifest: unsigned, env, platform: "darwin", commandRunner, boundary,
      validator: { validateUnsignedManifest }
    });
    assert.equal(result.status, "ok");
    assert.deepEqual(result.artifacts.map((artifact) => artifact.platform), ["ios", "android"]);
    assert.equal(result.artifacts[0].sha256, artifactSha256(result.artifacts[0].signed_path));
    assert.equal(result.artifacts[1].sha256, artifactSha256(result.artifacts[1].signed_path));
    assert.ok(commands.some(({ command }) => command === "xcodebuild"));
    assert.ok(commands.some(({ command }) => command === "jarsigner"));
    const verification = commands.find(({ command, args }) => command === "jarsigner" && args.includes("-verify"));
    assert.ok(verification.args.includes("-strict"));
    assert.ok(verification.args.includes("-keystore"));
    assert.equal(verification.args[verification.args.indexOf("-storepass") + 1], env.ANDROID_UPLOAD_KEYSTORE_PASSWORD);
    assert.ok(commands.every(({ command }) => command !== "fastlane"));
    const verifications = commands.filter(({ args }) => args[0]?.endsWith("verify-artifact.mjs"));
    assert.deepEqual(verifications.map(({ args }) => args[1]), ["ios", "android"]);
    assert.deepEqual(verifications.map(({ args }) => args[2]), result.artifacts.map((artifact) => artifact.signed_path));
    for (const { options } of verifications) {
      assert.equal(options.env.VITE_NATIVE_PUSH_ENABLED, "false");
      assert.equal(options.env.SOURCE_SHA, sourceSha);
      assert.ok(Object.keys(options.env).every((name) => !/P12|PASSWORD|KEYSTORE|PROFILE_BASE64/u.test(name)));
    }
    assert.deepEqual(verifications.map(({ options }) => options.env.VITE_NATIVE_APP_BUILD), ["12", "72"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
