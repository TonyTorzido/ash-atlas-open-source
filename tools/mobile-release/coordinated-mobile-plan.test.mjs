import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  materializeCoordinatedPlan,
  materializedPlanPaths,
  operationHandoffRoot
} from "./coordinated-mobile-plan.mjs";
import { reserveBuilds } from "./registry.mjs";

const operationId = "coord-materializer-fixture";
const generation = "t1251";
const serverSha = "a".repeat(40);
const acceptedMasterSha = "b".repeat(40);
const currentServerSha = "c".repeat(40);

function packet(platform, version = "1.2.0") {
  return { schemaVersion: 1, platform,
    ...(platform === "ios" ? { bundleId: "com.ashatlas.game" } : { packageName: "com.ashatlas.game" }),
    marketingVersion: version,
    localizations: [{ locale: "en-US", description: "Ash Atlas", keywords: "ash atlas" }],
    policy: { countries: ["US"], rollout: { kind: "update", mode: platform === "android" ? "staged" : "manual",
      ...(platform === "android" ? { fraction: 0.1 } : {}) } } };
}

function dailyPacket(platform, version) {
  return { ...packet(platform, version), delivery_mode: "daily-testers",
    tester_destination: platform === "ios"
      ? { kind: "testflight", group_type: "external", group_id: "public-1",
        public_link: "https://testflight.apple.com/join/Example" }
      : { kind: "google-play-internal", track: "internal" } };
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "ash-atlas-mobile-plan-"));
  const source = join(root, "source");
  const tooling = join(root, "tooling");
  const metadata = join(root, "metadata");
  const handoff = join(root, "handoff");
  mkdirSync(source); mkdirSync(tooling); mkdirSync(metadata); mkdirSync(handoff);
  const ios = join(metadata, "ios.json");
  const android = join(metadata, "android.json");
  writeFileSync(ios, `${JSON.stringify(packet("ios"))}\n`);
  writeFileSync(android, `${JSON.stringify(packet("android"))}\n`);
  return { root, source, tooling, handoff, ios, android,
    metadataPacketPaths: { ios, android }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function request(harness) {
  return { operationId, generation, serverSha, acceptedMasterSha, currentServerSha,
    registryRemote: "example-org/game",
    sourceRepositoryRoot: harness.source, toolingRoot: harness.tooling, handoffRoot: harness.handoff,
    metadataPacketPaths: harness.metadataPacketPaths,
    distributedSources: { ios: { marketingVersion: "1.1.0", releaseId: "prior-ios" },
      android: { marketingVersion: "1.1.0", releaseId: "prior-android" } },
    now: "2026-09-22T12:00:00.000Z" };
}

test("materializes operation-scoped plan and versions from protected packet identities", () => {
  const harness = setup();
  try {
    const result = materializeCoordinatedPlan(request(harness));
    assert.equal(result.operationRoot, operationHandoffRoot(harness.handoff, operationId));
    assert.equal(result.plan.apps.ios.marketing_version, "1.2.0");
    assert.equal(result.plan.apps.android.managed_publishing, true);
    assert.equal(result.reservedVersions.ios.marketingVersion, "1.2.0");
    assert.equal(result.manifest.packets.ios.sha256.length, 64);
    assert.match(result.plan.apps.ios.metadata_packet_path, /metadata[\\/]ios\.json$/u);
    assert.equal(JSON.parse(readFileSync(result.plan.apps.ios.metadata_packet_path, "utf8")).marketingVersion, "1.2.0");
    assert.equal(readFileSync(result.planPath, "utf8").startsWith("\uFEFF"), false);
  } finally { harness.cleanup(); }
});

test("materializer retries are idempotent and reject packet drift", () => {
  const harness = setup();
  try {
    const first = materializeCoordinatedPlan(request(harness));
    const second = materializeCoordinatedPlan(request(harness));
    assert.deepEqual(second.manifest, first.manifest);
    assert.deepEqual(materializedPlanPaths({ handoffRoot: harness.handoff, operationId }), {
      operationRoot: first.operationRoot, planPath: first.planPath,
      reservedVersionsPath: first.reservedVersionsPath, manifestPath: first.manifestPath
    });
    writeFileSync(harness.ios, `${JSON.stringify(packet("ios", "1.3.0"))}\n`);
    assert.throws(() => materializeCoordinatedPlan(request(harness)), /changed for the active operation/u);
  } finally { harness.cleanup(); }
});

test("materializer binds daily tester destinations in both packet and durable plan", () => {
  const harness = setup();
  try {
    writeFileSync(harness.ios, `${JSON.stringify(dailyPacket("ios"))}\n`);
    writeFileSync(harness.android, `${JSON.stringify(dailyPacket("android"))}\n`);
    const result = materializeCoordinatedPlan(request(harness));
    assert.equal(result.plan.delivery_mode, "daily-testers");
    assert.deepEqual(result.plan.apps.ios.tester_destination, dailyPacket("ios").tester_destination);
    assert.deepEqual(result.plan.apps.android.tester_destination, dailyPacket("android").tester_destination);
    writeFileSync(harness.android, `${JSON.stringify(packet("android"))}\n`);
    assert.throws(() => materializeCoordinatedPlan(request(harness)), /delivery mode must be the same/u);
  } finally { harness.cleanup(); }
});

test("materializer rejects a tester destination without an explicit daily mode", () => {
  const harness = setup();
  try {
    const packetWithoutMode = dailyPacket("ios");
    delete packetWithoutMode.delivery_mode;
    writeFileSync(harness.ios, `${JSON.stringify(packetWithoutMode)}\n`);
    assert.throws(() => materializeCoordinatedPlan(request(harness)),
      /tester destination requires daily tester delivery mode/u);
  } finally { harness.cleanup(); }
});

test("materializer reuses the durable version plan when distributed history advances", () => {
  const harness = setup();
  try {
    const first = materializeCoordinatedPlan(request(harness));
    const resumed = materializeCoordinatedPlan({ ...request(harness), distributedSources: {
      ios: { marketingVersion: "1.2.0", releaseId: "this-operation" },
      android: { marketingVersion: "1.2.0", releaseId: "this-operation" }
    } });
    assert.deepEqual(resumed.plan, first.plan);
    assert.deepEqual(resumed.reservedVersions, first.reservedVersions);
    assert.deepEqual(resumed.manifest, first.manifest);
  } finally { harness.cleanup(); }
});

test("materializer rejects metadata from either immutable checkout", () => {
  const harness = setup();
  try {
    const insideSource = join(harness.source, "ios.json");
    writeFileSync(insideSource, `${JSON.stringify(packet("ios"))}\n`);
    assert.throws(() => materializeCoordinatedPlan({ ...request(harness),
      metadataPacketPaths: { ...harness.metadataPacketPaths, ios: insideSource } }), /outside source and tooling roots/u);
  } finally { harness.cleanup(); }
});

test("fresh production operations advance from authoritative distributed history", () => {
  const harness = setup();
  try {
    const first = materializeCoordinatedPlan(request(harness));
    const second = materializeCoordinatedPlan({ ...request(harness), operationId: "coord-materializer-day-two",
      generation: "t1252", serverSha: "e".repeat(40), currentServerSha: "f".repeat(40),
      distributedSources: { ios: { marketingVersion: first.plan.apps.ios.marketing_version, releaseId: "prior-ios-2" },
        android: { marketingVersion: first.plan.apps.android.marketing_version, releaseId: "prior-android-2" } } });
    assert.equal(first.plan.apps.ios.marketing_version, "1.2.0");
    assert.equal(second.plan.apps.ios.marketing_version, "1.2.1");
    assert.notEqual(first.plan.apps.ios.metadata_packet_path, second.plan.apps.ios.metadata_packet_path);
  } finally { harness.cleanup(); }
});

test("daily tester releases keep the configured version while registry build numbers advance", () => {
  const harness = setup();
  try {
    for (const platform of ["ios", "android"]) {
      writeFileSync(harness[platform], JSON.stringify(dailyPacket(platform, "1.0.0")));
    }
    const prior = Object.fromEntries(["ios", "android"].map((platform) => [platform,
      { marketingVersion: "1.0.1", build: 99, internal: true, releaseId: `prior-${platform}` }]));
    const first = materializeCoordinatedPlan({ ...request(harness), distributedSources: prior });
    const second = materializeCoordinatedPlan({ ...request(harness), operationId: "coord-day-two",
      distributedSources: Object.fromEntries(["ios", "android"].map((platform) => [platform,
        { marketingVersion: "1.1.0", build: 100, externalApproved: true, releaseId: `newer-${platform}` }])) });
    let registry = JSON.parse(readFileSync(new URL("../../config/mobile-release-registry.seed.json", import.meta.url)));
    registry.nextBuild.ios = 101;
    registry.nextBuild.android = 102;
    for (const [index, result] of [first, second].entries()) {
      for (const platform of ["ios", "android"]) {
        assert.equal(result.plan.apps[platform].marketing_version, "1.0.0");
        assert.equal(result.manifest.version_plan[platform].basis, "configured-packet");
      }
      const reserved = reserveBuilds(registry, { releaseId: `stable-day-${index}`, platforms: ["ios", "android"],
        marketingVersions: Object.fromEntries(["ios", "android"].map((platform) =>
          [platform, result.reservedVersions[platform].marketingVersion])),
        generation, sourceSha: serverSha, protocolMin: 3, protocolMax: 3, now: request(harness).now });
      assert.deepEqual(reserved.allocations, { ios: 101 + index, android: 102 + index });
      registry = reserved.registry;
    }
  } finally { harness.cleanup(); }
});

test("daily tester releases honor explicit configured changes and equal-version release inputs", () => {
  const harness = setup();
  try {
    for (const platform of ["ios", "android"]) {
      writeFileSync(harness[platform], JSON.stringify(dailyPacket(platform, "1.3.0")));
    }
    const configured = materializeCoordinatedPlan(request(harness));
    assert.equal(configured.plan.apps.ios.marketing_version, "1.3.0");
    for (const version of ["1.1.0", "1.4.0"]) {
      const explicitId = `coord-explicit-${version}`;
      const explicit = materializeCoordinatedPlan({ ...request(harness), operationId: explicitId,
        approvedVersionPlan: { schemaVersion: 1, kind: "ash-atlas-coordinated-mobile-version-plan",
          operation_id: explicitId, pinned: { generation, server_sha: serverSha,
            accepted_master_sha: acceptedMasterSha, current_server_sha: currentServerSha },
          versions: { ios: { marketingVersion: version }, android: { marketingVersion: version } } } });
      assert.equal(explicit.plan.apps.ios.marketing_version, version);
      assert.equal(explicit.plan.apps.android.marketing_version, version);
      assert.equal(explicit.manifest.version_plan.ios.basis, "approved-override");
    }
  } finally { harness.cleanup(); }
});

test("first publication requires an operation-bound version override", () => {
  const harness = setup();
  try {
    assert.throws(() => materializeCoordinatedPlan({ ...request(harness), distributedSources: null }),
      /authoritative distributed-source snapshot/u);
    const result = materializeCoordinatedPlan({ ...request(harness), distributedSources: null,
      approvedVersionPlan: { schemaVersion: 1, kind: "ash-atlas-coordinated-mobile-version-plan",
        operation_id: operationId, pinned: { generation, server_sha: serverSha,
          accepted_master_sha: acceptedMasterSha, current_server_sha: currentServerSha },
        versions: { ios: { marketingVersion: "1.2.0" }, android: { marketingVersion: "1.2.0" } } } });
    assert.equal(result.plan.version_plan.ios.basis, "approved-override");
  } finally { harness.cleanup(); }
});

test("CLI writes the same operation-scoped materialization contract", () => {
  const harness = setup();
  try {
    const output = join(harness.root, "result.json");
    const distributedSourcesPath = join(harness.root, "distributed-sources.json");
    writeFileSync(distributedSourcesPath, JSON.stringify({ distributedSources: request(harness).distributedSources }));
    execFileSync(process.execPath, [resolve("tools/mobile-release/coordinated-mobile-plan.mjs"),
      "--operation-id", operationId, "--generation", generation, "--server-sha", serverSha,
      "--accepted-master-sha", acceptedMasterSha, "--current-server-sha", currentServerSha,
      "--registry-remote", "example-org/game",
      "--source-repository-root", harness.source, "--tooling-root", harness.tooling,
      "--handoff-root", harness.handoff, "--ios-metadata-packet", harness.ios,
      "--android-metadata-packet", harness.android, "--distributed-sources-file", distributedSourcesPath,
      "--output", output], { encoding: "utf8" });
    const result = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(result.kind, "ash-atlas-coordinated-mobile-materializer-result");
    assert.equal(result.operation_id, operationId);
    assert.equal(readFileSync(result.plan_path, "utf8").includes("1.2.0"), true);
  } finally { harness.cleanup(); }
});
