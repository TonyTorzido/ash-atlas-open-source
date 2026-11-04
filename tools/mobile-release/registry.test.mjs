import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promotionEvidence } from "./test-evidence.mjs";

import {
  changeReleaseRetirement,
  RETIREMENT_NOTE,
  retirementState,
  releaseUnusedReservation,
  reserveBuilds,
  transitionRelease,
  validateRegistry,
  distributedSourceByPlatform,
  setActivationIntent,
  resolveActivationIntent,
  migrateLegacyResolvedIntent,
  supportedReleases,
  validateActivationIntent
} from "./registry.mjs";

const seedPath = fileURLToPath(new URL("../../config/mobile-release-registry.seed.json", import.meta.url));
const request = {
  releaseId: "t1175-run-1",
  platforms: ["ios", "android"],
  marketingVersions: { ios: "1.1.0", android: "1.2.0" },
  generation: "t1175",
  sourceSha: "a".repeat(40),
  protocolMin: 3,
  protocolMax: 3,
  now: "2026-09-16T00:00:00.000Z"
};

async function seed() {
  return JSON.parse(await readFile(seedPath, "utf8"));
}

test("seeds both current build-1 clients as compatibility protected", async () => {
  const registry = validateRegistry(await seed());
  const legacy = registry.releases.filter((release) => release.build === 1);
  assert.deepEqual(legacy.map((release) => release.platform).sort(), ["android", "ios"]);
  assert.ok(legacy.every((release) => release.compatibilityProtected));
  assert.ok(legacy.every((release) => release.protocol.min === 3 && release.protocol.max === 3));
});

test("freezes availability during an exact server activation intent", async () => {
  const intent = {
    schemaVersion: 1, intentId: "activation-test-1", serverSha: "b".repeat(40),
    candidateComponentSha: "c".repeat(40), preparedReceiptSha: "d".repeat(64),
    preSwitchEnvSha: "e".repeat(64),
    serverProtocol: { min: 3, max: 3 },
    hardMinimum: { ios: { version: "1.0.0", build: 0 }, android: { version: "1.0.0", build: 0 } },
    createdAt: "2026-09-21T00:00:00Z"
  };
  const frozen = setActivationIntent(await seed(), intent);
  assert.throws(() => reserveBuilds(frozen, request), /frozen by activation intent/u);
  assert.throws(() => transitionRelease(frozen, "legacy-ios-build-1:ios", { supported: true }), /frozen by activation intent/u);
  assert.throws(() => resolveActivationIntent(frozen, { ...intent, serverSha: "c".repeat(40) }), /does not match/u);
  const resumed = resolveActivationIntent(frozen, intent, "2026-09-21T01:00:00Z");
  assert.equal(resumed.activationIntent, undefined);
  const firstReceipt = {
    schemaVersion: 1, intent, resolvedAt: "2026-09-21T01:00:00Z"
  };
  assert.deepEqual(resumed.resolvedIntents, [firstReceipt]);
  assert.deepEqual(resolveActivationIntent(resumed, intent), resumed,
    "repeating an exact resolution after a lost response is idempotent");
  assert.deepEqual(resolveActivationIntent(resumed, intent.intentId), resumed,
    "repeating an ID-only resolution after a lost response is idempotent");
  assert.throws(() => resolveActivationIntent(resumed, "different-intent"), /does not match/u,
    "a stale or mismatched resolution cannot clear another intent");
  assert.deepEqual(setActivationIntent(frozen, intent), frozen, "same intent is idempotent");
  assert.throws(() => setActivationIntent(resumed, intent), /already resolved/u,
    "a resolved operation cannot be reactivated under the same identity");

  const nextIntent = { ...intent, intentId: "activation-test-2", serverSha: "f".repeat(40),
    createdAt: "2026-09-21T02:00:00Z" };
  const activeNext = setActivationIntent(resumed, nextIntent);
  assert.deepEqual(activeNext.resolvedIntents, [firstReceipt],
    "acquiring a later activation does not delete prior resolution history");
  assert.deepEqual(resolveActivationIntent(activeNext, intent), activeNext,
    "a delayed retry for A does not modify active B");
  assert.throws(() => resolveActivationIntent(activeNext, { ...intent, serverSha: "c".repeat(40) }), /does not match/u,
    "a mismatched retry for A cannot modify active B");
  const completedNext = resolveActivationIntent(activeNext, nextIntent, "2026-09-21T03:00:00Z");
  assert.deepEqual(completedNext.resolvedIntents, [firstReceipt, {
    schemaVersion: 1, intent: nextIntent, resolvedAt: "2026-09-21T03:00:00Z"
  }]);
  assert.deepEqual(resolveActivationIntent(completedNext, intent.intentId), completedNext,
    "A remains retryable after B is resolved");
});

