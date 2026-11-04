import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SHA = /^[0-9a-f]{40}$/u;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

export async function verifyLiveServerCompatibility({
  serverUrl = process.env.MOBILE_COMPATIBILITY_SERVER_URL ?? "https://playashatlas.com",
  platform,
  version,
  build,
  sourceSha,
  protocolMin,
  protocolMax,
  requireServerSha = true,
  expectedReleaseSha,
  fetcher = fetch
}) {
  validateCandidate({ platform, version, build, sourceSha, protocolMin, protocolMax });
  const base = new URL(serverUrl);
  if (base.protocol !== "https:") throw new Error("live compatibility server URL must use HTTPS");
  base.pathname = `${base.pathname.replace(/\/$/u, "")}/api/auth/native/compatibility`;
  base.search = new URLSearchParams({
    platform,
    version,
    build: String(build),
    wsMin: String(protocolMin),
    wsMax: String(protocolMax)
  }).toString();
  let response;
  try {
    response = await fetcher(base, { headers: { accept: "application/json" }, redirect: "error" });
  } catch (error) {
    throw new Error(`live server compatibility request failed: ${error.message}`);
  }
  if (!response?.ok) throw new Error(`live server compatibility request failed: HTTP ${response?.status ?? "unknown"}`);
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("live server compatibility response is not JSON");
  }
  validateResponse(body, { platform, version, build, protocolMin, protocolMax, requireServerSha });
  let serverReleaseSha;
  if (expectedReleaseSha && body.serverSha !== expectedReleaseSha) {
    const releaseResponse = await fetcher(new URL("/play/release.json", base),
      { headers: { accept: "application/json" }, redirect: "error" });
    if (!releaseResponse.ok) throw new Error("live release component identity is unavailable");
    const release = await releaseResponse.json();
    if (release.game_sha !== expectedReleaseSha || release.release_class !== "client_only" ||
        release.server_component_sha !== body.serverSha) {
      throw new Error("live release does not bind the expected release to the running server component");
    }
    serverReleaseSha = release.game_sha;
  }
  return {
    schemaVersion: 1,
    platform,
    sourceSha,
    marketingVersion: version,
    build,
    protocol: { min: protocolMin, max: protocolMax },
    serverUrl: base.origin,
    serverSha: body.serverSha,
    ...(serverReleaseSha ? { serverReleaseSha } : {}),
    serverProtocol: { min: body.wsMin, max: body.wsMax },
    hardMinimum: body.hardMinimum,
    status: body.status,
    observedAt: new Date().toISOString()
  };
}

export function validateResponse(body, candidate) {
  if (!body || typeof body !== "object" || Array.isArray(body) || body.contractVersion !== 1) {
    throw new Error("live server compatibility response contract is invalid");
  }
  if (body.platform !== candidate.platform || body.version !== candidate.version ||
      Number(body.build) !== candidate.build) {
    throw new Error("live server compatibility response candidate identity mismatch");
  }
  if (!Number.isInteger(body.wsMin) || !Number.isInteger(body.wsMax) ||
      body.wsMin <= 0 || body.wsMin > body.wsMax) {
    throw new Error("live server compatibility protocol range is invalid");
  }
  if (!body.hardMinimum || !VERSION.test(body.hardMinimum.version) ||
      !Number.isInteger(body.hardMinimum.build) || body.hardMinimum.build < 0) {
    throw new Error("live server compatibility hard minimum is invalid");
  }
  if (!["supported", "recommended", "required"].includes(body.status)) {
    throw new Error("live server compatibility status is invalid");
  }
  if (candidate.protocolMax < body.wsMin || candidate.protocolMin > body.wsMax) {
    throw new Error("candidate protocol is incompatible with the live server");
  }
  if (compareRelease(candidate.version, candidate.build,
    body.hardMinimum.version, body.hardMinimum.build) < 0) {
    throw new Error("candidate is below the live server hard minimum");
  }
  if (body.status === "required") throw new Error("live server requires a newer mobile candidate");
  if (candidate.requireServerSha !== false && !SHA.test(body.serverSha ?? "")) {
    throw new Error("live server compatibility response has no immutable server SHA");
  }
  return body;
}

function validateCandidate({ platform, version, build, sourceSha, protocolMin, protocolMax }) {
  if (!["ios", "android"].includes(platform)) throw new Error("candidate platform is invalid");
  if (!VERSION.test(version)) throw new Error("candidate marketing version is invalid");
  if (!Number.isInteger(Number(build)) || Number(build) <= 0) throw new Error("candidate build is invalid");
  if (!SHA.test(sourceSha)) throw new Error("candidate source SHA is invalid");
  if (!Number.isInteger(Number(protocolMin)) || !Number.isInteger(Number(protocolMax)) ||
      Number(protocolMin) <= 0 || Number(protocolMin) > Number(protocolMax)) {
    throw new Error("candidate protocol range is invalid");
  }
}

function compareRelease(leftVersion, leftBuild, rightVersion, rightBuild) {
  const left = leftVersion.split(/[.-]/u).slice(0, 3).map(Number);
  const right = rightVersion.split(/[.-]/u).slice(0, 3).map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return leftBuild - rightBuild;
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const next = values[index + 1];
    result[value.slice(2)] = next && !next.startsWith("--") ? values[++index] : true;
  }
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = parseArgs(process.argv.slice(2));
  verifyLiveServerCompatibility({
    serverUrl: required(args, "server-url"),
    platform: required(args, "platform"),
    version: required(args, "version"),
    build: Number(required(args, "build")),
    sourceSha: required(args, "source-sha"),
    protocolMin: Number(required(args, "protocol-min")),
    protocolMax: Number(required(args, "protocol-max")),
    requireServerSha: args["require-server-sha"] !== "false"
  }).then((proof) => {
    if (args.output) writeFileSync(String(args.output), `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
    if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT,
      `server_sha=${proof.serverSha}\ncompatibility_status=${proof.status}\n`, { flag: "a" });
    process.stdout.write(`${JSON.stringify(proof)}\n`);
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

function required(options, name) {
  const value = options[name];
  if (value === undefined || value === true || String(value).length === 0) throw new Error(`--${name} is required`);
  return String(value);
}
