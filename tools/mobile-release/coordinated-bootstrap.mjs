import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";

import {
  coordinatedCandidateIdentity,
  coordinatedChildOperationId,
  validateCoordinatedChildReceipt
} from "./coordinated-receipts.mjs";
import { DAILY_TESTER_MODE } from "./coordinated-mobile-testers.mjs";

const SHA = /^[0-9a-f]{40}$/u;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const GENERATION = /^t\d{3,4}$/u;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const PLATFORMS = ["ios", "android"];

/**
 * Materialize the exact seed consumed by the Windows server coordinator.
 *
 * The Mac provider owns build/upload/store work.  It returns a normal
 * ash-atlas-coordinated-mobile-result object; this module only validates that
 * result against the server controller's immutable tuple and writes the two
 * handoff files.  It never calls a store or registry API.
 */
export function buildCoordinatedReleaseSeed({
  operationId,
  generation,
  serverSha,
  acceptedMasterSha,
  currentServerSha,
  result,
  now = new Date().toISOString()
}) {
  assertOperationTuple({ operationId, generation, serverSha, acceptedMasterSha, currentServerSha });
  assertTimestamp(now, "bootstrap timestamp");
  assertResult(result, operationId);

  const receipts = extractReceipts(result);
  const apps = {};
  const dailyFlags = receipts.map((receipt) => receipt.candidate?.tester_destination !== undefined);
  requireState(new Set(dailyFlags).size === 1,
    "coordinated bootstrap cannot mix tester and production candidates");
  const dailyTesters = dailyFlags[0] === true;
  for (const platform of PLATFORMS) {
    const receipt = receipts.find((entry) => entry.platform === platform);
    requireState(receipt, `coordinated bootstrap result is missing ${platform}`);
    const identity = coordinatedCandidateIdentity(receipt.candidate);
    requireState(identity.source_sha === serverSha,
      `${platform} candidate source SHA does not match the pinned server SHA`);
    requireState(identity.generation === generation,
      `${platform} candidate generation does not match the pinned generation`);
    requireState(receipt.operation_id === coordinatedChildOperationId(operationId, platform),
      `${platform} child operation ID does not match the pinned operation`);
    apps[platform] = appSeedEntry(receipt);
  }

  const seed = {
    schema_version: 1,
    kind: "ash-atlas-coordinated-release-seed",
    operation_id: operationId,
    source: "mobile-bootstrap",
    created_at_utc: now,
    pinned: {
      generation,
      generation_tag: `test/${generation}`,
      server_sha: serverSha,
      accepted_integration_sha: serverSha,
      accepted_master_sha: acceptedMasterSha,
      current_server_sha: currentServerSha
    },
    ...(dailyTesters ? { delivery_mode: DAILY_TESTER_MODE } : {}),
    apps
  };
  return { seed, receipt: normalizeResult(result, operationId, now) };
}

export function buildActionRequiredResult({
  operationId,
  generation,
  serverSha,
  acceptedMasterSha,
  currentServerSha,
  reason,
  now = new Date().toISOString()
}) {
  assertOperationTuple({ operationId, generation, serverSha, acceptedMasterSha, currentServerSha });
  assertTimestamp(now, "bootstrap timestamp");
  requireState(typeof reason === "string" && reason.trim().length > 0 && reason.length <= 1000,
    "ACTION_REQUIRED reason is invalid");
  return {
    schemaVersion: 1,
    kind: "ash-atlas-coordinated-mobile-bootstrap-result",
    status: "ACTION_REQUIRED",
    coordinated_operation_id: operationId,
    requested: {
      generation,
      server_sha: serverSha,
      accepted_master_sha: acceptedMasterSha,
      current_server_sha: currentServerSha
    },
    reason: reason.trim(),
    observed_at_utc: now
  };
}

export function writeCoordinatedBootstrapArtifacts({
  seedPath,
  receiptPath,
  seed,
  receipt
}) {
  requireState(typeof seedPath === "string" && seedPath.length > 0,
    "coordinated seed path is required");
  requireState(typeof receiptPath === "string" && receiptPath.length > 0,
    "coordinated receipt path is required");
  writeJsonAtomic(seedPath, seed);
  writeJsonAtomic(receiptPath, receipt);
}

export function writeActionRequiredArtifact(path, result) {
  requireState(typeof path === "string" && path.length > 0, "ACTION_REQUIRED path is required");
  requireState(result?.status === "ACTION_REQUIRED", "ACTION_REQUIRED result is invalid");
  writeJsonAtomic(path, result);
}

export function readBootstrapResult(path) {
  const absolute = resolve(path);
  let size;
  try {
    size = statSync(absolute).size;
  } catch (error) {
    throw new Error(`coordinated bootstrap result is unavailable: ${error.message}`);
  }
  requireState(size > 0 && size <= MAX_RESULT_BYTES,
    "coordinated bootstrap result size is outside the safe bound");
  try {
    return JSON.parse(readFileSync(absolute, "utf8"));
  } catch (error) {
    throw new Error(`coordinated bootstrap result is not valid UTF-8 JSON: ${error.message}`);
  }
}