test("audits exact completed terminal reconciliation and preserves proof across retries", async () => {
  const intent = {
    schemaVersion: 1, intentId: "activation-terminal-audit", serverSha: "b".repeat(40),
    candidateComponentSha: "b".repeat(40), preparedReceiptSha: "d".repeat(64),
    preSwitchEnvSha: "e".repeat(64), serverProtocol: { min: 3, max: 3 },
    hardMinimum: { ios: { version: "1.0.0", build: 8 }, android: { version: "1.0.0", build: 8 } },
    createdAt: "2026-09-26T03:47:37.6073669Z"
  };
  const originalIntentJson = JSON.stringify(intent);
  const audit = {
    schemaVersion: 1, version: "terminal-reconciliation-v1", actor: "terminal-fixture",
    toolSha256: "f".repeat(64), registrySha256: "a".repeat(64), originalIntentJson,
    originalIntentSha256: createHash("sha256").update(originalIntentJson).digest("hex"),
    normalizedIntent: intent,
    serverProof: {
      provenance: "authoritative-deployment-controller",
      receipt: {
        operation_id: intent.intentId, target_sha: intent.serverSha, result: "completed",
        active_public_sha: intent.serverSha, active_game_sha: intent.candidateComponentSha,
        mutation_evidence_complete: true, activation_started: true, activation_completed: true,
        migration_started: false, migration_completed: false, migration_outcome_uncertain: false,
        rollback_result: "not_required", prepared_remote_receipt_sha256: intent.preparedReceiptSha,
        activation_intent_id: intent.intentId, prepared_env_sha256: intent.preSwitchEnvSha
      },
      liveIdentity: { publicSha: intent.serverSha, gameSha: intent.candidateComponentSha }
    }
  };
  const active = setActivationIntent(await seed(), intent);
  const originalActive = structuredClone(active);
  const completed = resolveActivationIntent(active, intent, "2026-09-26T04:00:00Z", audit);
  assert.deepEqual(completed.resolvedIntents[0].terminalAudit, audit);
  const unaudited = resolveActivationIntent(active, intent, "2026-09-26T04:00:00Z");
  assert.throws(() => resolveActivationIntent(unaudited, intent, undefined, audit), /requires an existing immutable audit/u);
  assert.deepEqual(resolveActivationIntent(unaudited, intent), unaudited,
    "legacy non-audited retries keep their existing semantics");
  assert.deepEqual(resolveActivationIntent(completed, intent, undefined,
    { ...audit, registrySha256: "c".repeat(64) }), completed,
  "a response-loss retry retains the original registry snapshot and audit");
  const next = setActivationIntent(completed, { ...intent, intentId: "activation-after-terminal-audit" });
  assert.deepEqual(resolveActivationIntent(next, intent, undefined, audit), next,
    "a delayed retry cannot clear another active intent");
  assert.deepEqual(setActivationIntent(active, { ...intent, createdAt: "2026-09-26T03:47:37.60736690Z" }), active,
    "trailing fraction zeros do not make a different activation intent");
  for (const field of ["intentId", "serverSha", "candidateComponentSha", "preparedReceiptSha", "preSwitchEnvSha", "createdAt"]) {
    const changed = { ...intent, [field]: field === "createdAt" ? "2026-09-26T03:47:37.607Z" : "c".repeat(field.endsWith("Sha") ? (field === "preparedReceiptSha" || field === "preSwitchEnvSha" ? 64 : 40) : 10) };
    assert.throws(() => resolveActivationIntent(active, changed, undefined, audit), /audit identity/u);
  }
  for (const [field, value] of Object.entries({ operation_id: "wrong-operation", target_sha: "c".repeat(40),
    result: "running", activation_started: false, activation_completed: false, mutation_evidence_complete: false,
    migration_started: true, migration_outcome_uncertain: true, active_game_sha: "c".repeat(40),
    active_public_sha: "c".repeat(40), prepared_remote_receipt_sha256: "c".repeat(64),
    activation_intent_id: "wrong-intent", prepared_env_sha256: "c".repeat(64), status_token: "must-not-persist" })) {
    const wrongProof = structuredClone(audit);
    wrongProof.serverProof.receipt[field] = value;
    assert.throws(() => resolveActivationIntent(active, intent, undefined, wrongProof), /exact completed server proof/u);
  }
  const wrongLive = structuredClone(audit);
  wrongLive.serverProof.liveIdentity.gameSha = "c".repeat(40);
  assert.throws(() => resolveActivationIntent(active, intent, undefined, wrongLive), /exact completed server proof/u);
  const changedProof = structuredClone(audit);
  delete changedProof.serverProof.receipt.prepared_env_sha256;
  assert.throws(() => resolveActivationIntent(completed, intent, undefined, changedProof), /immutable server proof/u);
  assert.deepEqual(active, originalActive, "refused resolutions do not mutate the active registry");
});

