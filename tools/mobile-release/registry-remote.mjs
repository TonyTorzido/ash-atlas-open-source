import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  releaseUnusedReservation,
  reserveBuilds,
  transitionRelease,
  validateRegistry,
  distributedSourceByPlatform,
  setActivationIntent,
  resolveActivationIntent,
  migrateLegacyResolvedIntent,
  changeReleaseRetirement,
  supportedReleases
} from "./registry.mjs";
import {
  beginProductionOperation,
  cancelProductionCandidate,
  finishProductionOperation,
  markProductionUncertain,
  recordProductionSubstep,
  prepareProductionCandidate,
  productionOperationBlocksActivation,
  productionStatus,
  reconcileProductionOperation
} from "./production-registry.mjs";
import {
  buildCoordinatedServerEvidence,
  coordinatedReceiptFor,
  coordinatedServerEvidenceFor,
  recordCoordinatedServerEvidence,
  recordCoordinatedMobileReceipt,
  validateCoordinatedChildReceipt,
  validateCoordinatedServerEvidence
} from "./coordinated-receipts.mjs";

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
if (!command || !["retire", "unretire", "compatibility-releases", "validate", "inspect", "distributed-sources", "activation-status", "reserve", "transition", "release-unused",
  "set-activation-intent", "resolve-activation-intent", "production-status", "production-prepare", "production-begin", "production-substep",
  "production-uncertain", "production-finish", "production-reconcile", "production-cancel", "coordinated-mobile-receipt",
  "coordinated-server-evidence"].includes(command)) {
  throw new Error("usage: registry-remote.mjs <retire|unretire|compatibility-releases|validate|inspect|distributed-sources|activation-status|reserve|transition|release-unused|set-activation-intent|resolve-activation-intent|production-status|production-prepare|production-begin|production-substep|production-uncertain|production-finish|production-reconcile|production-cancel|coordinated-mobile-receipt|coordinated-server-evidence> [options]");
}

if (args.file) {
  const path = resolve(String(args.file));
  const rawRegistry = JSON.parse(readFileSync(path, "utf8"));
  const registry = migrateLegacyResolvedIntent(rawRegistry);
  const result = apply(command, registry, args);
  if (!['compatibility-releases', 'validate', 'inspect', 'distributed-sources', 'activation-status', 'production-status'].includes(command) && changed(rawRegistry, result.registry)) {
    writeFileSync(path, `${JSON.stringify(result.registry, null, 2)}\n`);
  }
  emit(result);
} else {
  updateRemote(command, args);
}

