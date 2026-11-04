import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  buildCoordinatedChildReceipt,
  coordinatedCandidateIdentity,
  coordinatedChildOperationId,
  COORDINATED_RELEASE_PHASES,
  validateCoordinatedServerEvidence,
  verifyAuthenticatedCoordinatedServerEvidence
} from "./coordinated-receipts.mjs";
import { createProductionClients, productionAppleSnapshot, productionGoogleSnapshot } from "./production-store-api.mjs";
import { productionCandidateFingerprint } from "./production-registry.mjs";

const ACTIONS = new Set(["inspect", "resume"]);
const PLATFORMS = ["ios", "android"];

export async function runCoordinatedMobile({
  action = "resume",
  coordinatedOperationId = process.env.COORDINATED_OPERATION_ID,
  platforms = platformList(),
  now = new Date().toISOString(),
  execute = true
} = {}) {
  requireState(ACTIONS.has(action), "coordinated mobile action must be inspect or resume");
  requireState(typeof coordinatedOperationId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(coordinatedOperationId),
    "COORDINATED_OPERATION_ID is required and must be exact");
  requireState(platforms.length === 2 && PLATFORMS.every((platform) => platforms.includes(platform)),
    "coordinated mobile release requires both ios and android children");

  importAuthenticatedServerEvidenceFromEnvironment(coordinatedOperationId);
  let snapshots = await readSnapshots(platforms);
  let state = readProductionState();
  let serverEvidence = coordinatedServerEvidenceForState(state, coordinatedOperationId);
  if (action === "resume") {
    requireState(serverEvidence,
      "coordinated mobile resume requires authenticated server coordinator evidence");
    assertCoordinatorCandidates(serverEvidence, coordinatedOperationId, platforms);
  }
  let phase = serverEvidence?.phase ?? "manifest_created";
  const actions = [];
  if (action === "resume") {
    requireState(process.env.DRY_RUN === "false" || execute === false,
      "coordinated mobile resume requires DRY_RUN=false");
    for (const platform of platforms) {
      const childId = coordinatedChildOperationId(coordinatedOperationId, platform);
      const expected = coordinatorCandidate(serverEvidence, platform);
      let candidate = candidateForOperation(state, platform, childId);
      if (!candidate) {
        actions.push({ platform, action: "prepare", operationId: childId });
        if (execute) {
          await runProductionCli("prepare", platform, {
            PRODUCTION_CANDIDATE_ID: childId,
            RELEASE_ID: expected.release_id,
            SOURCE_SHA: expected.source_sha,
            GENERATION: expected.generation,
            PRODUCTION_MASTER_SHA: serverEvidence.accepted_master_sha,
            [`${platform.toUpperCase()}_PRODUCTION_METADATA_SHA256`]: expected.metadata_sha256,
            [`${platform.toUpperCase()}_PRODUCTION_COUNTRIES`]: expected.countries.join(","),
            [`${platform.toUpperCase()}_PRODUCTION_ROLLOUT`]: JSON.stringify(expected.rollout),
            ...(platform === "android" ? {
              GOOGLE_PLAY_MANAGED_PUBLISHING: String(expected.managed_publishing ?? false),
              GOOGLE_PLAY_FIRST_PUBLICATION_BOOTSTRAP: String(expected.first_publication_bootstrap_verified ?? false)
            } : {})
          });
          state = readProductionState();
          candidate = candidateForOperation(state, platform, childId);
        }
      }
      if (!candidate) continue;
      assertCoordinatorCandidate(candidate, expected, childId, platform);
      const active = unresolvedOperation(state.production?.[platform]?.operations, candidate);
      if (active) {
        actions.push({ platform, action: "reconcile", operationId: active.operationId });
        if (execute) {
          await runProductionCli("reconcile", platform, {
            PRODUCTION_OPERATION_ID: active.operationId,
            RELEASE_ID: expected.release_id,
            SOURCE_SHA: expected.source_sha,
            GENERATION: expected.generation,
            PRODUCTION_MASTER_SHA: serverEvidence.accepted_master_sha,
            [`${platform.toUpperCase()}_PRODUCTION_METADATA_SHA256`]: expected.metadata_sha256,
            [`${platform.toUpperCase()}_PRODUCTION_COUNTRIES`]: expected.countries.join(","),
            [`${platform.toUpperCase()}_PRODUCTION_ROLLOUT`]: JSON.stringify(expected.rollout)
          });
          state = readProductionState();
        }
      }
      const receipt = buildReceiptFromState(coordinatedOperationId, platform, state, snapshots[platform], now);
      if (!receipt.submitted) {
        actions.push({ platform, action: "submit", operationId: `${childId}:submit` });
        if (execute) {
          try {
            await runProductionCli("submit", platform, {
              PRODUCTION_OPERATION_ID: `${childId}:submit`,
              RELEASE_ID: expected.release_id,
              SOURCE_SHA: expected.source_sha,
              GENERATION: expected.generation,
              PRODUCTION_MASTER_SHA: serverEvidence.accepted_master_sha,
              [`${platform.toUpperCase()}_PRODUCTION_METADATA_SHA256`]: expected.metadata_sha256,
              [`${platform.toUpperCase()}_PRODUCTION_COUNTRIES`]: expected.countries.join(","),
              [`${platform.toUpperCase()}_PRODUCTION_ROLLOUT`]: JSON.stringify(expected.rollout)
            });
          } catch (error) {
            actions.push({ platform, action: "submit_pending", error: error.message });
          }
          state = readProductionState();
        }
      }
    }
    state = readProductionState();
    serverEvidence = coordinatedServerEvidenceForState(state, coordinatedOperationId);
    phase = serverEvidence?.phase ?? "manifest_created";
    if (serverEvidence?.healthy === true && phaseIndex(phase) >= phaseIndex("server_healthy")) {
      for (const platform of platforms) {
        const childId = coordinatedChildOperationId(coordinatedOperationId, platform);
        const expected = coordinatorCandidate(serverEvidence, platform);
        const candidate = candidateForOperation(state, platform, childId);
        if (!candidate) continue;
        assertCoordinatorCandidate(candidate, expected, childId, platform);
        const receipt = buildReceiptFromState(coordinatedOperationId, platform, state, snapshots[platform], now);
        if (!receipt.release_requested) {
          const operationId = `${childId}:release`;
          actions.push({ platform, action: "release", operationId });
          if (execute) {
            try {
              await runProductionCli("release", platform, {
                PRODUCTION_OPERATION_ID: operationId,
                RELEASE_ID: expected.release_id,
                SOURCE_SHA: expected.source_sha,
                GENERATION: expected.generation,
                PRODUCTION_MASTER_SHA: serverEvidence.accepted_master_sha,
                [`${platform.toUpperCase()}_PRODUCTION_METADATA_SHA256`]: expected.metadata_sha256,
                [`${platform.toUpperCase()}_PRODUCTION_COUNTRIES`]: expected.countries.join(","),
                [`${platform.toUpperCase()}_PRODUCTION_ROLLOUT`]: JSON.stringify(expected.rollout),
                PRODUCTION_RELEASE_APPROVED: "true",
                PRODUCTION_RELEASE_APPROVAL_SHA256: productionCandidateFingerprint(candidate)
              });
            } catch (error) {
              actions.push({ platform, action: "release_pending", error: error.message });
            }
            state = readProductionState();
          }
        }
      }
    }
  }

  state = readProductionState();
  snapshots = await readSnapshots(platforms);
  serverEvidence = coordinatedServerEvidenceForState(state, coordinatedOperationId);
  phase = serverEvidence?.phase ?? "manifest_created";
  const receipts = [];
  for (const platform of platforms) {
    const childId = coordinatedChildOperationId(coordinatedOperationId, platform);
    const candidate = candidateForOperation(state, platform, childId);
    if (!candidate) continue;
    if (serverEvidence) {
      assertCoordinatorCandidate(candidate, coordinatorCandidate(serverEvidence, platform), childId, platform);
    }
    const receipt = buildReceiptFromState(coordinatedOperationId, platform, state, snapshots[platform], now);
    receipts.push(receipt);
    if (action === "resume" && execute && process.env.ASH_ATLAS_PRODUCTION_MUTATION === "true") {
      persistReceipt(receipt);
    }
  }
  const gate = coordinatedGate(receipts, { serverEvidence });
  const platformsEvidence = Object.fromEntries(receipts.map((receipt) => [receipt.platform, receipt]));
  const result = { schemaVersion: 1, kind: "ash-atlas-coordinated-mobile-result",
    coordinated_operation_id: coordinatedOperationId, phase, next_phase: gate.nextPhase,
    gate, actions, receipts, platforms: platformsEvidence,
    ios: platformsEvidence.ios ?? null, android: platformsEvidence.android ?? null,
    observed_at_utc: now };
  writeReceiptFile(result);
  return result;
}