test("migrates a legacy singleton receipt and rejects invalid duplicates", async () => {
  const intent = {
    schemaVersion: 1, intentId: "activation-legacy-receipt", serverSha: "b".repeat(40),
    candidateComponentSha: "c".repeat(40), preparedReceiptSha: "d".repeat(64),
    preSwitchEnvSha: "e".repeat(64), serverProtocol: { min: 3, max: 3 },
    hardMinimum: { ios: { version: "1.0.0", build: 0 }, android: { version: "1.0.0", build: 0 } },
    createdAt: "2026-09-21T00:00:00Z"
  };
  const receipt = { schemaVersion: 1, intent, resolvedAt: "2026-09-21T01:00:00Z" };
  const legacy = { ...(await seed()), resolvedIntent: receipt };
  const migrated = migrateLegacyResolvedIntent(legacy);
  assert.equal(legacy.resolvedIntents, undefined, "migration does not mutate the loaded snapshot");
  assert.equal(migrated.resolvedIntent, undefined);
  assert.deepEqual(migrated.resolvedIntents, [receipt]);

  assert.throws(() => migrateLegacyResolvedIntent({ ...legacy, resolvedIntent: { ...receipt, resolvedAt: "invalid" } }),
    /resolved activation intent receipt is invalid/u);
  assert.throws(() => migrateLegacyResolvedIntent({ ...legacy,
    resolvedIntents: [{ ...receipt, resolvedAt: "2026-09-21T02:00:00Z" }] }),
  /conflicts with resolved intent history/u);
  assert.throws(() => migrateLegacyResolvedIntent({ ...legacy, activationIntent: intent }),
    /an activation intent cannot also be resolved/u);
});

test("retains exact resolution receipts across more than 64 sequential activations", async () => {
  let registry = await seed();
  let firstIntent;
  for (let index = 0; index < 65; index += 1) {
    const intent = {
      schemaVersion: 1, intentId: `activation-history-${index}`,
      serverSha: index.toString(16).padStart(40, "0"),
      candidateComponentSha: (index + 1).toString(16).padStart(40, "0"),
      preparedReceiptSha: (index + 2).toString(16).padStart(64, "0"),
      preSwitchEnvSha: (index + 3).toString(16).padStart(64, "0"),
      serverProtocol: { min: 3, max: 3 },
      hardMinimum: { ios: { version: "1.0.0", build: 0 }, android: { version: "1.0.0", build: 0 } },
      createdAt: new Date(Date.UTC(2026, 8, 21, 0, 0, index)).toISOString()
    };
    if (index === 0) firstIntent = intent;
    registry = setActivationIntent(registry, intent);
    registry = resolveActivationIntent(registry, intent, new Date(Date.UTC(2026, 8, 21, 1, 0, index)).toISOString());
  }
  assert.equal(registry.resolvedIntents.length, 65);
  assert.equal(registry.resolvedIntents.at(-1).intent.intentId, "activation-history-64");
  assert.deepEqual(resolveActivationIntent(registry, firstIntent), registry,
    "the oldest exact receipt remains idempotently retryable after later activations");
});

test("activation intent binds the prepared receipt, pre-switch environment, and candidate component", () => {
  const intent = {
    schemaVersion: 1, intentId: "activation-test-identity", serverSha: "b".repeat(40),
    candidateComponentSha: "c".repeat(40), preparedReceiptSha: "d".repeat(64),
    preSwitchEnvSha: "e".repeat(64), serverProtocol: { min: 3, max: 3 },
    hardMinimum: { ios: { version: "1.0.0", build: 0 }, android: { version: "1.0.0", build: 0 } },
    createdAt: "2026-09-21T00:00:00Z"
  };
  for (const field of ["candidateComponentSha", "preparedReceiptSha", "preSwitchEnvSha"]) {
    assert.throws(() => validateActivationIntent({ ...intent, [field]: undefined }), /identity is invalid/u);
  }
  assert.equal(validateActivationIntent(intent), intent);
});

test("records pending availability identity before upload and includes unresolved attempts in the server gate", async () => {
  const reserved = reserveBuilds(await seed(), { ...request, platforms: ["ios"] });
  const release = reserved.reservations.ios;
  const artifactSha256 = "c".repeat(64);
  const availabilityPending = {
    schemaVersion: 1, reservationId: release.reservationId, releaseId: release.releaseId,
    platform: release.platform, sourceSha: release.sourceSha, marketingVersion: release.marketingVersion,
    build: release.build, protocol: release.protocol, artifactSha256,
    preparedAt: "2026-09-21T00:00:00Z"
  };
  let registry = transitionRelease(reserved.registry, release.reservationId, {
    artifactSha256, receiptUrl: "https://example.test/run", availabilityPending
  });
  assert.equal(supportedReleases(registry).some((entry) => entry.reservationId === release.reservationId), true);
  assert.throws(() => transitionRelease(registry, release.reservationId, {
    availabilityPending: { ...availabilityPending, artifactSha256: "d".repeat(64) }
  }), /immutable/u);
  registry = transitionRelease(registry, release.reservationId, { uploadAttempted: true });
  registry = transitionRelease(registry, release.reservationId, {
    uploaded: true, processed: true, internal: true, compatibilityProtected: true,
    storeBuildId: "2", availabilityPending: null
  });
  assert.equal(registry.releases.find((entry) => entry.reservationId === release.reservationId).availabilityPending, null);
});