export function extractReceipts(result) {
  const supplied = Array.isArray(result.receipts)
    ? result.receipts
    : result.platforms && typeof result.platforms === "object"
      ? Object.values(result.platforms)
      : [result.ios, result.android].filter(Boolean);
  requireState(supplied.length === 2, "coordinated bootstrap result must contain exactly two child receipts");
  const receipts = supplied.map((receipt) => {
    validateCoordinatedChildReceipt(receipt);
    return receipt;
  });
  requireState(new Set(receipts.map((receipt) => receipt.platform)).size === 2 &&
    PLATFORMS.every((platform) => receipts.some((receipt) => receipt.platform === platform)),
  "coordinated bootstrap result must contain one iOS and one Android child");
  return receipts;
}

function assertResult(result, operationId) {
  requireState(result && result.schemaVersion === 1 &&
    result.kind === "ash-atlas-coordinated-mobile-result",
  "coordinated bootstrap provider result schema is invalid");
  requireState(result.coordinated_operation_id === operationId,
    "coordinated bootstrap provider result operation ID does not match the request");
  requireState(result.status !== "ACTION_REQUIRED" && result.action_required === undefined,
    result.reason || "coordinated bootstrap provider requires operator action before server publication");
}

function normalizeResult(result, operationId, now) {
  const receipts = extractReceipts(result);
  return {
    ...structuredClone(result),
    schemaVersion: 1,
    kind: "ash-atlas-coordinated-mobile-result",
    coordinated_operation_id: operationId,
    receipts,
    platforms: Object.fromEntries(receipts.map((receipt) => [receipt.platform, receipt])),
    ios: receipts.find((receipt) => receipt.platform === "ios"),
    android: receipts.find((receipt) => receipt.platform === "android"),
    observed_at_utc: result.observed_at_utc ?? now
  };
}

function appSeedEntry(receipt) {
  const approval = {
    ...structuredClone(receipt.approval),
    candidate_fingerprint: receipt.approval.fingerprint
  };
  return {
    platform: receipt.platform,
    candidate: structuredClone(receipt.candidate),
    child_operation_id: receipt.operation_id,
    submitted: receipt.submitted,
    ready: isReady(receipt),
    approval,
    store_status: receipt.store_status,
    managed_publishing: receipt.managed_publishing,
    first_publication_bootstrap_verified: receipt.first_publication_bootstrap_verified,
    release_requested: receipt.release_requested,
    public_available: receipt.public_available,
    public_status: receipt.public_status,
    first_publish: receipt.first_publish,
    last_evidence_fingerprint: receipt.receipt_sha256,
    last_observed_at_utc: receipt.observed_at_utc
  };
}

function isReady(receipt) {
  if (receipt.candidate?.tester_destination !== undefined) {
    return (receipt.tester_prepared === true || receipt.tester_available === true) &&
      receipt.public_available === false;
  }
  return receipt.platform === "ios"
    ? receipt.store_status === "PENDING_DEVELOPER_RELEASE" && receipt.public_available === false
    : receipt.store_status === "RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED" &&
      receipt.managed_publishing === true && receipt.public_available === false;
}

function assertOperationTuple({ operationId, generation, serverSha, acceptedMasterSha, currentServerSha }) {
  requireState(typeof operationId === "string" && OPERATION_ID.test(operationId),
    "coordinated operation ID is invalid");
  requireState(typeof generation === "string" && GENERATION.test(generation),
    "coordinated generation is invalid");
  for (const [name, value] of [["server SHA", serverSha], ["accepted master SHA", acceptedMasterSha],
    ["current server SHA", currentServerSha]]) {
    requireState(typeof value === "string" && SHA.test(value), `${name} is invalid`);
  }
}

function assertTimestamp(value, label) {
  requireState(typeof value === "string" && Number.isFinite(Date.parse(value)), `${label} is invalid`);
}

function writeJsonAtomic(path, value) {
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.${Date.now()}.tmp`;
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  try {
    writeFileSync(temporary, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporary, absolute);
  } finally {
    try { unlinkSync(temporary); } catch { /* already renamed */ }
  }
}

function requireState(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    requireState(value.startsWith("--"), `unexpected argument: ${value}`);
    const name = value.slice(2);
    const next = values[index + 1];
    requireState(next !== undefined && !next.startsWith("--"), `--${name} requires a value`);
    parsed[name] = next;
    index += 1;
  }
  return parsed;
}

function required(args, name) {
  requireState(typeof args[name] === "string" && args[name].length > 0, `--${name} is required`);
  return args[name];
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const operationId = required(args, "operation-id");
  const generation = required(args, "generation");
  const serverSha = required(args, "server-sha");
  const acceptedMasterSha = required(args, "accepted-master-sha");
  const currentServerSha = required(args, "current-server-sha");
  const now = args.now ?? new Date().toISOString();
  if (args["action-required"]) {
    const result = buildActionRequiredResult({ operationId, generation, serverSha, acceptedMasterSha,
      currentServerSha, reason: required(args, "reason"), now });
    writeActionRequiredArtifact(args["action-required"], result);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const result = readBootstrapResult(required(args, "result-file"));
  const artifacts = buildCoordinatedReleaseSeed({ operationId, generation, serverSha,
    acceptedMasterSha, currentServerSha, result, now });
  writeCoordinatedBootstrapArtifacts({ seedPath: required(args, "seed-path"),
    receiptPath: required(args, "receipt-path"), seed: artifacts.seed, receipt: artifacts.receipt });
  process.stdout.write(`${JSON.stringify({
    operation_id: operationId,
    seed_sha256: sha256(artifacts.seed),
    receipt_sha256: sha256(artifacts.receipt)
  })}\n`);
}

if (process.argv[1]?.endsWith("coordinated-bootstrap.mjs")) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