export function coordinatedGate(receipts, { serverEvidence = null } = {}) {
  if (serverEvidence) validateCoordinatedServerEvidence(serverEvidence);
  const serverPublished = serverEvidence?.published === true;
  const serverActivated = serverEvidence?.activated === true;
  const serverHealthy = serverEvidence?.healthy === true;
  const byPlatform = new Map(receipts.map((receipt) => [receipt.platform, receipt]));
  const dailyTesters = receipts.some((receipt) => receipt?.candidate?.tester_destination !== undefined);
  const submitted = PLATFORMS.every((platform) => byPlatform.get(platform)?.submitted === true);
  const ready = PLATFORMS.every((platform) => {
    const receipt = byPlatform.get(platform);
    if (!receipt) return false;
    if (dailyTesters) return receipt.tester_prepared === true || receipt.tester_available === true;
    if (receipt.public_available === true) return true;
    if (platform === "ios") return receipt.store_status === "PENDING_DEVELOPER_RELEASE";
    return receipt.store_status === "RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED" &&
      receipt.managed_publishing === true;
  });
  const releaseRequested = dailyTesters
    ? PLATFORMS.every((platform) => byPlatform.get(platform)?.tester_available === true)
    : PLATFORMS.every((platform) => byPlatform.get(platform)?.release_requested === true);
  const publicAvailable = PLATFORMS.every((platform) => byPlatform.get(platform)?.public_available === true);
  const nextPhase = !submitted ? "apps_submitted" : !ready ? "apps_ready" :
    !serverPublished ? "server_published" : !serverActivated ? "server_activated" :
      !serverHealthy ? "server_healthy" : !releaseRequested ? "apps_release_requested" :
        dailyTesters || publicAvailable ? "completed" : "apps_release_requested";
  return { submitted, ready, serverPublished, serverActivated, serverHealthy,
    releaseRequested, publicAvailable, allowedServerPublication: submitted && ready, nextPhase };
}