test("tracks independent last distributed source baselines by platform", async () => {
  let registry = await seed();
  const first = reserveBuilds(registry, { ...request, releaseId: "distributed-ios", platforms: ["ios"] });
  registry = transitionRelease(first.registry, "distributed-ios:ios", {
    uploadAttempted: true, uploaded: true, processed: true, internal: true,
    compatibilityProtected: true, artifactSha256: "a".repeat(64), storeBuildId: "2",
    receiptUrl: "https://example.test/receipt"
  });
  const second = reserveBuilds(registry, { ...request, releaseId: "reserved-android", platforms: ["android"] });
  const baselines = distributedSourceByPlatform(second.registry);
  assert.equal(baselines.ios.sourceSha, request.sourceSha);
  assert.equal(baselines.ios.build, 2);
  assert.equal(baselines.android.sourceSha, "751c81e6c1be4fe8f75743ce3bc675ff4135146b");
  assert.equal(baselines.android.build, 1);
});

test("allocates platforms independently and retries idempotently", async () => {
  const first = reserveBuilds(await seed(), request);
  assert.deepEqual(first.allocations, { ios: 2, android: 2 });
  assert.equal(first.registry.releases.find((release) => release.reservationId === "t1175-run-1:ios")
    .marketingVersion,
    "1.1.0");
  assert.equal(first.registry.releases.find((release) => release.reservationId === "t1175-run-1:android")
    .marketingVersion,
    "1.2.0");
  const retry = reserveBuilds(first.registry, request);
  assert.deepEqual(retry.allocations, first.allocations);
  assert.equal(retry.registry.releases.filter((release) => release.releaseId === request.releaseId).length, 2);
  const next = reserveBuilds(retry.registry, {
    ...request,
    releaseId: "t1175-run-2",
    platforms: ["ios"]
  });
  assert.equal(next.allocations.ios, 3);
});

test("reclaims an unused final reservation but never an attempted upload", async () => {
  const first = reserveBuilds(await seed(), { ...request, platforms: ["ios"] });
  const released = releaseUnusedReservation(first.registry, "t1175-run-1:ios");
  assert.equal(released.nextBuild.ios, 2);
  const attempted = transitionRelease(first.registry, "t1175-run-1:ios", { uploadAttempted: true });
  assert.throws(() => releaseUnusedReservation(attempted, "t1175-run-1:ios"), /permanently consumed/u);
});

test("reclaims unattempted reservations without holes regardless of release order", async () => {
  const first = reserveBuilds(await seed(), { ...request, releaseId: "run-1", platforms: ["ios"] });
  const second = reserveBuilds(first.registry, { ...request, releaseId: "run-2", platforms: ["ios"] });
  const releaseLowerFirst = releaseUnusedReservation(second.registry, "run-1:ios");
  assert.equal(releaseLowerFirst.nextBuild.ios, 4);
  const releaseHigherSecond = releaseUnusedReservation(releaseLowerFirst, "run-2:ios");
  assert.equal(releaseHigherSecond.nextBuild.ios, 2);
});

test("enforces availability and download proof before support", async () => {
  const first = reserveBuilds(await seed(), { ...request, releaseMode: "open-beta", remoteMaximum: { ios: 1, android: 1 } });
  const id = "t1175-run-1:android";
  assert.throws(() => transitionRelease(first.registry, id, { supported: true }), /download-tested/u);
  let registry = transitionRelease(first.registry, id, { uploadAttempted: true });
  registry = transitionRelease(registry, id, {
    artifactSha256: "c".repeat(64),
    storeBuildId: "2",
    receiptUrl: "https://example.test/receipt",
    uploaded: true
  });
  registry = transitionRelease(registry, id, { processed: true, internal: true });
  assert.throws(() => transitionRelease(registry, id, { downloadTested: true }),
    /external availability/u);
  registry = transitionRelease(registry, id, promotionEvidence(registry.releases.find((r) => r.reservationId === id)));
  registry = transitionRelease(registry, id, { open: true, downloadTested: true, supported: true });
  assert.equal(validateRegistry(registry).releases.find((release) => release.reservationId === id)
    .supported, true);
  assert.throws(() => transitionRelease(registry, id, { supported: false }), /cannot move backward/u);
});