function updateRemote(operation, options) {
  const remote = String(options.remote ?? "origin");
  const branch = String(options.branch ?? "mobile-release-state");
  const seed = resolve(String(options.seed ?? "config/mobile-release-registry.seed.json"));
  const directory = mkdtempSync(join(process.env.ASH_ATLAS_JOB_TEMP || tmpdir(), "ash-atlas-mobile-registry-"));
  try {
    git(directory, ["init", "--quiet"]);
    git(directory, ["config", "user.name", "ash-atlas-release-bot"]);
    git(directory, ["config", "user.email", "release-bot@playashatlas.com"]);
    git(directory, ["remote", "add", "origin", remoteUrl(remote)]);
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      let exists = true;
      try {
        git(directory, ["fetch", "--quiet", "origin", `refs/heads/${branch}:refs/remotes/origin/${branch}`]);
      } catch {
        // Only a proven absent ref may initialize state. Auth/network errors fail closed.
        const advertised = git(directory, ["ls-remote", "--heads", "origin", `refs/heads/${branch}`]).trim();
        if (advertised) throw new Error("Registry fetch failed for an existing state branch");
        exists = false;
      }
      if (exists) git(directory, ["checkout", "--quiet", "--detach", `refs/remotes/origin/${branch}`]);
      else {
        git(directory, ["checkout", "--quiet", "--orphan", "registry-state"]);
        writeFileSync(join(directory, "mobile-release-registry.json"), readFileSync(seed));
        git(directory, ["add", "mobile-release-registry.json"]);
        git(directory, ["commit", "--quiet", "-m", "chore(mobile): initialize release registry"]);
      }
      const path = join(directory, "mobile-release-registry.json");
      const rawRegistry = JSON.parse(readFileSync(path, "utf8"));
      const registry = migrateLegacyResolvedIntent(rawRegistry);
      const result = apply(operation, registry, options);
      if (["compatibility-releases", "validate", "inspect", "distributed-sources", "activation-status", "production-status"].includes(operation)) return emit(result);
      const stateChanged = changed(rawRegistry, result.registry);
      if (exists && !stateChanged) return emit(result);
      if (stateChanged) {
        writeFileSync(path, `${JSON.stringify(result.registry, null, 2)}\n`);
        git(directory, ["add", "mobile-release-registry.json"]);
        git(directory, ["commit", "--quiet", "-m", commitMessage(operation, options)]);
      }
      try {
        git(directory, ["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`]);
        return emit(result);
      } catch (error) {
        if (attempt === 8) throw error;
        git(directory, ["reset", "--hard", "--quiet"]);
        git(directory, ["update-ref", "-d", `refs/remotes/origin/${branch}`]);
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function apply(operation, registry, options) {
  validateRegistry(registry);
  if (registry.production !== undefined) productionStatus(registry);
  if (operation === "compatibility-releases") return { registry, compatibilityReleases: supportedReleases(registry) };
  if (["retire", "unretire"].includes(operation)) {
    return { registry: changeReleaseRetirement(registry, {
      reservationId: required(options, "reservation-id"), action: operation,
      actionId: required(options, "action-id"), actor: required(options, "actor"),
      note: required(options, "note"), recordedAt: options.now === undefined ? undefined : String(options.now)
    }) };
  }
  if (operation === "validate") return { registry: validateRegistry(registry) };
  if (operation === "inspect") {
    validateRegistry(registry);
    const releaseId = required(options, "release-id");
    const reservations = Object.fromEntries(registry.releases
      .filter((release) => release.releaseId === releaseId)
      .map((release) => [release.platform, release]));
    if (Object.keys(reservations).length === 0) throw new Error(`unknown release: ${releaseId}`);
    if (options.generation) {
      for (const platform of required(options, "platforms").split(",")) {
        const r = reservations[platform];
        if (!r || r.generation !== options.generation || r.sourceSha !== options["source-sha"] ||
          r.marketingVersion !== options[`${platform}-marketing-version`] ||
          (r.releaseMode ?? "internal") !== options["release-mode"]) throw new Error("Reconciliation identity mismatch");
      }
    }
    return { registry, reservations };
  }
  if (operation === "distributed-sources") {
    return { registry: validateRegistry(registry), distributedSources: distributedSourceByPlatform(registry) };
  }
  if (operation === "activation-status") {
    return {
      registry: validateRegistry(registry),
      activationIntent: registry.activationIntent ?? null,
      resolvedIntents: registry.resolvedIntents ?? []
    };
  }
  if (operation === "production-status") {
    const platform = options.platform === undefined ? undefined : String(options.platform);
    return { registry: validateRegistry(registry), production: productionStatus(registry, platform) };
  }
  if (operation === "coordinated-mobile-receipt") {
    const receipt = readObjectOption(options, "receipt");
    validateCoordinatedChildReceipt(receipt);
    const next = recordCoordinatedMobileReceipt(registry, receipt);
    return { registry: next,
      receipt: coordinatedReceiptFor(next, receipt.coordinated_operation_id, receipt.platform) };
  }
  if (operation === "coordinated-server-evidence") {
    const supplied = readObjectOption(options, "evidence");
    const evidence = supplied.receipt_sha256 === undefined
      ? buildCoordinatedServerEvidence(supplied) : supplied;
    validateCoordinatedServerEvidence(evidence);
    const next = recordCoordinatedServerEvidence(registry, evidence);
    return { registry: next,
      evidence: coordinatedServerEvidenceFor(next, evidence.coordinated_operation_id) };
  }
  if (operation === "reserve") {
    return reserveBuilds(registry, {
      releaseId: required(options, "release-id"),
      platforms: required(options, "platforms").split(","),
      marketingVersions: {
        ios: options["ios-marketing-version"] === undefined
          ? undefined
          : String(options["ios-marketing-version"]),
        android: options["android-marketing-version"] === undefined
          ? undefined
          : String(options["android-marketing-version"])
      },
      generation: required(options, "generation"),
      sourceSha: required(options, "source-sha"),
      protocolMin: Number(required(options, "protocol-min")),
      protocolMax: Number(required(options, "protocol-max")),
      releaseMode: String(options["release-mode"] ?? "internal"),
      remoteMaximum: options["remote-snapshot"] ? remoteMaximum(options["remote-snapshot"], options["release-mode"], required(options, "platforms").split(",")) : undefined,
      now: options.now ? String(options.now) : new Date().toISOString()
    });
  }
  if (operation === "set-activation-intent") {
    const production = registry.production === undefined ? null : productionStatus(registry);
    if (production?.operations.some((entry) => productionOperationBlocksActivation(entry))) {
      throw new Error("cannot acquire activation intent while a production mutation is unresolved");
    }
    const intent = JSON.parse(options["intent-file"]
      ? readFileSync(resolve(String(options["intent-file"])), "utf8")
      : required(options, "intent"));
    return { registry: setActivationIntent(registry, intent) };
  }
  if (operation === "resolve-activation-intent") {
    const expected = options["intent-file"]
      ? JSON.parse(readFileSync(resolve(String(options["intent-file"])), "utf8"))
      : required(options, "intent-id");
    const terminalAudit = options["terminal-audit-file"] === undefined && options["terminal-audit"] === undefined
      ? undefined : readObjectOption(options, "terminal-audit");
    return { registry: resolveActivationIntent(registry, expected, options.now ? String(options.now) : undefined, terminalAudit) };
  }
  if (operation === "production-prepare") {
    const request = readObjectOption(options, "request");
    const releaseId = String(request.releaseId ?? required(options, "release-id"));
    const release = registry.releases.find((entry) => entry.releaseId === releaseId && entry.platform === request.platform);
    if (!release) throw new Error(`unknown ${request.platform} release: ${releaseId}`);
    return { registry: prepareProductionCandidate(registry, { ...request, release }) };
  }
  if (operation === "production-cancel") {
    const request = readObjectOption(options, "request");
    return { registry: cancelProductionCandidate(registry, request) };
  }
  if (operation === "production-begin") {
    const request = readObjectOption(options, "request");
    if (registry.activationIntent !== undefined) {
      throw new Error(`production mutation is blocked by activation intent ${registry.activationIntent.intentId}`);
    }
    const state = productionStatus(registry, request.platform);
    return { registry: beginProductionOperation(registry, { ...request, candidate: request.candidate ?? state.candidate }) };
  }
  if (operation === "production-substep") {
    const step = readObjectOption(options, "step");
    return { registry: recordProductionSubstep(registry, required(options, "operation-id"), step,
      options.now ? String(options.now) : new Date().toISOString()) };
  }
  if (operation === "production-uncertain") {
    const receipt = options["receipt-file"] !== undefined || options.receipt !== undefined
      ? readObjectOption(options, "receipt") : null;
    return { registry: markProductionUncertain(registry, required(options, "operation-id"), {
      receipt, updatedAt: options.now ? String(options.now) : undefined
    }) };
  }
  if (operation === "production-finish") {
    const receipt = readObjectOption(options, "receipt");
    const remote = options["remote-file"] !== undefined || options.remote !== undefined
      ? readObjectOption(options, "remote") : undefined;
    return { registry: finishProductionOperation(registry, required(options, "operation-id"), {
      status: String(required(options, "status")), receipt, remote,
      updatedAt: options.now ? String(options.now) : new Date().toISOString()
    }) };
  }
  if (operation === "production-reconcile") {
    const observed = readObjectOption(options, "observed");
    const receipt = options["receipt-file"] !== undefined || options.receipt !== undefined
      ? readObjectOption(options, "receipt") : undefined;
    return { registry: reconcileProductionOperation(registry, required(options, "operation-id"), {
      observed, receipt, reconciledAt: options.now ? String(options.now) : new Date().toISOString()
    }) };
  }
  const reservationId = required(options, "reservation-id");
  if (operation === "release-unused") {
    return { registry: releaseUnusedReservation(registry, reservationId) };
  }
  if (options["patch-file"] && options.patch) throw new Error("Use only one of --patch or --patch-file");
  const patch = JSON.parse(options["patch-file"] ? readFileSync(resolve(String(options["patch-file"])), "utf8") : required(options, "patch"));
  const transitioned = transitionRelease(registry, reservationId, patch);
  const release = transitioned.releases.find((entry) => entry.reservationId === reservationId);
  return { registry: transitioned, reservations: { [release.platform]: release } };
}

function remoteMaximum(path, mode, platforms) {
  const snapshot = JSON.parse(readFileSync(String(path), "utf8"));
  if ((platforms.includes("android") && snapshot.google?.packageName !== "com.ashatlas.game") ||
      (platforms.includes("ios") && snapshot.apple?.bundleId !== "com.ashatlas.game") ||
      !Number.isFinite(Date.parse(snapshot.observedAt)) || Date.now() - Date.parse(snapshot.observedAt) > 30 * 60_000 ||
      Date.parse(snapshot.observedAt) > Date.now() + 60_000) throw new Error("Missing, stale, or wrong-app remote snapshot");
  if (mode === "open-beta" && (!snapshot.apple.metadataReady || !snapshot.apple.externalGroup)) {
    throw new Error("Existing external group/public link or required Apple beta metadata needs operator action before uploading");
  }
  return { ios: snapshot.apple?.maximum, android: snapshot.google?.maximum };
}

function emit(result) {
  const serialized = `${JSON.stringify(result.registry, null, 2)}\n`;
  const output = {
    allocations: result.allocations ?? {},
    compatibilityReleases: result.compatibilityReleases ?? [],
    retirementAudit: result.registry.retirementAudit ?? [],
    reservations: result.reservations ?? {},
    distributedSources: result.distributedSources ?? {},
    activationIntent: result.activationIntent ?? result.registry.activationIntent ?? null,
    resolvedIntents: result.resolvedIntents ?? result.registry.resolvedIntents ?? [],
    production: result.production ?? result.registry.production ?? null,
    coordinatedMobileReceipts: result.coordinatedMobileReceipts ?? result.registry.coordinatedMobileReceipts ?? [],
    coordinatedServerEvidence: result.coordinatedServerEvidence ?? result.registry.coordinatedServerEvidence ?? [],
    registrySha256: createHash("sha256").update(serialized).digest("hex")
  };
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    const lines = Object.entries(output.allocations).map(([platform, build]) => `${platform}_build=${build}`);
    for (const [platform, reservation] of Object.entries(output.reservations)) {
      lines.push(`${platform}_build=${reservation.build}`);
      lines.push(`${platform}_upload_attempted=${reservation.uploadAttempted}`);
      lines.push(`${platform}_uploaded=${reservation.uploaded}`);
      lines.push(`${platform}_processed=${reservation.processed}`);
      lines.push(`${platform}_internal=${reservation.internal}`);
    }
    for (const [platform, baseline] of Object.entries(output.distributedSources)) {
      lines.push(`${platform}_source_sha=${baseline.sourceSha}`);
      lines.push(`${platform}_distributed_release_id=${baseline.releaseId}`);
      lines.push(`${platform}_distributed_build=${baseline.build}`);
    }
    lines.push(`activation_intent_id=${output.activationIntent?.intentId ?? ""}`);
    lines.push(`resolved_intent_ids=${output.resolvedIntents.map((receipt) => receipt.intent.intentId).join(",")}`);
    lines.push(`registry_sha256=${output.registrySha256}`);
    writeFileSync(githubOutput, `${lines.join("\n")}\n`, { flag: "a" });
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

function readObjectOption(options, name) {
  const file = options[`${name}-file`];
  const inline = options[name];
  if (file !== undefined && inline !== undefined) throw new Error(`Use only one of --${name} or --${name}-file`);
  if (file !== undefined) return JSON.parse(readFileSync(resolve(String(file)), "utf8"));
  if (inline !== undefined) return JSON.parse(String(inline));
  if (name === "request" || name === "receipt" || name === "observed") return {};
  throw new Error(`--${name} or --${name}-file is required`);
}

function changed(before, after) {
  return JSON.stringify(before) !== JSON.stringify(after);
}

function remoteUrl(remote) {
  if (remote.includes(":") || remote.startsWith("/") || remote.startsWith(".")) return remote;
  if (process.env.ASH_ATLAS_REGISTRY_TOKEN) {
    const repository = remote.includes("/") ? remote : process.env.GITHUB_REPOSITORY;
    if (repository) return `https://github.com/${repository}.git`;
  }
  return execFileSync("git", ["remote", "get-url", remote], { encoding: "utf8" }).trim();
}

function git(cwd, arguments_) {
  const env = { ...process.env };
  const token = process.env.ASH_ATLAS_REGISTRY_TOKEN;
  if (token && process.env.GITHUB_REPOSITORY) {
    // Keep the scoped token out of the remote URL and git config. Git receives
    // it only as a process-scoped HTTP header for this invocation.
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
    const authorization = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${authorization}`;
  }
  return execFileSync("git", arguments_, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function commitMessage(operation, options) {
  const id = options["reservation-id"] ?? options["release-id"] ?? "registry";
  return `chore(mobile): ${operation} ${id}`;
}

function required(options, name) {
  const value = options[name];
  if (value === undefined || value === true || String(value).length === 0) {
    throw new Error(`--${name} is required`);
  }
  return String(value);
}

function parseArgs(values) {
  const parsed = { _: [] };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      parsed._.push(value);
      continue;
    }
    const name = value.slice(2);
    const next = values[index + 1];
    parsed[name] = next && !next.startsWith("--") ? values[++index] : true;
  }
  return parsed;
}