async function readSnapshots(platforms) {
  if (process.env.COORDINATED_FIXTURE_SNAPSHOTS) {
    return JSON.parse(readFileSync(resolve(process.env.COORDINATED_FIXTURE_SNAPSHOTS), "utf8"));
  }
  const clients = await createProductionClients({ mutable: false, platforms });
  return Object.fromEntries(await Promise.all(platforms.map(async (platform) => [platform,
    platform === "ios" ? await productionAppleSnapshot(clients.apple) : await productionGoogleSnapshot(clients.google)])));
}

function readProductionState() {
  const result = registryCommand("production-status");
  return { production: result.production?.platforms ?? result.production ?? null, registry: result.registry ?? null,
    coordinatedMobileReceipts: result.coordinatedMobileReceipts ?? [],
    coordinatedServerEvidence: result.coordinatedServerEvidence ?? [] };
}

function importAuthenticatedServerEvidenceFromEnvironment(coordinatedOperationId) {
  const encoded = process.env.COORDINATED_SERVER_EVIDENCE_B64;
  if (!encoded) return;
  requireState(/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded) && encoded.length % 4 === 0,
    "coordinated server evidence transport is not valid base64");
  const bytes = Buffer.from(encoded, "base64");
  const expectedSha = process.env.COORDINATED_SERVER_EVIDENCE_SHA256;
  requireState(/^[0-9a-f]{64}$/u.test(String(expectedSha ?? "")),
    "coordinated server evidence transport hash is required");
  requireState(createHash("sha256").update(bytes).digest("hex") === expectedSha,
    "coordinated server evidence transport hash does not match");
  let evidence;
  try { evidence = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("coordinated server evidence transport is not UTF-8 JSON"); }
  requireState(evidence.coordinated_operation_id === coordinatedOperationId,
    "coordinated server evidence transport operation does not match");
  verifyAuthenticatedCoordinatedServerEvidence(
    evidence,
    process.env.COORDINATED_SERVER_EVIDENCE_HMAC_KEY,
    process.env.COORDINATED_SERVER_EVIDENCE_HMAC_KEY_ID || "coordinated-server-evidence-v1"
  );
  const directory = mkdtempSync(join(process.env.ASH_ATLAS_JOB_TEMP ?? tmpdir(), "ash-atlas-server-evidence-"));
  const path = join(directory, "evidence.json");
  try {
    writeFileSync(path, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
    registryCommand("coordinated-server-evidence", ["--evidence-file", path]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function coordinatedServerEvidenceForState(state, coordinatedOperationId) {
  const entries = (state.coordinatedServerEvidence ?? [])
    .filter((entry) => entry.coordinated_operation_id === coordinatedOperationId)
    .sort((left, right) => Date.parse(right.observed_at_utc) - Date.parse(left.observed_at_utc));
  if (entries.length === 0) return null;
  const evidence = validateCoordinatedServerEvidence(entries[0]);
  verifyAuthenticatedCoordinatedServerEvidence(
    evidence,
    process.env.COORDINATED_SERVER_EVIDENCE_HMAC_KEY,
    process.env.COORDINATED_SERVER_EVIDENCE_HMAC_KEY_ID || "coordinated-server-evidence-v1"
  );
  return evidence;
}

function assertCoordinatorCandidates(evidence, coordinatedOperationId, platforms) {
  const candidates = evidence.candidates ?? evidence.apps;
  requireState(candidates && typeof candidates === "object",
    "coordinated server evidence must carry exact mobile candidate identities");
  for (const platform of platforms) {
    const expected = coordinatorCandidate(evidence, platform);
    requireState(expected.source_sha === evidence.source_sha && expected.generation === evidence.generation,
      `${platform} candidate is not bound to the authenticated server candidate`);
    requireState(expected.release_id.length > 0 &&
      expected.child_operation_id === coordinatedChildOperationId(coordinatedOperationId, platform),
      `${platform} candidate is not bound to the coordinated operation`);
  }
}

function coordinatorCandidate(evidence, platform) {
  const candidates = evidence.candidates ?? evidence.apps;
  const entry = candidates?.[platform];
  requireState(entry && typeof entry === "object",
    `coordinated server evidence is missing ${platform} candidate identity`);
  const raw = entry.candidate ?? entry;
  const identity = coordinatedCandidateIdentity(raw);
  return {
    ...identity,
    child_operation_id: String(entry.child_operation_id ?? entry.childOperationId ??
      raw.operation_id ?? raw.operationId ?? ""),
    managed_publishing: platform === "android" ? entry.managed_publishing ?? entry.managedPublishing ??
      raw.managed_publishing ?? raw.managedPublishing ?? null : null,
    first_publication_bootstrap_verified: platform === "android" ? entry.first_publication_bootstrap_verified ??
      entry.firstPublicationBootstrapVerified ?? raw.first_publication_bootstrap_verified ??
      raw.firstPublicationBootstrapVerified ?? false : false
  };
}

function candidateForOperation(state, platform, childId) {
  const candidate = state.production?.[platform]?.candidate ?? null;
  if (candidate) {
    requireState(candidate.operationId === childId,
      `${platform} prepared candidate belongs to a different coordinated operation`);
  }
  return candidate;
}

function assertCoordinatorCandidate(candidate, expected, childId, platform) {
  requireState(candidate.operationId === childId && expected.child_operation_id === childId,
    `${platform} candidate operation identity does not match the coordinator`);
  const actualIdentity = coordinatedCandidateIdentity(candidate);
  requireState(stableJson(actualIdentity) === stableJson(expectedWithoutBinding(expected)),
    `${platform} prepared candidate does not match the authenticated coordinator candidate`);
  if (expected.managed_publishing !== null) {
    requireState(candidate.managedPublishing === expected.managed_publishing,
      `${platform} managed-publishing binding does not match the coordinator`);
  }
  requireState(candidate.firstPublicationBootstrapVerified === expected.first_publication_bootstrap_verified,
    `${platform} first-publication bootstrap binding does not match the coordinator`);
}

function expectedWithoutBinding(expected) {
  const identity = { ...expected };
  delete identity.child_operation_id;
  delete identity.managed_publishing;
  delete identity.first_publication_bootstrap_verified;
  return identity;
}

function buildReceiptFromState(coordinatedOperationId, platform, state, snapshot, now) {
  const candidate = state.production?.[platform]?.candidate;
  requireState(candidate, `${platform} has no coordinated production candidate`);
  const operations = state.production?.[platform]?.operations ?? [];
  return buildCoordinatedChildReceipt({ coordinatedOperationId, candidate, production: { operations }, snapshot, now });
}

function unresolvedOperation(operations = [], candidate) {
  return operations.filter((operation) => operation.candidate?.operationId === candidate.operationId &&
    ["pending", "uncertain"].includes(operation.status))
    .sort((left, right) => Date.parse(right.updatedAt ?? 0) - Date.parse(left.updatedAt ?? 0))[0] ?? null;
}

async function runProductionCli(action, platform, overrides) {
  const env = { ...process.env, ...overrides, PLATFORM_LIST: platform, DRY_RUN: "false" };
  const output = execFileSync(process.execPath, ["tools/mobile-release/production.mjs", action], {
    cwd: process.cwd(), env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
  });
  return JSON.parse(output);
}

function persistReceipt(receipt) {
  const directory = mkdtempSync(join(process.env.ASH_ATLAS_JOB_TEMP ?? tmpdir(), "ash-atlas-coordinated-receipt-"));
  const path = join(directory, "receipt.json");
  try {
    writeFileSync(path, `${JSON.stringify(receipt)}\n`);
    registryCommand("coordinated-mobile-receipt", ["--receipt-file", path]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function writeReceiptFile(result) {
  const path = process.env.COORDINATED_MOBILE_RECEIPT_PATH;
  if (path) {
    mkdirSync(dirname(resolve(path)), { recursive: true });
    writeFileSync(resolve(path), `${JSON.stringify(result, null, 2)}\n`);
  }
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT,
      `coordinated_next_phase=${result.next_phase}\ncoordinated_receipt_sha256=${receiptHash(result)}\n`, { flag: "a" });
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function registryCommand(command, args = []) {
  const commandArgs = ["tools/mobile-release/registry-remote.mjs", command, ...args];
  if (process.env.PRODUCTION_REGISTRY_FILE) commandArgs.push("--file", process.env.PRODUCTION_REGISTRY_FILE);
  return JSON.parse(execFileSync(process.execPath, commandArgs, {
    cwd: process.cwd(), env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
  }));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function platformList() {
  const value = String(process.env.PLATFORM_LIST ?? "ios,android").split(",").filter(Boolean);
  requireState(value.length === 2 && PLATFORMS.every((platform) => value.includes(platform)),
    "PLATFORM_LIST must contain ios,android for a coordinated release");
  return value;
}

function phaseIndex(phase) {
  return COORDINATED_RELEASE_PHASES.indexOf(phase);
}

function receiptHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requireState(condition, message) {
  if (!condition) throw new Error(message);
}

if (process.argv[1] && process.argv[1].endsWith("coordinated-mobile.mjs")) {
  const action = process.argv[2] ?? "resume";
  runCoordinatedMobile({ action }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