test("requires immutable evidence for uploaded and internal states", async () => {
  const first = reserveBuilds(await seed(), { ...request, platforms: ["ios"] });
  const id = "t1175-run-1:ios";
  const attempted = transitionRelease(first.registry, id, { uploadAttempted: true });
  assert.throws(() => transitionRelease(attempted, id, { uploaded: true }), /artifactSha256/u);
  const evidenced = transitionRelease(attempted, id, {
    artifactSha256: "d".repeat(64),
    storeBuildId: "2",
    receiptUrl: "https://example.test/receipt",
    uploaded: true
  });
  assert.throws(() => transitionRelease(evidenced, id, { artifactSha256: "e".repeat(64) }),
    /cannot change/u);
});

test("binds live server compatibility proof to the uploaded candidate and keeps it immutable", async () => {
  const first = reserveBuilds(await seed(), { ...request, platforms: ["ios"] });
  const id = "t1175-run-1:ios";
  const proof = {
    schemaVersion: 1, platform: "ios", sourceSha: "a".repeat(40), marketingVersion: "1.1.0", build: 2,
    protocol: { min: 3, max: 3 }, serverUrl: "https://playashatlas.com", serverSha: "b".repeat(40),
    serverProtocol: { min: 3, max: 3 }, hardMinimum: { version: "1.0.0", build: 1 },
    status: "supported", observedAt: "2026-09-19T00:00:00Z"
  };
  const evidenced = transitionRelease(first.registry, id, { serverCompatibility: proof });
  assert.deepEqual(evidenced.releases.find((release) => release.reservationId === id).serverCompatibility, proof);
  assert.throws(() => transitionRelease(evidenced, id, {
    serverCompatibility: { ...proof, serverSha: "c".repeat(40) }
  }), /immutable/u);
});

test("protects new compatibility records only after verified internal availability", async () => {
  const first = reserveBuilds(await seed(), { ...request, platforms: ["ios"] });
  const id = "t1175-run-1:ios";
  const attempted = transitionRelease(first.registry, id, { uploadAttempted: true });
  assert.throws(() => transitionRelease(attempted, id, { compatibilityProtected: true }),
    /verified internal availability/u);
  let registry = transitionRelease(attempted, id, {
    artifactSha256: "d".repeat(64),
    storeBuildId: "2",
    receiptUrl: "https://example.test/receipt",
    uploaded: true,
    processed: true,
    internal: true,
    compatibilityProtected: true
  });
  assert.equal(registry.releases.find((release) => release.reservationId === id)
    .compatibilityProtected, true);
});

test("rejects duplicate platform build allocations", async () => {
  const first = reserveBuilds(await seed(), { ...request, platforms: ["ios"] });
  first.registry.releases.push({ ...first.registry.releases[0], reservationId: "duplicate" });
  assert.throws(() => validateRegistry(first.registry), /allocated more than once/u);
});

test("remote retries expose state and do not require an empty commit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mobile-registry-remote-"));
  const remote = join(directory, "state.git");
  execFileSync("git", ["init", "--bare", "--quiet", remote]);
  const cli = fileURLToPath(new URL("./registry-remote.mjs", import.meta.url));
  const reserveArgs = [cli, "reserve", "--remote", remote, "--seed", seedPath,
    "--release-id", "t1175-remote", "--platforms", "ios",
    "--ios-marketing-version", "1.1.0", "--generation", "t1175",
    "--source-sha", "a".repeat(40), "--protocol-min", "3", "--protocol-max", "3",
    "--now", "2026-09-16T00:00:00.000Z"];
  try {
    const first = JSON.parse(execFileSync(process.execPath, reserveArgs, { encoding: "utf8" }));
    assert.equal(first.reservations.ios.uploadAttempted, false);
    const commitsAfterFirst = Number(execFileSync("git", ["--git-dir", remote, "rev-list", "--count",
      "refs/heads/mobile-release-state"], { encoding: "utf8" }).trim());
    const retry = JSON.parse(execFileSync(process.execPath, reserveArgs, { encoding: "utf8" }));
    assert.equal(retry.reservations.ios.build, first.reservations.ios.build);
    const commitsAfterRetry = Number(execFileSync("git", ["--git-dir", remote, "rev-list", "--count",
      "refs/heads/mobile-release-state"], { encoding: "utf8" }).trim());
    assert.equal(commitsAfterRetry, commitsAfterFirst);

    const transitionArgs = [cli, "transition", "--remote", remote, "--reservation-id",
      "t1175-remote:ios", "--patch", '{"uploadAttempted":true}'];
    execFileSync(process.execPath, transitionArgs);
    const commitsAfterTransition = Number(execFileSync("git", ["--git-dir", remote, "rev-list", "--count",
      "refs/heads/mobile-release-state"], { encoding: "utf8" }).trim());
    const transitionRetry = JSON.parse(execFileSync(process.execPath, transitionArgs, { encoding: "utf8" }));
    assert.equal(transitionRetry.reservations.ios.uploadAttempted, true);
    const commitsAfterTransitionRetry = Number(execFileSync("git", ["--git-dir", remote, "rev-list", "--count",
      "refs/heads/mobile-release-state"], { encoding: "utf8" }).trim());
    assert.equal(commitsAfterTransitionRetry, commitsAfterTransition);
    const inspected = JSON.parse(execFileSync(process.execPath, [cli, "inspect", "--remote", remote,
      "--release-id", "t1175-remote"], { encoding: "utf8" }));
    assert.equal(inspected.reservations.ios.uploadAttempted, true);
    const baselines = JSON.parse(execFileSync(process.execPath, [cli, "distributed-sources", "--remote", remote], { encoding: "utf8" }));
    assert.equal(baselines.distributedSources.ios.sourceSha, "a08fecd7f93556d60a5f71bad904ffb211914405");
    const intent = {
      schemaVersion: 1, intentId: "activation-remote-1", serverSha: "b".repeat(40),
      candidateComponentSha: "c".repeat(40), preparedReceiptSha: "d".repeat(64),
      preSwitchEnvSha: "e".repeat(64),
      serverProtocol: { min: 3, max: 3 },
      hardMinimum: { ios: { version: "1.0.0", build: 0 }, android: { version: "1.0.0", build: 0 } },
      createdAt: "2026-09-21T00:00:00Z"
    };
    execFileSync(process.execPath, [cli, "set-activation-intent", "--remote", remote, "--intent", JSON.stringify(intent)]);
    const status = JSON.parse(execFileSync(process.execPath, [cli, "activation-status", "--remote", remote], { encoding: "utf8" }));
    assert.equal(status.activationIntent.intentId, intent.intentId);
    assert.throws(() => execFileSync(process.execPath, reserveArgs), /activation intent/u);
    const resolved = JSON.parse(execFileSync(process.execPath, [cli, "resolve-activation-intent", "--remote", remote,
      "--intent-id", intent.intentId, "--now", "2026-09-21T01:00:00Z"], { encoding: "utf8" }));
    assert.equal(resolved.resolvedIntents[0].intent.intentId, intent.intentId);
    const nextIntent = { ...intent, intentId: "activation-remote-2", serverSha: "f".repeat(40),
      createdAt: "2026-09-21T02:00:00Z" };
    execFileSync(process.execPath, [cli, "set-activation-intent", "--remote", remote, "--intent", JSON.stringify(nextIntent)]);
    const activeNext = JSON.parse(execFileSync(process.execPath, [cli, "activation-status", "--remote", remote], { encoding: "utf8" }));
    assert.equal(activeNext.activationIntent.intentId, nextIntent.intentId);
    assert.equal(activeNext.resolvedIntents[0].intent.intentId, intent.intentId);
    const delayedRetry = JSON.parse(execFileSync(process.execPath, [cli, "resolve-activation-intent", "--remote", remote,
      "--intent-id", intent.intentId], { encoding: "utf8" }));
    assert.equal(delayedRetry.activationIntent.intentId, nextIntent.intentId);
    assert.deepEqual(delayedRetry.resolvedIntents, activeNext.resolvedIntents,
      "a delayed retry for A does not modify active B");
    const resolvedNext = JSON.parse(execFileSync(process.execPath, [cli, "resolve-activation-intent", "--remote", remote,
      "--intent-id", nextIntent.intentId, "--now", "2026-09-21T03:00:00Z"], { encoding: "utf8" }));
    assert.equal(resolvedNext.activationIntent, null);
    assert.deepEqual(resolvedNext.resolvedIntents.map((receipt) => receipt.intent.intentId),
      [intent.intentId, nextIntent.intentId]);
    const resolutionRetry = JSON.parse(execFileSync(process.execPath, [cli, "resolve-activation-intent", "--remote", remote,
      "--intent-id", intent.intentId], { encoding: "utf8" }));
    assert.deepEqual(resolutionRetry.resolvedIntents, resolvedNext.resolvedIntents,
      "a retry after later activation and a lost response is an idempotent no-op");
    assert.throws(() => execFileSync(process.execPath, [cli, "resolve-activation-intent", "--remote", remote,
      "--intent-id", "different-intent"], { encoding: "utf8" }), /does not match/u);
    const resumed = JSON.parse(execFileSync(process.execPath, [cli, "activation-status", "--remote", remote], { encoding: "utf8" }));
    assert.equal(resumed.activationIntent, null);
    assert.deepEqual(resumed.resolvedIntents.map((receipt) => receipt.intent.intentId),
      [intent.intentId, nextIntent.intentId]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("remote CAS exposes and upgrades a legacy singleton receipt before a delayed retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mobile-registry-legacy-"));
  const remote = join(directory, "state.git");
  const source = join(directory, "source");
  const cli = fileURLToPath(new URL("./registry-remote.mjs", import.meta.url));
  const intent = {
    schemaVersion: 1, intentId: "activation-legacy-remote", serverSha: "b".repeat(40),
    candidateComponentSha: "c".repeat(40), preparedReceiptSha: "d".repeat(64),
    preSwitchEnvSha: "e".repeat(64), serverProtocol: { min: 3, max: 3 },
    hardMinimum: { ios: { version: "1.0.0", build: 0 }, android: { version: "1.0.0", build: 0 } },
    createdAt: "2026-09-21T00:00:00Z"
  };
  const receipt = { schemaVersion: 1, intent, resolvedAt: "2026-09-21T01:00:00Z" };
  try {
    await mkdir(source, { recursive: true });
    execFileSync("git", ["init", "--bare", "--quiet", remote]);
    execFileSync("git", ["init", "--quiet", source]);
    execFileSync("git", ["-C", source, "config", "user.name", "mobile-registry-test"]);
    execFileSync("git", ["-C", source, "config", "user.email", "mobile-registry-test@example.test"]);
    const legacy = { ...(await seed()), resolvedIntent: receipt };
    await writeFile(join(source, "mobile-release-registry.json"), `${JSON.stringify(legacy, null, 2)}\n`);
    execFileSync("git", ["-C", source, "add", "mobile-release-registry.json"]);
    execFileSync("git", ["-C", source, "commit", "--quiet", "-m", "seed legacy mobile registry"]);
    execFileSync("git", ["-C", source, "remote", "add", "origin", remote]);
    execFileSync("git", ["-C", source, "push", "--quiet", "origin", "HEAD:refs/heads/mobile-release-state"]);

    const status = JSON.parse(execFileSync(process.execPath, [cli, "activation-status", "--remote", remote], { encoding: "utf8" }));
    assert.equal(status.activationIntent, null);
    assert.deepEqual(status.resolvedIntents, [receipt], "status exposes the legacy receipt without writing it");
    const commitsBeforeMutation = Number(execFileSync("git", ["--git-dir", remote, "rev-list", "--count",
      "refs/heads/mobile-release-state"], { encoding: "utf8" }).trim());
    assert.equal(commitsBeforeMutation, 1);

    const nextIntent = { ...intent, intentId: "activation-legacy-remote-next", serverSha: "f".repeat(40),
      createdAt: "2026-09-21T02:00:00Z" };
    const activated = JSON.parse(execFileSync(process.execPath, [cli, "set-activation-intent", "--remote", remote,
      "--intent", JSON.stringify(nextIntent)], { encoding: "utf8" }));
    assert.equal(activated.activationIntent.intentId, nextIntent.intentId);
    assert.deepEqual(activated.resolvedIntents, [receipt]);

    const rawAfterMutation = JSON.parse(execFileSync("git", ["--git-dir", remote, "show",
      "refs/heads/mobile-release-state:mobile-release-registry.json"], { encoding: "utf8" }));
    assert.equal(rawAfterMutation.resolvedIntent, undefined, "the next CAS removes the legacy singleton");
    assert.deepEqual(rawAfterMutation.resolvedIntents, [receipt]);
    assert.equal(rawAfterMutation.activationIntent.intentId, nextIntent.intentId);

    const delayedRetry = JSON.parse(execFileSync(process.execPath, [cli, "resolve-activation-intent", "--remote", remote,
      "--intent-id", intent.intentId], { encoding: "utf8" }));
    assert.equal(delayedRetry.activationIntent.intentId, nextIntent.intentId);
    assert.deepEqual(delayedRetry.resolvedIntents, [receipt],
      "a delayed retry for the migrated receipt leaves the later intent untouched");
    const commitsAfterRetry = Number(execFileSync("git", ["--git-dir", remote, "rev-list", "--count",
      "refs/heads/mobile-release-state"], { encoding: "utf8" }).trim());
    assert.equal(commitsAfterRetry, commitsBeforeMutation + 1,
      "the delayed retry does not create another CAS commit");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("legacy retirement is audited, reversible and idempotent without changing store history", async () => {
  const original = await seed();
  const request = { reservationId: original.releases[0].reservationId, action: "retire",
    actionId: "retire-legacy-ios-1", actor: "operator@example.test", note: RETIREMENT_NOTE,
    recordedAt: "2026-09-25T12:00:00Z" };
  const retired = changeReleaseRetirement(original, request);
  assert.deepEqual(retired.releases, original.releases);
  assert.deepEqual(retired.nextBuild, original.nextBuild);
  assert.deepEqual(retired.buildFloor, original.buildFloor);
  assert.equal(retired.retirementAudit.length, 1);
  assert.equal(retired.retirementAudit[0].identity.sourceSha, original.releases[0].sourceSha);
  assert.equal(retirementState(retired).has(request.reservationId), true);
  assert.equal(supportedReleases(retired).length, 1);
  assert.deepEqual(changeReleaseRetirement(retired, request), retired);
  assert.deepEqual(changeReleaseRetirement(retired, { ...request, recordedAt: undefined }), retired);
  assert.throws(() => changeReleaseRetirement(retired, { ...request, actor: "someone-else" }), /different evidence/u);
  const restored = changeReleaseRetirement(retired, { ...request, action: "unretire", actionId: "restore-ios-1",
    note: "restore compatibility protection", recordedAt: "2026-09-25T12:01:00Z" });
  assert.equal(supportedReleases(restored).length, 2);
  assert.deepEqual(restored.retirementAudit[0], retired.retirementAudit[0]);
  assert.deepEqual(restored.releases, original.releases);
  assert.throws(() => transitionRelease(retired, request.reservationId, { compatibilityProtected: false }), /backward/u);
  assert.throws(() => releaseUnusedReservation(retired, request.reservationId), /permanently consumed/u);
  for (const malformed of [null, {}, [{ ...retired.retirementAudit[0], note: "wrong" }],
    [retired.retirementAudit[0], retired.retirementAudit[0]],
    [{ ...retired.retirementAudit[0], identity: { ...retired.retirementAudit[0].identity, sourceSha: "b".repeat(40) } }]]) {
    assert.throws(() => validateRegistry({ ...original, retirementAudit: malformed }), /retirement audit/u);
  }
  const frozen = { ...original, activationIntent: { schemaVersion: 1, intentId: "activation-retirement",
    serverSha: "b".repeat(40), candidateComponentSha: "c".repeat(40), preparedReceiptSha: "d".repeat(64),
    preSwitchEnvSha: "e".repeat(64), serverProtocol: { min: 3, max: 3 },
    hardMinimum: { ios: { version: "1.0.0", build: 0 }, android: { version: "1.0.0", build: 0 } },
    createdAt: request.recordedAt } };
  assert.throws(() => changeReleaseRetirement(frozen, request), /frozen/u);
  assert.throws(() => changeReleaseRetirement({ ...original, production: { operations: [{ status: "pending" }] } }, request), /production operation/u);
  const reserved = reserveBuilds(original, { ...{ releaseId: "retirement-pending-fence", marketingVersions: { ios: "1.1.0" }, generation: "t1281", sourceSha: "a".repeat(40), protocolMin: 3, protocolMax: 3, now: request.recordedAt }, platforms: ["ios"] });
  const release = reserved.reservations.ios;
  const pending = transitionRelease(reserved.registry, release.reservationId, {
    artifactSha256: "f".repeat(64), availabilityPending: { schemaVersion: 1,
      reservationId: release.reservationId, releaseId: release.releaseId, platform: release.platform,
      sourceSha: release.sourceSha, marketingVersion: release.marketingVersion, build: release.build,
      protocol: release.protocol, artifactSha256: "f".repeat(64), preparedAt: request.recordedAt }
  });
  assert.throws(() => changeReleaseRetirement(pending, request), /pending mobile availability/u);
  assert.throws(() => changeReleaseRetirement(retired, { ...request, actionId: "wrong-retire-note", note: "wrong" }), /evidence/u);
});

test("retirement is limited to the enumerated legacy builds and remote CLI preserves retries", async () => {
  for (const [platform, allowed] of Object.entries({ ios: [1,2,3,5,6,7], android: [1,2,3,4,6,7] })) {
    for (const build of [1,2,3,4,5,6,7,8,9]) {
      const registry = await seed();
      const release = registry.releases.find((r) => r.platform === platform);
      release.build = build; release.compatibilityProtected = build === 1;
      registry.nextBuild[platform] = build + 1;
      const request = { reservationId: release.reservationId, action: "retire", actionId: `retire-${platform}-${build}`,
        actor: "operator", note: RETIREMENT_NOTE };
      if (allowed.includes(build)) assert.equal(retirementState(changeReleaseRetirement(registry, request)).size, 1);
      else assert.throws(() => changeReleaseRetirement(registry, request), /allowlist/u);
    }
  }
  const directory = await mkdtemp(join(tmpdir(), "retirement-cli-"));
  try {
    const path = join(directory, "registry.json");
    const registry = await seed(); await writeFile(path, JSON.stringify(registry));
    const cli = fileURLToPath(new URL("./registry-remote.mjs", import.meta.url));
    const args = [cli, "retire", "--file", path, "--reservation-id", registry.releases[0].reservationId,
      "--action-id", "cli-retire-ios-1", "--actor", "operator", "--note", RETIREMENT_NOTE];
    execFileSync(process.execPath, args);
    const first = await readFile(path, "utf8"); execFileSync(process.execPath, args);
    assert.equal(await readFile(path, "utf8"), first);
    const selected = JSON.parse(execFileSync(process.execPath, [cli, "compatibility-releases", "--file", path]));
    assert.equal(selected.compatibilityReleases.length, 1);
    args[1] = "unretire"; args[args.indexOf("--action-id") + 1] = "cli-unretire-ios-1";
    args[args.indexOf("--note") + 1] = "restore legacy support"; execFileSync(process.execPath, args);
    assert.equal(supportedReleases(JSON.parse(await readFile(path, "utf8"))).length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
